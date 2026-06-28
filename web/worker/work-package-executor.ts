import { generateText, type LanguageModel } from 'ai'
import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { agentConfigs, projects, tasks, workPackages } from '../db/schema'
import { getModel, getProvider } from '../lib/providers/registry'
import { resolveDefaultProvider } from '../lib/providers/default'

const execFile = promisify(execFileCallback)

const EXECUTION_SCHEMA_VERSION = 1
const MAX_FILES = 50
const MAX_FILE_BYTES = 512 * 1024
const MAX_COMMANDS = 5
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024
const COMMAND_TIMEOUT_MS = 120_000
const MAX_GENERATION_ATTEMPTS = 2
const DEFAULT_GENERATION_TIMEOUT_MS = 120_000

const ALLOWED_COMMANDS = new Set([
  'npm test',
  'npm run build',
  'npm run lint',
])

type TaskRow = typeof tasks.$inferSelect
type ProjectRow = typeof projects.$inferSelect
type WorkPackageRow = typeof workPackages.$inferSelect
type AgentConfigRow = typeof agentConfigs.$inferSelect

export type WorkPackageExecutionFile = {
  path: string
  content: string
}

export type WorkPackageExecutionCommandResult = {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
}

export type WorkPackageExecutionPlan = {
  schemaVersion: 1
  summary: string
  files: WorkPackageExecutionFile[]
  commands: string[][]
}

export type WorkPackageExecutionContext = {
  agentConfig: AgentConfigRow | null
  model: LanguageModel
  modelIdUsed: string
  project: ProjectRow
  task: TaskRow
  workPackage: WorkPackageRow
}

export type WorkPackageExecutionResult = {
  artifactContent: string
  artifactMetadata: Record<string, unknown>
  commandResults: WorkPackageExecutionCommandResult[]
  fileCount: number
  sandboxPath: string
  summary: string
}

export function resolveExecutionProviderConfigId(input: {
  agentProviderConfigId?: string | null
  taskProviderConfigId?: string | null
}): string | null {
  return input.taskProviderConfigId ?? input.agentProviderConfigId ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, maxBytes = MAX_COMMAND_OUTPUT_BYTES): string {
  const buffer = Buffer.from(value)
  if (buffer.byteLength <= maxBytes) return value
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[truncated]`
}

function normalizeCommand(command: string[]): string {
  return command.join(' ').replace(/\s+/g, ' ').trim()
}

function generationTimeoutMs(): number {
  const raw = process.env.FORGE_WORK_PACKAGE_GENERATION_TIMEOUT_MS
  if (!raw) return DEFAULT_GENERATION_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GENERATION_TIMEOUT_MS
}

function assertAllowedCommand(command: string[]): void {
  if (!Array.isArray(command) || command.some((part) => typeof part !== 'string' || part.trim() === '')) {
    throw new Error('Execution command must be a non-empty string array.')
  }
  if (!ALLOWED_COMMANDS.has(normalizeCommand(command))) {
    throw new Error(`Command is not allowed: ${normalizeCommand(command)}`)
  }
}

function extractJson(rawText: string): string {
  const fenced = /```(?:work_package_execution_json|json)?\s*\n([\s\S]*?)\n?```/i.exec(rawText)
  if (fenced) return fenced[1]

  for (let start = rawText.indexOf('{'); start >= 0; start = rawText.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < rawText.length; index += 1) {
      const char = rawText[index]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          return rawText.slice(start, index + 1)
        }
      }
    }
  }

  return rawText
}

function normalizeExecutionPlan(parsed: unknown): WorkPackageExecutionPlan {
  if (!isRecord(parsed) || parsed.schemaVersion !== EXECUTION_SCHEMA_VERSION) {
    throw new Error('Execution response must include schemaVersion: 1.')
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (summary === '') throw new Error('Execution response must include a summary.')

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('Execution response must include at least one file.')
  }
  if (parsed.files.length > MAX_FILES) {
    throw new Error(`Execution response included too many files; maximum is ${MAX_FILES}.`)
  }

  const files = parsed.files.map((file, index): WorkPackageExecutionFile => {
    if (!isRecord(file)) throw new Error(`File ${index + 1} must be an object.`)
    const filePath = typeof file.path === 'string' ? file.path.trim() : ''
    const content = typeof file.content === 'string' ? file.content : null
    if (filePath === '') throw new Error(`File ${index + 1} is missing path.`)
    if (content === null) throw new Error(`File ${filePath} is missing content.`)
    assertRelativeWritePath(filePath)
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new Error(`File ${filePath} exceeds the ${MAX_FILE_BYTES} byte limit.`)
    }
    return { path: filePath, content }
  })

  const commands = Array.isArray(parsed.commands)
    ? parsed.commands.map((command) => {
        if (!Array.isArray(command)) throw new Error('Each command must be a string array.')
        const normalized = command.map((part) => {
          if (typeof part !== 'string') throw new Error('Each command part must be a string.')
          return part.trim()
        }).filter(Boolean)
        assertAllowedCommand(normalized)
        return normalized
      })
    : []
  if (commands.length > MAX_COMMANDS) {
    throw new Error(`Execution response included too many commands; maximum is ${MAX_COMMANDS}.`)
  }

  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    summary,
    files,
    commands,
  }
}

function promptRequestsTests(prompt: string): boolean {
  return /\btests?\b|\btest coverage\b/i.test(prompt)
}

function promptRequestsBuild(prompt: string): boolean {
  return /\b(make sure|ensure|verify).*\bbuilds?\b|\bapp builds?\b|\bproject builds?\b|\bnpm run build\b|\bbuild check\b|\bbuilds successfully\b|\bcompile\b/i.test(prompt)
}

function hasCommand(commands: string[][], expected: string): boolean {
  return commands.some((command) => normalizeCommand(command) === expected)
}

function isPlaceholderContent(content: string): boolean {
  return /\b(no tests? needed|not needed for this example|placeholder|todo only|stub)\b/i.test(content)
}

function readGeneratedPackageJson(files: WorkPackageExecutionFile[]): Record<string, unknown> | null {
  const packageFile = files.find((file) => file.path === 'package.json')
  if (!packageFile) return null

  try {
    const parsed: unknown = JSON.parse(packageFile.content)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function packageScript(packageJson: Record<string, unknown> | null, name: string): string {
  const scripts = packageJson?.scripts
  if (!isRecord(scripts)) return ''
  const script = scripts[name]
  return typeof script === 'string' ? script.trim() : ''
}

function isNoOpScript(script: string): boolean {
  return (
    script === '' ||
    /(^|\s)(true|exit 0)(\s|$)/i.test(script) ||
    /^\s*echo\s+['"]?(build script not needed|no tests? needed|not needed for this example|ok|done)/i.test(script)
  )
}

function isInvalidNodeTestScript(script: string): boolean {
  return /^\s*node:test(\s|$)/i.test(script)
}

function validatePlanAgainstPrompt(plan: WorkPackageExecutionPlan, prompt: string): void {
  const packageJson = readGeneratedPackageJson(plan.files)

  if (promptRequestsTests(prompt)) {
    if (!hasCommand(plan.commands, 'npm test')) {
      throw new Error('The user requested tests, but the execution plan did not run npm test.')
    }

    const hasTestFile = plan.files.some((file) =>
      /(^|\/)(__tests__\/|.*(\.test|\.spec)\.[cm]?[jt]sx?$|test\.[cm]?js$)/i.test(file.path),
    )
    if (!hasTestFile) {
      throw new Error('The user requested focused tests, but the execution plan did not include a test file.')
    }

    const testScript = packageScript(packageJson, 'test')
    if (isNoOpScript(testScript) || plan.files.some((file) => isPlaceholderContent(file.content))) {
      throw new Error('The generated test plan appears to contain placeholder tests.')
    }
    if (isInvalidNodeTestScript(testScript)) {
      throw new Error('The generated test script is invalid; use `node --test` or a runnable test command.')
    }
  }

  if (promptRequestsBuild(prompt)) {
    if (!hasCommand(plan.commands, 'npm run build')) {
      throw new Error('The user requested a build check, but the execution plan did not run npm run build.')
    }

    const buildScript = packageScript(packageJson, 'build')
    if (isNoOpScript(buildScript)) {
      throw new Error('The generated build script appears to be a placeholder.')
    }
  }
}

async function generateValidatedExecutionPlan(input: {
  model: LanguageModel
  prompt: string
  taskPrompt: string
  system: string
}): Promise<WorkPackageExecutionPlan> {
  let prompt = input.prompt
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), generationTimeoutMs())
    let text: string
    try {
      const generated = await generateText({
        abortSignal: controller.signal,
        model: input.model,
        system: input.system,
        prompt,
        temperature: 0.1,
      })
      text = generated.text
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Model generation timed out after ${generationTimeoutMs()}ms.`)
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }

    try {
      const plan = parseWorkPackageExecutionPlan(text)
      validatePlanAgainstPrompt(plan, input.taskPrompt)
      return plan
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      prompt = [
        input.prompt,
        '',
        'Your previous response was rejected by Forge validation.',
        `Validation error: ${lastError.message}`,
        '',
        'Return a corrected full `work_package_execution_json` response.',
        'Do not reuse placeholder tests or echo-only build scripts.',
      ].join('\n')
    }
  }

  throw lastError ?? new Error('Execution plan generation failed validation.')
}

export function parseWorkPackageExecutionPlan(rawText: string): WorkPackageExecutionPlan {
  const jsonText = extractJson(rawText)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('Execution response was not valid JSON.')
  }
  return normalizeExecutionPlan(parsed)
}

export function hasLocalConflictCopyPathSegment(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((part) => / 2(?:\.[^./\\]+)?$/.test(part))
}

function assertRelativeWritePath(filePath: string): void {
  if (path.isAbsolute(filePath)) throw new Error(`File path must be relative: ${filePath}`)
  const parts = filePath.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0 || parts.includes('..')) {
    throw new Error(`File path cannot traverse outside the project: ${filePath}`)
  }
  if (parts.includes('.git') || parts.includes('node_modules')) {
    throw new Error(`File path is not writable by Forge: ${filePath}`)
  }
  if (hasLocalConflictCopyPathSegment(filePath)) {
    throw new Error(`File path looks like a local conflict-copy artifact and cannot be written by Forge: ${filePath}`)
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function writeExecutionFile(projectRoot: string, file: WorkPackageExecutionFile): Promise<void> {
  assertRelativeWritePath(file.path)
  const resolvedRoot = path.resolve(projectRoot)
  const target = path.resolve(resolvedRoot, file.path)
  if (!isWithinPath(resolvedRoot, target)) {
    throw new Error(`File path escapes the project: ${file.path}`)
  }

  const parent = path.dirname(target)
  await fs.mkdir(parent, { recursive: true })
  const [realRoot, realParent] = await Promise.all([
    fs.realpath(resolvedRoot),
    fs.realpath(parent),
  ])
  if (!isWithinPath(realRoot, realParent)) {
    throw new Error(`File path escapes the real project directory: ${file.path}`)
  }

  await fs.writeFile(target, file.content)
}

async function runCommand(projectRoot: string, command: string[]): Promise<WorkPackageExecutionCommandResult> {
  assertAllowedCommand(command)
  try {
    const result = await execFile(command[0], command.slice(1), {
      cwd: projectRoot,
      env: { ...process.env, CI: '1' },
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES * 2,
      timeout: COMMAND_TIMEOUT_MS,
    })
    return {
      command,
      exitCode: 0,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string | Buffer
      stderr?: string | Buffer
    }
    return {
      command,
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: truncate(String(error.stdout ?? '')),
      stderr: truncate(String(error.stderr ?? error.message)),
    }
  }
}

async function listProjectFiles(projectRoot: string): Promise<string[]> {
  const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage'])
  const files: string[] = []

  async function walk(current: string, depth: number): Promise<void> {
    if (files.length >= 80 || depth > 3) return
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= 80 || ignored.has(entry.name)) continue
      if (hasLocalConflictCopyPathSegment(entry.name)) continue
      const absolute = path.join(current, entry.name)
      const relative = path.relative(projectRoot, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1)
      } else if (entry.isFile()) {
        files.push(relative)
      }
    }
  }

  await walk(projectRoot, 0)
  return files.sort()
}

function defaultSystemPrompt(role: string): string {
  return [
    `You are the ${role} implementation agent for Forge.`,
    'Return only the requested machine-readable JSON. Do not include prose outside the JSON fence.',
    'Make the smallest complete code change that satisfies the assigned work package.',
  ].join('\n')
}

function buildExecutionPrompt(input: {
  hostProjectRoot: string
  projectFiles: string[]
  sandboxRoot: string
  task: TaskRow
  workPackage: WorkPackageRow
}): string {
  return [
    `Host project root: ${input.hostProjectRoot}`,
    `Execution sandbox root: ${input.sandboxRoot}`,
    `Task title: ${input.task.title}`,
    '',
    'Original user prompt:',
    input.task.prompt,
    '',
    `Work package: ${input.workPackage.title}`,
    `Assigned role: ${input.workPackage.assignedRole}`,
    `Summary: ${input.workPackage.summary}`,
    '',
    'Work package steps:',
    ...(input.workPackage.steps.length > 0 ? input.workPackage.steps.map((step) => `- ${step}`) : ['- Complete the assigned work package.']),
    '',
    'Existing project files:',
    ...(input.projectFiles.length > 0 ? input.projectFiles.map((file) => `- ${file}`) : ['- (empty project folder)']),
    '',
    'Implementation contract:',
    '- Return one fenced `work_package_execution_json` block and nothing else.',
    '- Write all files needed for this package. Use relative paths only; Forge will place them under the execution sandbox root.',
    '- Do not write outside the execution sandbox, `.git`, or `node_modules`.',
    '- Do not create local conflict-copy names such as `file 2.ts`, `config 2.json`, or directories ending in ` 2`.',
    '- Do not rely on external services in the generated app.',
    '- For tiny new web apps, prefer dependency-free HTML/CSS/JavaScript plus Node built-in tests so `npm test` and `npm run build` can run without `npm install`.',
    '- For dependency-free web apps, separate behavior into a testable JavaScript module and use `node:test` to verify requested actions and persistence behavior.',
    '- A useful static-app build check can be a Node script that verifies required files exist and parses JavaScript syntax; it must fail when the app files are broken.',
    '- If the user requested tests, include real focused tests that assert the requested behavior; placeholder tests are invalid.',
    '- If the user requested a build, make `npm run build` perform a meaningful syntax/output check; echo-only build scripts are invalid.',
    '- Commands are optional and must be selected only from: `npm test`, `npm run build`, `npm run lint`.',
    '- Include focused tests when the user requested tests.',
    '',
    'JSON shape:',
    '```work_package_execution_json',
    '{"schemaVersion":1,"summary":"Implemented the tracker UI and tests.","files":[{"path":"package.json","content":"..."}],"commands":[["npm","test"],["npm","run","build"]]}',
    '```',
  ].join('\n')
}

export async function loadWorkPackageExecutionContext(
  taskId: string,
  workPackageId: string,
): Promise<WorkPackageExecutionContext> {
  const [row] = await db
    .select({
      task: tasks,
      project: projects,
      workPackage: workPackages,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(workPackages, and(eq(workPackages.taskId, tasks.id), eq(workPackages.id, workPackageId)))
    .where(eq(tasks.id, taskId))
    .limit(1)

  if (!row) throw new Error('Work package execution context not found.')
  if (!row.project.localPath) throw new Error('Project localPath is required before Forge can execute work packages.')

  const [agentConfig] = await db
    .select()
    .from(agentConfigs)
    .where(eq(agentConfigs.agentType, row.workPackage.assignedRole))
    .limit(1)

  let providerConfigId = resolveExecutionProviderConfigId({
    agentProviderConfigId: agentConfig?.providerConfigId,
    taskProviderConfigId: row.task.pmProviderConfigId,
  })
  if (!providerConfigId) {
    providerConfigId = (await resolveDefaultProvider())?.id ?? null
  }
  if (!providerConfigId) {
    throw new Error(`No provider configured for ${row.workPackage.assignedRole} execution.`)
  }

  const provider = await getProvider(providerConfigId)
  if (!provider) throw new Error(`Provider config ${providerConfigId} is missing or inactive.`)

  const model = await getModel(providerConfigId)
  if (!model) throw new Error(`Provider config ${providerConfigId} is missing or inactive.`)

  return {
    agentConfig: agentConfig ?? null,
    model,
    modelIdUsed: provider.config.modelId,
    project: row.project,
    task: row.task,
    workPackage: row.workPackage,
  }
}

export async function executeWorkPackage(context: WorkPackageExecutionContext): Promise<WorkPackageExecutionResult> {
  const hostProjectRoot = context.project.localPath
  if (!hostProjectRoot) throw new Error('Project localPath is required before Forge can execute work packages.')

  const sandboxRoot = path.join(hostProjectRoot, '.forge', 'task-runs', context.task.id, context.workPackage.id)
  await fs.mkdir(sandboxRoot, { recursive: true })
  const projectFiles = await listProjectFiles(sandboxRoot)
  const system = context.agentConfig?.systemPrompt || defaultSystemPrompt(context.workPackage.assignedRole)
  const prompt = buildExecutionPrompt({
    hostProjectRoot,
    projectFiles,
    sandboxRoot,
    task: context.task,
    workPackage: context.workPackage,
  })

  const plan = await generateValidatedExecutionPlan({
    model: context.model,
    prompt,
    system,
    taskPrompt: context.task.prompt,
  })

  for (const file of plan.files) {
    await writeExecutionFile(sandboxRoot, file)
  }

  const commandResults: WorkPackageExecutionCommandResult[] = []
  for (const command of plan.commands) {
    const result = await runCommand(sandboxRoot, command)
    commandResults.push(result)
    if (result.exitCode !== 0) {
      throw new Error(`Command failed: ${normalizeCommand(command)}\n${result.stderr || result.stdout}`)
    }
  }

  const artifactContent = [
    plan.summary,
    '',
    `Files written: ${plan.files.length}`,
    ...plan.files.map((file) => `- ${file.path}`),
    '',
    'Commands:',
    ...(commandResults.length > 0
      ? commandResults.map((result) => `- ${normalizeCommand(result.command)} -> exit ${result.exitCode}`)
      : ['- (none)']),
  ].join('\n')

  return {
    artifactContent,
    artifactMetadata: {
      commandResults,
      files: plan.files.map((file) => file.path),
      generatedBy: 'work-package-executor',
      repositoryWrites: plan.files.length > 0,
      sandboxPath: sandboxRoot,
      schemaVersion: EXECUTION_SCHEMA_VERSION,
    },
    commandResults,
    fileCount: plan.files.length,
    sandboxPath: sandboxRoot,
    summary: plan.summary,
  }
}
