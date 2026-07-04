import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db'
import { DEFAULT_PROJECT_MCP_CONFIG, projects, type ProjectMcpConfig } from '@/db/schema'
import { and, isNull, desc } from 'drizzle-orm'
import { accessibleProjectOwnerCondition } from '@/lib/project-access'
import { getSession } from '@/lib/session'
import { registerProjectPath } from '@/lib/project-registry'
import { resolveGitHubToken, validateGitHubTokenEnvVar } from '@/lib/github'
import { getCachedProjectMcpSummaries } from '@/lib/mcps/manager'
import { buildCloneUrl, OWNER_REPO_RE, redactToken } from '@/lib/projects/clone'
import {
  assertProjectLocalPathAllowed,
  assertProjectLocalPathPreflightAllowed,
  assertProjectPathNotProtected,
} from '@/lib/projects/local-path'
import {
  collapseHomePath,
  displayPathForWorkspacePath,
  getWorkspaceSettings,
  isWithinPath,
  resolveWorkspaceInputPath,
  type WorkspaceSettings,
} from '@/lib/workspace'

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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return false
  }
}

async function withGitAskPassEnv<T>(
  token: string | null | undefined,
  callback: (options: { env?: NodeJS.ProcessEnv }) => Promise<T>,
): Promise<T> {
  if (!token) return callback({})

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-git-askpass-'))
  const askPassPath = path.join(tmpDir, 'askpass.js')
  await fs.writeFile(
    askPassPath,
    [
      '#!/usr/bin/env node',
      'const prompt = process.argv[2] || "";',
      'if (/username/i.test(prompt)) process.stdout.write("x-access-token\\n");',
      `else if (/password/i.test(prompt)) process.stdout.write(${JSON.stringify(`${token}\n`)});`,
      'else process.stdout.write("\\n");',
    ].join('\n'),
    { mode: 0o700 },
  )

  try {
    return await callback({
      env: {
        ...process.env,
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
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

async function assertRealPathWithinWorkspace(
  candidatePath: string,
  workspace: WorkspaceSettings,
): Promise<void> {
  const [realWorkspaceRoot, realCandidate] = await Promise.all([
    fs.realpath(workspace.workspaceRoot),
    fs.realpath(candidatePath),
  ])

  if (!isWithinPath(realWorkspaceRoot, realCandidate)) {
    throw new Error('localPath must be inside the active workspace root')
  }
}

async function assertNearestExistingAncestorWithinWorkspace(
  candidatePath: string,
  workspace: WorkspaceSettings,
): Promise<void> {
  let currentPath = path.resolve(/*turbopackIgnore: true*/ candidatePath)
  const workspaceRoot = path.resolve(/*turbopackIgnore: true*/ workspace.workspaceRoot)

  while (isWithinPath(workspaceRoot, currentPath)) {
    try {
      await assertRealPathWithinWorkspace(currentPath, workspace)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parentPath = path.dirname(currentPath)
      if (parentPath === currentPath) break
      currentPath = parentPath
    }
  }

  throw new Error('localPath must be inside the active workspace root')
}

async function prepareLocalProjectDirectory(
  localPath: string,
  workspace: WorkspaceSettings,
): Promise<void> {
  try {
    const stat = await fs.stat(localPath)
    if (!stat.isDirectory()) {
      throw new Error('localPath exists but is not a directory')
    }
    await assertRealPathWithinWorkspace(localPath, workspace)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await assertNearestExistingAncestorWithinWorkspace(localPath, workspace)
  await fs.mkdir(localPath, { recursive: true })
  await assertRealPathWithinWorkspace(localPath, workspace)
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
  await assertProjectConfigPathSafe(project.localPath)
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
  const tmpPath = path.join(
    /*turbopackIgnore: true*/ project.localPath,
    `.forge.project.json.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(tmpPath, configPath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true })
    throw err
  }
}

async function assertProjectConfigPathSafe(localPath: string): Promise<void> {
  const realProjectRoot = await fs.realpath(localPath)
  const configPath = path.join(/*turbopackIgnore: true*/ localPath, 'forge.project.json')
  const realParent = await fs.realpath(path.dirname(configPath))
  if (realParent !== realProjectRoot) {
    throw new Error('Project config path must remain inside the project root.')
  }

  try {
    const stat = await fs.lstat(configPath)
    if (stat.isSymbolicLink()) {
      throw new Error('Project config path cannot be a symlink.')
    }
    if (!stat.isFile()) {
      throw new Error('Project config path exists but is not a file.')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

function projectResponse<T extends { localPath: string | null }>(
  project: T,
  workspace: WorkspaceSettings,
): T & { displayLocalPath: string | null } {
  return {
    ...project,
    displayLocalPath: project.localPath
      ? displayPathForWorkspacePath(workspace, project.localPath)
      : null,
  }
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
      .where(and(isNull(projects.archivedAt), accessibleProjectOwnerCondition(session.userId)))
      .orderBy(desc(projects.createdAt))

    const summaries = await getCachedProjectMcpSummaries(rows.map((project) => project.id))
    const workspace = await getWorkspaceSettings({ ensure: false })
    const projectsWithMcp = rows.map((project) => ({
      ...projectResponse(project, workspace),
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
    const githubTokenEnvVar = data.githubTokenEnvVar?.trim() || null
    const githubTokenEnvVarError = validateGitHubTokenEnvVar(githubTokenEnvVar)
    if (githubTokenEnvVarError) {
      return NextResponse.json({ error: githubTokenEnvVarError }, { status: 400 })
    }

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

      const resolvedLocalPath = resolveWorkspaceInputPath(data.localPath, workspace, workspace.projectsRoot)
      if (!isWithinPath(workspace.workspaceRoot, resolvedLocalPath)) {
        return NextResponse.json(
          { error: 'localPath must be inside the active workspace root' },
          { status: 400 },
        )
      }
      try {
        assertProjectPathNotProtected(resolvedLocalPath, workspace)
        await assertNearestExistingAncestorWithinWorkspace(resolvedLocalPath, workspace)
        await assertProjectLocalPathPreflightAllowed({ localPath: resolvedLocalPath, workspace })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid local path'
        return NextResponse.json({ error: message }, { status: 400 })
      }

      if (await pathExists(resolvedLocalPath)) {
        return NextResponse.json(
          { error: 'Destination folder already exists' },
          { status: 409 },
        )
      }

      const resolvedToken = await resolveGitHubToken({ envVar: githubTokenEnvVar })
      const cloneUrl = buildCloneUrl(data.githubRepo)

      try {
        await withGitAskPassEnv(resolvedToken?.token, ({ env }) =>
          execFile('git', ['clone', '--depth', '1', cloneUrl, resolvedLocalPath], {
            timeout: 60_000,
            ...(env ? { env } : {}),
          }),
        )
      } catch (err) {
        await fs.rm(resolvedLocalPath, { recursive: true, force: true })
        const rawMessage = err instanceof Error ? err.message : 'git clone failed'
        const sanitized = redactToken(rawMessage)
        console.error('[POST /api/projects] git clone failed', sanitized)
        return NextResponse.json({ error: sanitized }, { status: 400 })
      }
      try {
        await execFile('git', ['-C', resolvedLocalPath, 'remote', 'set-url', 'origin', cloneUrl], {
          timeout: 10_000,
        })
        await assertProjectLocalPathAllowed({ localPath: resolvedLocalPath, workspace })
        await assertProjectConfigPathSafe(resolvedLocalPath)
      } catch (err) {
        await fs.rm(resolvedLocalPath, { recursive: true, force: true })
        const message = err instanceof Error ? err.message : 'Invalid local path'
        return NextResponse.json({ error: message }, { status: 400 })
      }

      const [project] = await db
        .insert(projects)
        .values({
          name: data.name,
          submittedBy: session.userId,
          githubRepo: data.githubRepo,
          localPath: resolvedLocalPath,
          githubTokenEnvVar,
          pmProviderConfigId: data.pmProviderConfigId ?? null,
          defaultBranch: data.defaultBranch ?? 'main',
        })
        .returning()

      await registerProjectPath(project.localPath)
      await writeProjectConfig(project)

      console.info('[POST /api/projects] Cloned project', { id: project.id, name: project.name })
      return NextResponse.json({ project: projectResponse(project, workspace) }, { status: 201 })
    }

    const localPathInput =
      source === 'local' ? data.localPath ?? folderNameFromProjectName(data.name) : null
    if (localPathInput?.includes('\0')) {
      return NextResponse.json({ error: 'Invalid local path' }, { status: 400 })
    }
    const resolvedLocalPath =
      localPathInput !== null
        ? resolveWorkspaceInputPath(localPathInput, workspace, workspace.projectsRoot)
        : null

    if (resolvedLocalPath) {
      if (!isWithinPath(workspace.workspaceRoot, resolvedLocalPath)) {
        return NextResponse.json(
          { error: 'localPath must be inside the active workspace root' },
          { status: 400 },
        )
      }
      try {
        assertProjectPathNotProtected(resolvedLocalPath, workspace)
        await assertProjectLocalPathPreflightAllowed({ localPath: resolvedLocalPath, workspace })
        await prepareLocalProjectDirectory(resolvedLocalPath, workspace)
        await assertProjectLocalPathAllowed({ localPath: resolvedLocalPath, workspace })
        await assertProjectConfigPathSafe(resolvedLocalPath)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid local path'
        return NextResponse.json({ error: message }, { status: 400 })
      }
    }

    const [project] = await db
      .insert(projects)
      .values({
        name: data.name,
        submittedBy: session.userId,
        githubRepo: source === 'github' ? data.githubRepo ?? null : null,
        localPath: resolvedLocalPath,
        githubTokenEnvVar,
        pmProviderConfigId: data.pmProviderConfigId ?? null,
        defaultBranch: data.defaultBranch ?? 'main',
      })
      .returning()

    if (project.localPath) {
      await registerProjectPath(project.localPath)
      await writeProjectConfig(project)
    }

    console.info('[POST /api/projects] Created project', { id: project.id, name: project.name })
    return NextResponse.json({ project: projectResponse(project, workspace) }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/projects] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
