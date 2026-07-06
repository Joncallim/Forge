import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { agentRunRecordSchema, type AgentRunEvent, type AgentRunRecord, type RunValidationSummary } from '../contracts/agent-run-record'
import { positiveIntSchema, runIdSchema, type RunId, type RunStatus } from '../contracts/common'
import type { AgentCommandRunRecordInput, AgentCommandRunRecorder } from '../core/agent-command'

const RUN_LOG_RELATIVE_DIR = path.join('.forge', 'runs')
const MAX_EVENT_MESSAGE_LENGTH = 500
const execFile = promisify(execFileCallback)
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
}>

type RunLogOptions = Readonly<{
  repositoryRoot?: string
  now?: Date
  persistRecord?: (input: PersistRunRecordInput) => Promise<void>
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
    issueTitle: input.issueTitle,
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

export async function persistRunRecordToGit(input: PersistRunRecordInput): Promise<void> {
  const root = path.resolve(input.repositoryRoot)
  const relativePath = path.relative(root, input.filePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Refusing to persist a run record outside the repository root.')
  }

  await git(root, ['config', 'user.name', 'github-actions[bot]'])
  await git(root, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  const branchName = (await git(root, ['branch', '--show-current'])).stdout.trim()
  if (branchName === '') {
    throw new Error('Run log git persistence requires a checked-out branch.')
  }
  await git(root, ['add', '--', relativePath])

  try {
    await git(root, ['diff', '--cached', '--quiet', '--', relativePath])
    return
  } catch {
    // git diff --quiet exits non-zero when the run record has staged changes.
  }

  await git(root, ['commit', '-m', `Record Forge agent run ${input.record.runId}`, '--', relativePath])
  await git(root, ['pull', '--rebase', 'origin', branchName])
  await git(root, ['push', 'origin', `HEAD:${branchName}`])
}
