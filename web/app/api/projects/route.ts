import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db'
import { DEFAULT_PROJECT_MCP_CONFIG, projects, type ProjectMcpConfig } from '@/db/schema'
import { isNull, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { registerProjectPath } from '@/lib/project-registry'
import { resolveGitHubToken } from '@/lib/github'
import { getCachedProjectMcpSummaries } from '@/lib/mcps/manager'
import { collapseHomePath, getWorkspaceSettings, isWithinPath } from '@/lib/workspace'

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

function folderNameFromProjectName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'forge-project'
}

async function ensureLocalProjectDirectory(localPath: string): Promise<void> {
  try {
    const stat = await fs.stat(localPath)
    if (!stat.isDirectory()) {
      throw new Error('localPath exists but is not a directory')
    }
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await fs.mkdir(localPath, { recursive: true })
}

async function writeProjectConfig(project: {
  id: string
  name: string
  githubRepo: string | null
  localPath: string | null
  mcpConfig?: ProjectMcpConfig | null
  defaultBranch: string
  createdAt: Date
  updatedAt: Date
}): Promise<void> {
  if (!project.localPath) return

  const configPath = path.join(/*turbopackIgnore: true*/ project.localPath, 'forge.project.json')
  const payload = {
    projectId: project.id,
    name: project.name,
    githubRepo: project.githubRepo,
    defaultBranch: project.defaultBranch,
    localPath: collapseHomePath(project.localPath),
    mcpProfile: project.mcpConfig?.profile ?? DEFAULT_PROJECT_MCP_CONFIG.profile,
    requiredMcps: project.mcpConfig?.requiredMcps ?? DEFAULT_PROJECT_MCP_CONFIG.requiredMcps,
    mcpOverrides: project.mcpConfig?.overrides ?? DEFAULT_PROJECT_MCP_CONFIG.overrides,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  }
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
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

    const summaries = await getCachedProjectMcpSummaries(rows.map((project) => project.id))
    const projectsWithMcp = rows.map((project) => ({
      ...project,
      mcpSummary: summaries.get(project.id) ?? null,
    }))

    return NextResponse.json({ projects: projectsWithMcp })
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
    const workspace = await getWorkspaceSettings()
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

      const resolvedLocalPath = path.isAbsolute(data.localPath)
        ? path.resolve(/*turbopackIgnore: true*/ data.localPath)
        : path.resolve(/*turbopackIgnore: true*/ workspace.projectsRoot, data.localPath)
      if (!isWithinPath(workspace.workspaceRoot, resolvedLocalPath)) {
        return NextResponse.json(
          { error: 'localPath must be inside the active workspace root' },
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
      await writeProjectConfig(project)

      console.info('[POST /api/projects] Cloned project', { id: project.id, name: project.name })
      return NextResponse.json({ project }, { status: 201 })
    }

    const localPathInput =
      source === 'local' ? data.localPath ?? folderNameFromProjectName(data.name) : null
    if (localPathInput?.includes('\0')) {
      return NextResponse.json({ error: 'Invalid local path' }, { status: 400 })
    }
    const resolvedLocalPath =
      localPathInput !== null
        ? path.isAbsolute(localPathInput)
          ? path.resolve(/*turbopackIgnore: true*/ localPathInput)
          : path.resolve(/*turbopackIgnore: true*/ workspace.projectsRoot, localPathInput)
        : null

    if (resolvedLocalPath) {
      if (!isWithinPath(workspace.workspaceRoot, resolvedLocalPath)) {
        return NextResponse.json(
          { error: 'localPath must be inside the active workspace root' },
          { status: 400 },
        )
      }
      await ensureLocalProjectDirectory(resolvedLocalPath)
    }

    const [project] = await db
      .insert(projects)
      .values({
        name: data.name,
        githubRepo: source === 'github' ? data.githubRepo ?? null : null,
        localPath: resolvedLocalPath,
        githubTokenEnvVar: data.githubTokenEnvVar ?? null,
        pmProviderConfigId: data.pmProviderConfigId ?? null,
        defaultBranch: data.defaultBranch ?? 'main',
      })
      .returning()

    if (project.localPath) {
      await registerProjectPath(project.localPath)
      await writeProjectConfig(project)
    }

    console.info('[POST /api/projects] Created project', { id: project.id, name: project.name })
    return NextResponse.json({ project }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/projects] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
