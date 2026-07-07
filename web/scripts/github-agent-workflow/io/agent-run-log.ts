import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { agentRunRecordSchema, type AgentRunEvent, type AgentRunRecord, type RunValidationSummary } from '../contracts/agent-run-record'
import {
  handoffArtifactsSchema,
  nonEmptyTrimmedStringSchema,
  positiveIntSchema,
  runIdSchema,
  type HandoffArtifacts,
  type RunId,
  type RunStatus,
} from '../contracts/common'
import type { AgentCommandRunRecordInput, AgentCommandRunRecorder } from '../core/agent-command'

const RUN_LOG_RELATIVE_DIR = path.join('.forge', 'runs')
export const DEFAULT_RUN_LOG_BRANCH = 'forge/agent-run-log'
const MAX_EVENT_MESSAGE_LENGTH = 500
const execFile = promisify(execFileCallback)
// Best-effort redaction only. Do not route secrets or transcripts into run-log text.
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(token|password|secret|api[_-]?key)\s*[:=]\s*['"]?[^'"\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
])

export type PersistRunRecordInput = Readonly<{
  filePath: string
  record: AgentRunRecord
  repositoryRoot: string
  targetBranch?: string | null
}>

type RunLogOptions = Readonly<{
  repositoryRoot?: string
  now?: Date
  persistRecord?: (input: PersistRunRecordInput) => Promise<void>
  targetBranch?: string | null
}>

export type RunLogBranchWorktreeOptions = Readonly<{
  repositoryRoot?: string
  targetBranch?: string | null
  worktreeParent?: string | null
}>

export type CreateRunRecordInput = AgentCommandRunRecordInput & Readonly<{
  branchName?: string | null
  prNumber?: number | null
  blockedReason?: string | null
  validationSummary?: RunValidationSummary | null
}>

export type AppendRunEventInput = Readonly<{
  issueNumber: number
  runId: RunId
  status?: RunStatus
  message: string
}>

export type UpdateRunStatusInput = Readonly<{
  issueNumber: number
  runId: RunId
  status: RunStatus
  message?: string
  branchName?: string | null
  blockedReason?: string | null
  handoffArtifacts?: HandoffArtifacts | null
}>

export type LinkPullRequestInput = Readonly<{
  issueNumber: number
  runId: RunId
  branchName?: string | null
  prNumber: number
}>

export type RecordBlockedReasonInput = Readonly<{
  issueNumber: number
  runId: RunId
  blockedReason: string
}>

function nowIso(options: RunLogOptions): string {
  return (options.now ?? new Date()).toISOString()
}

async function directoryExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

async function findRepositoryRoot(startDirectory: string): Promise<string> {
  let current = path.resolve(startDirectory)
  while (true) {
    if (await directoryExists(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(startDirectory)
    current = parent
  }
}

async function repositoryRoot(options: RunLogOptions = {}): Promise<string> {
  if (options.repositoryRoot) return path.resolve(options.repositoryRoot)
  const githubWorkspace = process.env.GITHUB_WORKSPACE?.trim()
  if (githubWorkspace) return path.resolve(githubWorkspace)
  return await findRepositoryRoot(process.cwd())
}

export async function resolveRepositoryRoot(startDirectory?: string): Promise<string> {
  return await repositoryRoot({ repositoryRoot: startDirectory })
}

function sanitizeLogText(value: string): string {
  let sanitized = value.trim()
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted]')
  }
  sanitized = sanitized.replace(/\s+/g, ' ').trim()
  if (sanitized.length > MAX_EVENT_MESSAGE_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_EVENT_MESSAGE_LENGTH - 16).trimEnd()} [truncated]`
  }
  return sanitized || '[redacted]'
}

async function runRecordPath(input: {
  repositoryRoot: string
  issueNumber: number
  runId: RunId
}): Promise<string> {
  const issueNumber = positiveIntSchema.parse(input.issueNumber)
  const runId = runIdSchema.parse(input.runId)
  return path.join(input.repositoryRoot, RUN_LOG_RELATIVE_DIR, String(issueNumber), `${runId}.json`)
}

async function writeRecord(filePath: string, record: AgentRunRecord): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(agentRunRecordSchema.parse(record), null, 2)}\n`, 'utf8')
  await rename(temporaryPath, filePath)
}

async function writeAndPersistRecord(
  filePath: string,
  record: AgentRunRecord,
  repositoryRootPath: string,
  options: RunLogOptions,
): Promise<void> {
  await writeRecord(filePath, record)
  await options.persistRecord?.({
    filePath,
    record,
    repositoryRoot: repositoryRootPath,
    targetBranch: options.targetBranch,
  })
}

async function readRecord(repositoryRootPath: string, issueNumber: number, runId: RunId): Promise<AgentRunRecord> {
  const filePath = await runRecordPath({ repositoryRoot: repositoryRootPath, issueNumber, runId })
  return agentRunRecordSchema.parse(JSON.parse(await readFile(filePath, 'utf8')))
}

async function updateRecord(
  issueNumber: number,
  runId: RunId,
  options: RunLogOptions,
  updater: (record: AgentRunRecord, at: string) => AgentRunRecord,
): Promise<AgentRunRecord> {
  // Read-modify-write updates are not concurrency-safe. Callers must serialize
  // updates for a run until #144 defines a cross-workflow locking contract.
  const root = await repositoryRoot(options)
  const current = await readRecord(root, issueNumber, runId)
  const updated = agentRunRecordSchema.parse(updater(current, nowIso(options)))
  const filePath = await runRecordPath({ repositoryRoot: root, issueNumber, runId })
  await writeAndPersistRecord(filePath, updated, root, options)
  return updated
}

function event(input: { at: string; status: RunStatus; message: string }): AgentRunEvent {
  return {
    at: input.at,
    status: input.status,
    message: sanitizeLogText(input.message),
  }
}

export async function createRunRecord(input: CreateRunRecordInput, options: RunLogOptions = {}): Promise<AgentRunRecord> {
  const at = nowIso(options)
  const record = agentRunRecordSchema.parse({
    runId: input.runId,
    issueNumber: input.issueNumber,
    issueTitle: sanitizeLogText(input.issueTitle),
    runtime: input.runtime,
    action: input.action,
    requestedBy: input.requestedBy,
    status: 'requested',
    branchName: input.branchName ?? null,
    blockedReason: input.blockedReason === undefined || input.blockedReason === null
      ? null
      : sanitizeLogText(input.blockedReason),
    handoffArtifacts: null,
    source: input.source,
    prNumber: input.prNumber ?? null,
    validationSummary: input.validationSummary ?? null,
    createdAt: at,
    updatedAt: at,
    events: [
      event({
        at,
        status: 'requested',
        message: 'Run record created from an accepted issue command.',
      }),
    ],
  })
  const root = await repositoryRoot(options)
  const filePath = await runRecordPath({ repositoryRoot: root, issueNumber: record.issueNumber, runId: record.runId })
  await writeAndPersistRecord(filePath, record, root, options)
  return record
}

export async function recordRequested(input: CreateRunRecordInput, options: RunLogOptions = {}): Promise<AgentRunRecord> {
  return await createRunRecord(input, options)
}

export async function appendRunEvent(input: AppendRunEventInput, options: RunLogOptions = {}): Promise<AgentRunRecord> {
  return await updateRecord(input.issueNumber, input.runId, options, (record, at) => ({
    ...record,
    updatedAt: at,
    events: [
      ...record.events,
      event({
        at,
        status: input.status ?? record.status,
        message: input.message,
      }),
    ],
  }))
}

export async function updateRunStatus(input: UpdateRunStatusInput, options: RunLogOptions = {}): Promise<AgentRunRecord> {
  return await updateRecord(input.issueNumber, input.runId, options, (record, at) => ({
    ...record,
    status: input.status,
    branchName: input.branchName === undefined ? record.branchName : input.branchName,
    blockedReason: input.blockedReason === undefined ? record.blockedReason : input.blockedReason,
    handoffArtifacts: input.handoffArtifacts === undefined
      ? record.handoffArtifacts
      : input.handoffArtifacts === null
        ? null
        : handoffArtifactsSchema.parse(input.handoffArtifacts),
    updatedAt: at,
    events: [
      ...record.events,
      event({
        at,
        status: input.status,
        message: input.message ?? `Run status changed to ${input.status}.`,
      }),
    ],
  }))
}

export async function linkPullRequest(input: LinkPullRequestInput, options: RunLogOptions = {}): Promise<AgentRunRecord> {
  return await updateRecord(input.issueNumber, input.runId, options, (record, at) => ({
    ...record,
    status: 'pr-opened',
    branchName: input.branchName ?? record.branchName,
    prNumber: input.prNumber,
    updatedAt: at,
    events: [
      ...record.events,
      event({
        at,
        status: 'pr-opened',
        message: `Linked pull request #${input.prNumber}.`,
      }),
    ],
  }))
}

export async function recordBlockedReason(input: RecordBlockedReasonInput, options: RunLogOptions = {}): Promise<AgentRunRecord> {
  return await updateRecord(input.issueNumber, input.runId, options, (record, at) => ({
    ...record,
    status: 'blocked',
    blockedReason: sanitizeLogText(input.blockedReason),
    updatedAt: at,
    events: [
      ...record.events,
      event({
        at,
        status: 'blocked',
        message: input.blockedReason,
      }),
    ],
  }))
}

export async function findLatestRunForIssue(
  issueNumber: number,
  options: RunLogOptions = {},
): Promise<AgentRunRecord | null> {
  const root = await repositoryRoot(options)
  const directory = path.join(root, RUN_LOG_RELATIVE_DIR, String(positiveIntSchema.parse(issueNumber)))
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return null
  }

  const records: AgentRunRecord[] = []
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const record = agentRunRecordSchema.parse(JSON.parse(await readFile(path.join(directory, entry), 'utf8')))
    if (record.issueNumber === issueNumber) records.push(record)
  }

  return records.sort((left, right) => {
    const updated = left.updatedAt.localeCompare(right.updatedAt)
    if (updated !== 0) return updated
    const created = left.createdAt.localeCompare(right.createdAt)
    if (created !== 0) return created
    return left.runId.localeCompare(right.runId)
  }).at(-1) ?? null
}

export class FileAgentRunRecorder implements AgentCommandRunRecorder {
  constructor(private readonly options: RunLogOptions = {}) {}

  async recordRequested(input: AgentCommandRunRecordInput): Promise<void> {
    await recordRequested(input, this.options)
  }
}

export function runLogPathForDisplay(issueNumber: number, runId: RunId): string {
  const record = agentRunRecordSchema.pick({ issueNumber: true, runId: true }).parse({ issueNumber, runId })
  return path.posix.join('.forge', 'runs', String(record.issueNumber), `${record.runId}.json`)
}

async function git(repositoryRootPath: string, args: readonly string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFile('git', args, {
    cwd: repositoryRootPath,
    timeout: 120_000,
  })
  return { stdout: stdout.toString() }
}

async function tryGit(repositoryRootPath: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(repositoryRootPath, args)
    return true
  } catch {
    return false
  }
}

function targetBranchName(input: PersistRunRecordInput, currentBranch: string): string {
  return (input.targetBranch ?? process.env.FORGE_AGENT_RUN_LOG_BRANCH)?.trim() || currentBranch || DEFAULT_RUN_LOG_BRANCH
}

async function fetchRemoteBranch(root: string, branchName: string): Promise<boolean> {
  return await tryGit(root, [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
  ])
}

async function rebaseOnRemoteBranchIfPresent(root: string, branchName: string): Promise<void> {
  if (await fetchRemoteBranch(root, branchName)) {
    await git(root, ['rebase', `origin/${branchName}`])
  }
}

async function pushHeadToBranch(root: string, branchName: string): Promise<void> {
  await git(root, ['push', 'origin', `HEAD:refs/heads/${branchName}`])
}

export async function persistRunRecordToGit(input: PersistRunRecordInput): Promise<void> {
  const root = path.resolve(input.repositoryRoot)
  const relativePath = path.relative(root, input.filePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Refusing to persist a run record outside the repository root.')
  }

  await git(root, ['config', 'user.name', 'github-actions[bot]'])
  await git(root, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  const branchName = (await git(root, ['branch', '--show-current'])).stdout.trim()
  const targetBranch = targetBranchName(input, branchName)
  await git(root, ['check-ref-format', '--branch', targetBranch])
  await git(root, ['add', '--', relativePath])
  try {
    await git(root, ['ls-files', '--error-unmatch', '--', relativePath])
  } catch {
    throw new Error(`Run record path ${relativePath} is ignored by git. Check the .forge/runs .gitignore rules.`)
  }

  try {
    await git(root, ['diff', '--cached', '--quiet', '--', relativePath])
    return
  } catch {
    // git diff --quiet exits non-zero when the run record has staged changes.
  }

  await git(root, ['commit', '-m', `Record Forge agent run ${input.record.runId}`, '--', relativePath])
  await rebaseOnRemoteBranchIfPresent(root, targetBranch)
  try {
    await pushHeadToBranch(root, targetBranch)
  } catch {
    await rebaseOnRemoteBranchIfPresent(root, targetBranch)
    await pushHeadToBranch(root, targetBranch)
  }
}

function normalizeRunLogBranchName(branchName: string | null | undefined): string {
  const targetBranch = nonEmptyTrimmedStringSchema.parse(branchName?.trim() || DEFAULT_RUN_LOG_BRANCH)
  if (targetBranch === 'HEAD') throw new Error('Run-log branch cannot be HEAD.')
  return targetBranch
}

export async function withRunLogBranchWorktree<T>(
  options: RunLogBranchWorktreeOptions,
  callback: (runLogRepositoryRoot: string) => Promise<T>,
): Promise<T> {
  const trustedRoot = await repositoryRoot({ repositoryRoot: options.repositoryRoot })
  const targetBranch = normalizeRunLogBranchName(options.targetBranch ?? process.env.FORGE_AGENT_RUN_LOG_BRANCH)
  await git(trustedRoot, ['check-ref-format', '--branch', targetBranch])

  const parent = options.worktreeParent ? path.resolve(options.worktreeParent) : os.tmpdir()
  const scratchRoot = await mkdtemp(path.join(parent, 'forge-run-log-worktree-'))
  const worktreeRoot = path.join(scratchRoot, 'repo')
  const remoteBranchExists = await fetchRemoteBranch(trustedRoot, targetBranch)
  const startPoint = remoteBranchExists ? `origin/${targetBranch}` : 'HEAD'

  try {
    await git(trustedRoot, ['worktree', 'add', '--detach', worktreeRoot, startPoint])
    return await callback(worktreeRoot)
  } finally {
    await tryGit(trustedRoot, ['worktree', 'remove', '--force', worktreeRoot])
    await rm(scratchRoot, { recursive: true, force: true })
  }
}
