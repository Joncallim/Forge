import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_WORKSPACE_ROOT,
  getWorkspaceSettings,
  isWithinPath,
  normalizeWorkspaceRoot,
  type WorkspaceSettings,
} from '@/lib/workspace'

export const AGENT_PROMPT_EXTENSION = '.toml'

export function resolveAgentConfigDir(
  cwd = process.cwd(),
  workspaceRoot = normalizeWorkspaceRoot(process.env.FORGE_WORKSPACE_ROOT?.trim() || DEFAULT_WORKSPACE_ROOT),
): string {
  void cwd
  const configured = process.env.FORGE_AGENT_CONFIG_DIR?.trim()
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured)

  return path.join(/*turbopackIgnore: true*/ workspaceRoot, 'prompts', 'agents')
}

export async function resolveAgentPromptDir(options: { ensure?: boolean } = {}): Promise<string> {
  const workspace = await getWorkspaceSettings({ ensure: options.ensure ?? true })
  const configured = process.env.FORGE_AGENT_CONFIG_DIR?.trim()
  if (!configured) return workspace.agentPromptsRoot

  const resolved = path.resolve(/*turbopackIgnore: true*/ configured)
  if (!isWithinPath(workspace.workspaceRoot, resolved)) {
    throw new Error('FORGE_AGENT_CONFIG_DIR must stay inside the active workspace root.')
  }
  return resolved
}

export function agentPromptFilePath(agentPromptDir: string, agentType: string): string {
  return path.join(/*turbopackIgnore: true*/ agentPromptDir, `${agentType}${AGENT_PROMPT_EXTENSION}`)
}

async function realDirectory(directoryPath: string): Promise<string> {
  await fs.mkdir(directoryPath, { recursive: true })
  return fs.realpath(directoryPath)
}

export async function assertSafeWorkspaceFilePath(
  filePath: string,
  workspaceRoot: string,
): Promise<void> {
  const workspaceRealPath = await realDirectory(workspaceRoot)
  const directoryRealPath = await realDirectory(path.dirname(filePath))
  if (!isWithinPath(workspaceRealPath, directoryRealPath)) {
    throw new Error('Workspace prompt file path must stay inside the active workspace root.')
  }

  try {
    const stat = await fs.lstat(filePath)
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to follow workspace prompt symlink: ${filePath}`)
    }
    if (!stat.isFile()) {
      throw new Error(`Workspace prompt path is not a regular file: ${filePath}`)
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

export async function readWorkspacePromptFile(
  filePath: string,
  workspaceRoot: string,
): Promise<string | null> {
  await assertSafeWorkspaceFilePath(filePath, workspaceRoot)
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeWorkspaceFileAtomically(
  filePath: string,
  content: string,
  workspaceRoot: string,
): Promise<void> {
  await assertSafeWorkspaceFilePath(filePath, workspaceRoot)
  const directory = path.dirname(filePath)
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, filePath)
    await fs.chmod(filePath, 0o600)
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
}

function escapeTomlMultilineBasic(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"""/g, '\\"\\"\\"')
}

function escapeTomlBasic(value: string): string {
  return value.replace(/[\u0000-\u001F"\\]/g, (char) => {
    switch (char) {
      case '\\':
        return '\\\\'
      case '"':
        return '\\"'
      case '\u0008':
        return '\\b'
      case '\f':
        return '\\f'
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    }
  })
}

export function renderCodexAgentToml(input: {
  agentType: string
  displayName?: string
  description?: string
  systemPrompt: string
}): string {
  const description = input.description?.trim() || input.displayName?.trim() || input.agentType
  return [
    `name = "${escapeTomlBasic(input.agentType)}"`,
    `description = "${escapeTomlBasic(description)}"`,
    'developer_instructions = """',
    escapeTomlMultilineBasic(input.systemPrompt).trimEnd(),
    '"""',
    '',
  ].join('\n')
}

export function replaceDeveloperInstructions(raw: string, systemPrompt: string): string {
  const escaped = escapeTomlMultilineBasic(systemPrompt).trimEnd()
  const replacement = `developer_instructions = """\n${escaped}\n"""`
  const pattern = /^developer_instructions\s*=\s*"""\n?[\s\S]*?\n?"""$/m
  if (pattern.test(raw)) {
    return raw.replace(pattern, replacement).trimEnd() + '\n'
  }
  return `${raw.trimEnd()}\n\n${replacement}\n`
}

export async function syncAgentPromptFileToWorkspace(input: {
  agentType: string
  systemPrompt: string
  displayName?: string
  description?: string
}): Promise<string> {
  const workspace = await getWorkspaceSettings()
  const agentPromptDir = await resolveAgentPromptDir()
  const promptFilePath = agentPromptFilePath(agentPromptDir, input.agentType)

  let nextContent: string
  const existing = await readWorkspacePromptFile(promptFilePath, workspace.workspaceRoot)
  if (existing) {
    nextContent = replaceDeveloperInstructions(existing, input.systemPrompt)
  } else {
    nextContent = renderCodexAgentToml(input)
  }

  await writeWorkspaceFileAtomically(promptFilePath, nextContent, workspace.workspaceRoot)
  return promptFilePath
}

export function workspacePromptManifest(workspace: WorkspaceSettings): Record<string, string> {
  return {
    promptsRoot: workspace.promptsRoot,
    agentPromptsRoot: workspace.agentPromptsRoot,
    workforcesRoot: workspace.workforcesRoot,
  }
}
