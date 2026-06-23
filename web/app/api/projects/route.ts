import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { isNull, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { registerProjectPath } from '@/lib/project-registry'
import { resolveGitHubToken } from '@/lib/github'

const execFile = promisify(execFileCallback)

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  source: z.enum(['github', 'local', 'clone']).optional(),
  githubRepo: z.string().trim().min(1).max(200).optional(),
  localPath: z.string().trim().min(1).max(1000).optional(),
  githubTokenEnvVar: z.string().optional(),
  pmProviderConfigId: z.string().uuid().optional(),
  defaultBranch: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Clone helpers
// ---------------------------------------------------------------------------

// Strict 'owner/repo' shape — validated BEFORE the value touches any URL or
// process argument, since this is the one user-controlled string that ends
// up in a command invocation.
export const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// Matches the embedded-credential portion of an authenticated clone URL
// (`https://x-access-token:<token>@github.com/...`) so it can be redacted
// from any error text before it reaches a log line or HTTP response. git's
// own stderr can otherwise echo the URL — including the token — verbatim.
const CREDENTIAL_URL_RE = /x-access-token:[^@]*@/g

export function redactToken(message: string): string {
  return message.replace(CREDENTIAL_URL_RE, 'x-access-token:***@')
}

async function pathExistsNonEmpty(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath)
    if (!stat.isDirectory()) return true // a file is there — treat as occupied
    const entries = await fs.readdir(targetPath)
    return entries.length > 0
  } catch {
    return false
  }
}

function defaultWorkspaceRoot(): string | null {
  const root = process.env.FORGE_WORKSPACE_ROOT?.trim()
  return root ? path.resolve(/*turbopackIgnore: true*/ root) : null
}

/** Mirrors the filesystem route's boundary check: only enforced when FORGE_WORKSPACE_ROOT is set. */
function isWithinWorkspaceRoot(resolvedPath: string): boolean {
  const root = defaultWorkspaceRoot()
  if (!root) return true
  const relative = path.relative(root, resolvedPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rows = await db
      .select()
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(desc(projects.createdAt))

    return NextResponse.json({ projects: rows })
  } catch (err) {
    console.error('[GET /api/projects] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST /api/projects
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createProjectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data
    const source = data.source ?? (data.githubRepo ? 'github' : 'local')
    if (source === 'github' && !data.githubRepo) {
      return NextResponse.json(
        { error: 'GitHub repo is required for GitHub projects' },
        { status: 400 },
      )
    }

    if (source === 'clone') {
      if (!data.githubRepo || !data.localPath) {
        return NextResponse.json(
          { error: 'Both githubRepo and localPath are required to clone a project' },
          { status: 400 },
        )
      }

      if (!OWNER_REPO_RE.test(data.githubRepo)) {
        return NextResponse.json(
          { error: 'githubRepo must look like "owner/repo"' },
          { status: 400 },
        )
      }

      // Validate localPath before it touches fs or git: no traversal segments,
      // no null bytes.
      if (data.localPath.includes('\0')) {
        return NextResponse.json({ error: 'Invalid local path' }, { status: 400 })
      }

      const resolvedLocalPath = path.resolve(/*turbopackIgnore: true*/ data.localPath)
      if (!isWithinWorkspaceRoot(resolvedLocalPath)) {
        return NextResponse.json(
          { error: 'localPath must be inside the configured workspace root' },
          { status: 400 },
        )
      }

      if (await pathExistsNonEmpty(resolvedLocalPath)) {
        return NextResponse.json(
          { error: 'Destination folder already exists and is not empty' },
          { status: 409 },
        )
      }

      const resolvedToken = await resolveGitHubToken()
      const cloneUrl = resolvedToken
        ? `https://x-access-token:${resolvedToken.token}@github.com/${data.githubRepo}.git`
        : `https://github.com/${data.githubRepo}.git`

      try {
        await execFile('git', ['clone', '--depth', '1', cloneUrl, resolvedLocalPath], {
          timeout: 60_000,
        })
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : 'git clone failed'
        const sanitized = redactToken(rawMessage)
        console.error('[POST /api/projects] git clone failed', sanitized)
        return NextResponse.json({ error: sanitized }, { status: 400 })
      }

      const [project] = await db
        .insert(projects)
        .values({
          name: data.name,
          githubRepo: data.githubRepo,
          localPath: resolvedLocalPath,
          githubTokenEnvVar: data.githubTokenEnvVar ?? null,
          pmProviderConfigId: data.pmProviderConfigId ?? null,
          defaultBranch: data.defaultBranch ?? 'main',
        })
        .returning()

      await registerProjectPath(project.localPath)

      console.info('[POST /api/projects] Cloned project', { id: project.id, name: project.name })
      return NextResponse.json({ project }, { status: 201 })
    }

    const [project] = await db
      .insert(projects)
      .values({
        name: data.name,
        githubRepo: source === 'github' ? data.githubRepo ?? null : null,
        localPath: source === 'local' ? data.localPath ?? null : null,
        githubTokenEnvVar: data.githubTokenEnvVar ?? null,
        pmProviderConfigId: data.pmProviderConfigId ?? null,
        defaultBranch: data.defaultBranch ?? 'main',
      })
      .returning()

    if (project.localPath) {
      await registerProjectPath(project.localPath)
    }

    console.info('[POST /api/projects] Created project', { id: project.id, name: project.name })
    return NextResponse.json({ project }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/projects] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
