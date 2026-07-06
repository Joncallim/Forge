import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { sanitizeWorkerMessage } from './redaction'
import { db } from '@/db'
import { repositoryCommandAudits } from '@/db/schema'
import { isHostRepositoryWritesEnabled, isRepositoryWritePackage } from './repository-edit-policy'

const execFile = promisify(execFileCallback)

const COMMAND_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 12 * 1024
const MAX_DIFF_BYTES = 24 * 1024
const MAX_STATUS_BUFFER_BYTES = 8 * 1024 * 1024
const STATUS_UNAVAILABLE_MARKER = '?? .forge-status-unavailable\0'
const SAFE_ENV_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'] as const

export type CommandRiskClass = 'read_only'
export type RepositoryEvidenceStatus = 'ready' | 'blocked' | 'failed' | 'complete' | 'validation_skipped'

export type RepositoryEvidenceProject = {
  id: string
  name: string
  githubRepo: string | null
  localPath: string | null
  defaultBranch: string
}

export type RepositoryEvidenceTask = {
  id: string
  title: string
  githubBranch: string | null
}

export type RepositoryEvidenceWorkPackage = {
  id: string
  title: string
  assignedRole: string
  metadata: Record<string, unknown>
  requiredCapabilities: Record<string, unknown>
}

export type RepositoryExecutionContext = {
  status: RepositoryEvidenceStatus
  projectLocalPath: string | null
  pathExists: boolean
  isGitRepository: boolean
  currentBranch: string | null
  baseBranch: string | null
  isDirty: boolean | null
  hasRemote: boolean | null
  intendedTaskBranch: string | null
  branchCollision: boolean | null
  blockedReason: string | null
  statusShort: string
  remoteSummary: string
}

export type ScopedCommandResult = {
  argv: string[]
  command: string
  cwd: string
  exitCode: number
  finishedAt: Date
  outputSummary: string
  riskClass: CommandRiskClass
  startedAt: Date
  stderr: string
  stdout: string
}

export type ScopedCommandAuditRecord = {
  argv: string[]
  artifactId: string | null
  command: string
  cwd: string
  exitCode: number
  finishedAt: Date
  outputSummary: string
  riskClass: CommandRiskClass
  startedAt: Date
  taskId: string
  workPackageId: string | null
  agentRunId: string | null
}

export type ScopedCommandAuditSink = (
  record: ScopedCommandAuditRecord,
) => Promise<{ id: string }>

type ScopedCommandInput = {
  cwd: string
  command: string
  argv: string[]
}

function truncate(value: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const buffer = Buffer.from(value)
  if (buffer.byteLength <= maxBytes) return value
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[truncated]`
}

function normalizeOutput(stdout: string, stderr: string): string {
  return redactCommandOutput(truncate([stdout, stderr].filter(Boolean).join('\n').trim()))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'work-package'
}

function blocked(
  projectLocalPath: string | null,
  blockedReason: string,
  extras: Partial<RepositoryExecutionContext> = {},
): RepositoryExecutionContext {
  return {
    status: 'blocked',
    projectLocalPath,
    pathExists: false,
    isGitRepository: false,
    currentBranch: null,
    baseBranch: null,
    isDirty: null,
    hasRemote: null,
    intendedTaskBranch: null,
    branchCollision: null,
    blockedReason,
    statusShort: '',
    remoteSummary: '',
    ...extras,
  }
}

function scopedCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  }
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]
  }

  return {
    ...env,
    CI: '1',
    GIT_ASKPASS: 'true',
    GIT_CONFIG_COUNT: '7',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_KEY_1: 'core.untrackedCache',
    GIT_CONFIG_KEY_2: 'diff.external',
    GIT_CONFIG_KEY_3: 'core.askPass',
    GIT_CONFIG_KEY_4: 'credential.helper',
    GIT_CONFIG_KEY_5: 'interactive.diffFilter',
    GIT_CONFIG_KEY_6: 'filter.lfs.process',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_VALUE_3: 'true',
    GIT_CONFIG_VALUE_4: '',
    GIT_CONFIG_VALUE_5: '',
    GIT_CONFIG_VALUE_6: '',
    GIT_EDITOR: 'true',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    PAGER: 'cat',
    SSH_ASKPASS: 'true',
  }
}

async function git(cwd: string, argv: string[], maxBytes = MAX_OUTPUT_BYTES): Promise<string> {
  const result = await execFile('git', argv, {
    cwd: /*turbopackIgnore: true*/ cwd,
    env: scopedCommandEnv(),
    maxBuffer: maxBytes * 2,
    timeout: 30_000,
  })
  return truncate(result.stdout.trim(), maxBytes)
}

async function gitRaw(cwd: string, argv: string[], maxBuffer = MAX_STATUS_BUFFER_BYTES): Promise<string> {
  const result = await execFile('git', argv, {
    cwd: /*turbopackIgnore: true*/ cwd,
    env: scopedCommandEnv(),
    maxBuffer,
    timeout: 30_000,
  })
  return result.stdout
}

async function gitOk(cwd: string, argv: string[]): Promise<boolean> {
  try {
    await git(cwd, argv)
    return true
  } catch {
    return false
  }
}

function isForgeRunArtifactPath(statusPath: string): boolean {
  return statusPath === '.forge/task-runs' || statusPath.startsWith('.forge/task-runs/')
}

function parsePorcelainStatusEntries(statusZ: string): Array<{ code: string; paths: string[] }> {
  const tokens = statusZ.split('\0').filter((token) => token !== '')
  const entries: Array<{ code: string; paths: string[] }> = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const code = token.slice(0, 2)
    const firstPath = token.slice(3)
    const paths = [firstPath]
    if (code[0] === 'R' || code[0] === 'C') {
      const originalPath = tokens[index + 1]
      if (originalPath !== undefined) {
        paths.push(originalPath)
        index += 1
      }
    }
    entries.push({ code, paths })
  }
  return entries
}

function repositoryDirtyStatus(statusZ: string): string {
  return parsePorcelainStatusEntries(statusZ)
    .filter((entry) => !entry.paths.every(isForgeRunArtifactPath))
    .map((entry) => `${entry.code} ${entry.paths.join(' -> ')}`)
    .join('\n')
}

function taskBranchName(task: RepositoryEvidenceTask, workPackage: RepositoryEvidenceWorkPackage): string {
  if (task.githubBranch?.trim()) return task.githubBranch.trim()
  return `forge/${task.id.slice(0, 13)}-${slug(workPackage.title || workPackage.assignedRole)}`
}

async function remoteHeadBranch(cwd: string): Promise<string | null> {
  try {
    const ref = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return ref.replace(/^origin\//, '') || null
  } catch {
    return null
  }
}

export function isRepositoryAffectingWorkPackage(workPackage: RepositoryEvidenceWorkPackage): boolean {
  return isRepositoryWritePackage(workPackage)
}

export async function buildRepositoryExecutionContext(input: {
  project: RepositoryEvidenceProject
  task: RepositoryEvidenceTask
  validatedProjectRoot?: string | null
  workPackage: RepositoryEvidenceWorkPackage
}): Promise<RepositoryExecutionContext> {
  const localPath = input.validatedProjectRoot?.trim() || input.project.localPath?.trim() || null
  if (!localPath) {
    return blocked(null, 'Project local path is required before repository evidence can be collected.')
  }

  const resolvedPath = path.resolve(/*turbopackIgnore: true*/ localPath)
  let stat
  try {
    stat = await fs.stat(/*turbopackIgnore: true*/ resolvedPath)
  } catch {
    return blocked(resolvedPath, `Project local path does not exist: ${resolvedPath}`)
  }

  if (!stat.isDirectory()) {
    return blocked(resolvedPath, `Project local path is not a directory: ${resolvedPath}`, {
      pathExists: true,
    })
  }

  const isGitRepository = await gitOk(resolvedPath, ['rev-parse', '--is-inside-work-tree'])
  if (!isGitRepository) {
    return blocked(resolvedPath, `Project local path is not a Git repository: ${resolvedPath}`, {
      pathExists: true,
    })
  }

  const [
    currentBranchRaw,
    statusPorcelainZ,
    remoteSummary,
    remoteHead,
  ] = await Promise.all([
    git(resolvedPath, ['branch', '--show-current']).catch(() => ''),
    gitRaw(resolvedPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      .catch(() => STATUS_UNAVAILABLE_MARKER),
    git(resolvedPath, ['remote', '-v']).catch(() => ''),
    remoteHeadBranch(resolvedPath),
  ])

  const currentBranch = currentBranchRaw.trim() || null
  const dirtyStatus = repositoryDirtyStatus(statusPorcelainZ)
  const isDirty = dirtyStatus.trim().length > 0
  const hasRemote = remoteSummary.trim().length > 0
  const baseBranch = remoteHead ?? (input.project.defaultBranch?.trim() || null)
  const intendedTaskBranch = taskBranchName(input.task, input.workPackage)
  const localCollision = await gitOk(resolvedPath, ['show-ref', '--verify', `refs/heads/${intendedTaskBranch}`])
  const remoteCollision = await gitOk(resolvedPath, ['show-ref', '--verify', `refs/remotes/origin/${intendedTaskBranch}`])
  const branchCollision = localCollision || remoteCollision

  const hostRepositoryWritesEnabled = isHostRepositoryWritesEnabled()
  let blockedReason: string | null = null
  if (!hostRepositoryWritesEnabled) {
    if (isDirty) blockedReason = 'Repository working tree is dirty; review or clean local changes before execution.'
    else if (!hasRemote) blockedReason = 'Repository has no configured Git remote.'
    else if (branchCollision) blockedReason = `Intended task branch already exists: ${intendedTaskBranch}`
  }

  return {
    status: blockedReason ? 'blocked' : 'ready',
    projectLocalPath: resolvedPath,
    pathExists: true,
    isGitRepository: true,
    currentBranch,
    baseBranch,
    isDirty,
    hasRemote,
    intendedTaskBranch,
    branchCollision,
    blockedReason,
    statusShort: truncate(dirtyStatus),
    remoteSummary: redactCommandOutput(remoteSummary),
  }
}

function commandLabel(input: Pick<ScopedCommandInput, 'command' | 'argv'>): string {
  return [input.command, ...input.argv].join(' ')
}

function assertNoShellForm(input: ScopedCommandInput): void {
  if (!input.cwd.trim()) throw new Error('An explicit project cwd is required.')
  if (input.command.includes('/') || input.command.includes('\\') || /\s/.test(input.command)) {
    throw new Error('Shell paths and arbitrary command strings are not allowed.')
  }
  if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(input.command)) {
    throw new Error('Shell execution is not allowed for repository evidence commands.')
  }
  if (!Array.isArray(input.argv) || input.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Command argv must be an array of strings.')
  }
}

function isAllowedGitReadOnly(argv: string[]): boolean {
  const normalized = argv.join(' ')
  return [
    'status --short',
    'branch --show-current',
    'remote -v',
    'diff --stat',
    'diff --stat --',
    'diff --stat HEAD --',
    'diff --name-status',
  ].includes(normalized)
}

function looksLikeRemoteGitMutation(argv: string[]): boolean {
  const verb = argv[0]
  return [
    'push',
    'merge',
    'rebase',
    'reset',
    'checkout',
    'switch',
    'branch',
    'commit',
    'tag',
    'fetch',
    'pull',
    'remote',
    'clone',
  ].includes(verb) && !isAllowedGitReadOnly(argv)
}

function isGitHubWrite(argv: string[]): boolean {
  const [area, action] = argv
  if (!area || !action) return false
  if (area === 'pr' && ['create', 'comment', 'edit', 'merge', 'close', 'reopen', 'ready', 'review'].includes(action)) return true
  if (area === 'issue' && ['create', 'comment', 'edit', 'close', 'reopen'].includes(action)) return true
  if (area === 'workflow' && ['run', 'enable', 'disable'].includes(action)) return true
  if (area === 'repo' && ['edit', 'delete', 'archive'].includes(action)) return true
  return false
}

function isPackageInstall(command: string, argv: string[]): boolean {
  if (command === 'npm' && ['install', 'i', 'ci', 'add'].includes(argv[0])) return true
  if (command === 'pnpm' && ['install', 'i', 'add'].includes(argv[0])) return true
  if (command === 'yarn' && ['install', 'add'].includes(argv[0])) return true
  return false
}

async function packageScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ cwd, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) return {}
    return Object.fromEntries(
      Object.entries(parsed.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''),
    )
  } catch {
    return {}
  }
}

export async function detectProjectValidationCommands(cwd: string): Promise<string[][]> {
  const scripts = await packageScripts(cwd)
  const commands: string[][] = []
  if (scripts.test) commands.push(['npm', 'test'])
  if (scripts.lint) commands.push(['npm', 'run', 'lint'])
  if (scripts.build) commands.push(['npm', 'run', 'build'])
  return commands
}

export async function scopedCommandRisk(input: ScopedCommandInput): Promise<CommandRiskClass> {
  assertNoShellForm(input)

  if (['rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'unlink'].includes(input.command)) {
    throw new Error('Blocked destructive filesystem command.')
  }
  if (input.command === 'gh' && isGitHubWrite(input.argv)) {
    throw new Error('Blocked GitHub write command.')
  }
  if (input.command === 'git' && looksLikeRemoteGitMutation(input.argv)) {
    throw new Error('Blocked remote Git mutation or repository mutation command.')
  }
  if (isPackageInstall(input.command, input.argv)) {
    throw new Error('Blocked package install command.')
  }
  if (['npm', 'pnpm', 'yarn'].includes(input.command)) {
    throw new Error('Blocked host package manager validation command for repository evidence.')
  }
  if (input.command === 'git' && isAllowedGitReadOnly(input.argv)) return 'read_only'

  throw new Error(`Command is not allowed for repository evidence: ${commandLabel(input)}`)
}

export function redactCommandOutput(value: string): string {
  return sanitizeWorkerMessage(value)
}

export async function runScopedRepositoryCommand(input: ScopedCommandInput): Promise<ScopedCommandResult> {
  if (!input.cwd.trim()) throw new Error('An explicit project cwd is required.')
  const cwd = path.resolve(/*turbopackIgnore: true*/ input.cwd)
  const stat = await fs.stat(/*turbopackIgnore: true*/ cwd).catch(() => null)
  if (!stat?.isDirectory()) throw new Error(`Project cwd does not exist or is not a directory: ${cwd}`)

  const riskClass = await scopedCommandRisk({ ...input, cwd })
  const startedAt = new Date()
  try {
    const result = await execFile(input.command, input.argv, {
      cwd: /*turbopackIgnore: true*/ cwd,
      env: scopedCommandEnv(),
      maxBuffer: Math.max(MAX_OUTPUT_BYTES, MAX_DIFF_BYTES) * 2,
      timeout: COMMAND_TIMEOUT_MS,
    })
    const stdout = truncate(result.stdout, input.command === 'git' && input.argv[0] === 'diff' ? MAX_DIFF_BYTES : MAX_OUTPUT_BYTES)
    const stderr = truncate(result.stderr)
    return {
      argv: input.argv,
      command: input.command,
      cwd,
      exitCode: 0,
      finishedAt: new Date(),
      outputSummary: normalizeOutput(stdout, stderr),
      riskClass,
      startedAt,
      stderr: redactCommandOutput(stderr),
      stdout: redactCommandOutput(stdout),
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string | Buffer
      stderr?: string | Buffer
    }
    const stdout = truncate(String(error.stdout ?? ''))
    const stderr = truncate(String(error.stderr ?? error.message))
    return {
      argv: input.argv,
      command: input.command,
      cwd,
      exitCode: typeof error.code === 'number' ? error.code : 1,
      finishedAt: new Date(),
      outputSummary: normalizeOutput(stdout, stderr),
      riskClass,
      startedAt,
      stderr: redactCommandOutput(stderr),
      stdout: redactCommandOutput(stdout),
    }
  }
}

export async function defaultScopedCommandAuditSink(
  record: ScopedCommandAuditRecord,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(repositoryCommandAudits)
    .values({
      agentRunId: record.agentRunId,
      artifactId: record.artifactId,
      argv: record.argv,
      command: record.command,
      cwd: record.cwd,
      exitCode: record.exitCode,
      finishedAt: record.finishedAt,
      outputSummary: record.outputSummary,
      riskClass: record.riskClass,
      startedAt: record.startedAt,
      taskId: record.taskId,
      workPackageId: record.workPackageId,
    })
    .returning({ id: repositoryCommandAudits.id })
  return row
}

export async function recordScopedCommandAudit(input: {
  result: ScopedCommandResult
  taskId: string
  workPackageId?: string | null
  agentRunId?: string | null
  artifactId?: string | null
  auditSink?: ScopedCommandAuditSink
}): Promise<{ id: string }> {
  const sink = input.auditSink ?? defaultScopedCommandAuditSink
  return sink({
    agentRunId: input.agentRunId ?? null,
    artifactId: input.artifactId ?? null,
    argv: input.result.argv,
    command: input.result.command,
    cwd: input.result.cwd,
    exitCode: input.result.exitCode,
    finishedAt: input.result.finishedAt,
    outputSummary: input.result.outputSummary,
    riskClass: input.result.riskClass,
    startedAt: input.result.startedAt,
    taskId: input.taskId,
    workPackageId: input.workPackageId ?? null,
  })
}
