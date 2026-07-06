/**
 * Seed app agent configurations from the workspace prompt store.
 *
 * On first install, repository defaults from .codex/agents/*.toml are copied to
 * ~/Documents/Forge/prompts/agents. Upgrades keep local prompt edits by default
 * unless FORGE_PROMPT_UPGRADE_MODE=overwrite is set.
 *
 * Run with: npx tsx db/seed-agents.ts
 * Or via:   npm run db:seed-agents
 *
 * This script upserts rows into agent_configs, inserting on first run and
 * updating systemPrompt + updatedAt on subsequent runs.
 */

import '../lib/load-env'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from './index'
import { agentConfigs, workforceAgents, workforces } from './schema'
import { getWorkspaceSettings } from '../lib/workspace'
import {
  AGENT_PROMPT_EXTENSION,
  agentPromptFilePath,
  readWorkspacePromptFile,
  writeWorkspaceFileAtomically,
} from '../lib/agent-prompts'
import { exportWorkforcesToWorkspace } from '../lib/workforce-exports'
import { displayNameForSlug } from '../lib/naming'
import { DEFAULT_WORKFORCES, resolveWorkforceMembers } from './default-workforces'

const REPO_ROOT = path.resolve(__dirname, '../..')
const CODEX_AGENTS_DIR = path.join(REPO_ROOT, '.codex/agents')
const LEGACY_CLAUDE_AGENTS_DIR = path.join(REPO_ROOT, '.claude/agents')
const PROMPT_UPGRADE_MODE = process.env.FORGE_PROMPT_UPGRADE_MODE?.trim() || 'keep'

type PromptUpgradeMode = 'keep' | 'overwrite'

interface ParsedAgent {
  agentType: string
  displayName: string
  description: string
  model: string | null
  systemPrompt: string
  fileName: string
  source: 'codex' | 'claude'
}

function isValidAgentType(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/.test(value)
}

function assertRegularPromptFileSync(filePath: string): void {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) {
    throw new Error(`[seed-agents] Refusing to read symlinked prompt file: ${filePath}`)
  }
  if (!stat.isFile()) {
    throw new Error(`[seed-agents] Prompt path is not a regular file: ${filePath}`)
  }
}

function promptUpgradeMode(): PromptUpgradeMode {
  if (PROMPT_UPGRADE_MODE === 'keep' || PROMPT_UPGRADE_MODE === 'overwrite') return PROMPT_UPGRADE_MODE
  throw new Error('[seed-agents] FORGE_PROMPT_UPGRADE_MODE must be keep or overwrite.')
}

/**
 * Parse a .md file with YAML frontmatter delimited by '---' lines.
 * Returns the name, model (if present), and body as systemPrompt.
 */
function parseClaudeAgentFile(filePath: string): ParsedAgent | null {
  assertRegularPromptFileSync(filePath)
  const raw = fs.readFileSync(filePath, 'utf-8')
  const fileName = path.basename(filePath)

  // Frontmatter must start at position 0 with '---'
  if (!raw.startsWith('---')) {
    console.warn(`[seed-agents] Skipping ${fileName}: no opening '---'`)
    return null
  }

  // Find the closing '---' (skip the first one at position 0)
  const closingIdx = raw.indexOf('\n---', 3)
  if (closingIdx === -1) {
    console.warn(`[seed-agents] Skipping ${fileName}: no closing '---'`)
    return null
  }

  const frontmatter = raw.slice(4, closingIdx).trim() // between the two '---' delimiters
  const body = raw.slice(closingIdx + 4).trim() // everything after closing '---\n'

  // Extract name: and model: from frontmatter (simple line-by-line parse)
  let agentType: string | null = null
  let model: string | null = null

  for (const line of frontmatter.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch) {
      agentType = nameMatch[1].trim()
      continue
    }
    const modelMatch = line.match(/^model:\s*(.+)$/)
    if (modelMatch) {
      model = modelMatch[1].trim()
    }
  }

  if (!agentType) {
    console.warn(`[seed-agents] Skipping ${fileName}: 'name:' field not found in frontmatter`)
    return null
  }
  if (!isValidAgentType(agentType)) {
    console.warn(`[seed-agents] Skipping ${fileName}: invalid agent type '${agentType}'`)
    return null
  }

  if (!body) {
    console.warn(`[seed-agents] Skipping ${fileName}: body (systemPrompt) is empty`)
    return null
  }

  return {
    agentType,
    displayName: displayNameForSlug(agentType),
    description: '',
    model,
    systemPrompt: body,
    fileName,
    source: 'claude',
  }
}

function decodeTomlEscape(raw: string, index: number): { value: string; nextIndex: number } {
  const marker = raw[index]
  switch (marker) {
    case 'b':
      return { value: '\b', nextIndex: index + 1 }
    case 't':
      return { value: '\t', nextIndex: index + 1 }
    case 'n':
      return { value: '\n', nextIndex: index + 1 }
    case 'f':
      return { value: '\f', nextIndex: index + 1 }
    case 'r':
      return { value: '\r', nextIndex: index + 1 }
    case '"':
    case '\\':
      return { value: marker, nextIndex: index + 1 }
    case 'u': {
      const hex = raw.slice(index + 1, index + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { value: String.fromCodePoint(parseInt(hex, 16)), nextIndex: index + 5 }
      }
      return { value: marker, nextIndex: index + 1 }
    }
    case 'U': {
      const hex = raw.slice(index + 1, index + 9)
      if (/^[0-9a-fA-F]{8}$/.test(hex)) {
        return { value: String.fromCodePoint(parseInt(hex, 16)), nextIndex: index + 9 }
      }
      return { value: marker, nextIndex: index + 1 }
    }
    default:
      return { value: marker, nextIndex: index + 1 }
  }
}

function unescapeTomlBasicString(raw: string): string {
  let result = ''
  for (let index = 0; index < raw.length;) {
    const char = raw[index]
    if (char !== '\\') {
      result += char
      index += 1
      continue
    }
    const decoded = decodeTomlEscape(raw, index + 1)
    result += decoded.value
    index = decoded.nextIndex
  }
  return result
}

export function parseTomlString(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key}\\s*=\\s*"`, 'm'))
  if (!match || match.index === undefined) return null

  let result = ''
  for (let index = match.index + match[0].length; index < raw.length;) {
    const char = raw[index]
    if (char === '"') return result.trim()
    if (char === '\n' || char === '\r') return null
    if (char !== '\\') {
      result += char
      index += 1
      continue
    }
    const decoded = decodeTomlEscape(raw, index + 1)
    result += decoded.value
    index = decoded.nextIndex
  }

  return null
}

function parseTomlMultilineString(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key}\\s*=\\s*"""\\n?([\\s\\S]*?)\\n?"""`, 'm'))
  return match?.[1] ? unescapeTomlBasicString(match[1]).trim() : null
}

export function parseCodexAgentFile(filePath: string): ParsedAgent | null {
  assertRegularPromptFileSync(filePath)
  const raw = fs.readFileSync(filePath, 'utf-8')
  const fileName = path.basename(filePath)
  const agentType = parseTomlString(raw, 'name')
  const description = parseTomlString(raw, 'description') ?? ''
  const systemPrompt = parseTomlMultilineString(raw, 'developer_instructions')

  if (!agentType) {
    console.warn(`[seed-agents] Skipping ${fileName}: 'name' field not found`)
    return null
  }
  if (!isValidAgentType(agentType)) {
    console.warn(`[seed-agents] Skipping ${fileName}: invalid agent type '${agentType}'`)
    return null
  }
  const fileAgentType = path.basename(filePath, AGENT_PROMPT_EXTENSION)
  if (agentType !== fileAgentType) {
    console.warn(`[seed-agents] Skipping ${fileName}: name must match file name '${fileAgentType}'`)
    return null
  }

  if (!systemPrompt) {
    console.warn(`[seed-agents] Skipping ${fileName}: developer_instructions is empty`)
    return null
  }

  return {
    agentType,
    displayName: displayNameForSlug(agentType),
    description,
    model: null,
    systemPrompt,
    fileName,
    source: 'codex',
  }
}

function repoDefaultPromptFiles(): string[] {
  if (!fs.existsSync(CODEX_AGENTS_DIR)) return []
  return fs
    .readdirSync(CODEX_AGENTS_DIR)
    .filter((f) => f.endsWith(AGENT_PROMPT_EXTENSION))
    .sort()
    .map((f) => path.join(CODEX_AGENTS_DIR, f))
}

async function backupPromptFile(
  filePath: string,
  workspaceRoot: string,
  backupsRoot: string,
): Promise<void> {
  const content = await readWorkspacePromptFile(filePath, workspaceRoot)
  if (content === null) return

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupsRoot, 'prompts', timestamp, path.basename(filePath))
  await writeWorkspaceFileAtomically(backupPath, content, workspaceRoot)
}

async function bootstrapWorkspacePrompts(): Promise<string> {
  const workspace = await getWorkspaceSettings()
  const mode = promptUpgradeMode()
  const defaultFiles = repoDefaultPromptFiles()
  if (defaultFiles.length === 0) {
    console.warn('[seed-agents] No repository .codex/agents/*.toml defaults found.')
    return workspace.agentPromptsRoot
  }

  for (const sourcePath of defaultFiles) {
    assertRegularPromptFileSync(sourcePath)
    const agentType = path.basename(sourcePath, AGENT_PROMPT_EXTENSION)
    const targetPath = agentPromptFilePath(workspace.agentPromptsRoot, agentType)
    const existing = await readWorkspacePromptFile(targetPath, workspace.workspaceRoot)
    if (existing !== null && mode === 'keep') continue
    if (existing !== null && mode === 'overwrite') {
      await backupPromptFile(targetPath, workspace.workspaceRoot, workspace.backupsRoot)
    }
    await writeWorkspaceFileAtomically(
      targetPath,
      await fsp.readFile(sourcePath, 'utf-8'),
      workspace.workspaceRoot,
    )
  }

  return workspace.agentPromptsRoot
}

function loadAgentFiles(dir: string): ParsedAgent[] {
  const extension = AGENT_PROMPT_EXTENSION
  const parser = parseCodexAgentFile

  if (!fs.existsSync(dir)) {
    throw new Error(`[seed-agents] Agents directory not found: ${dir}`)
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(extension))
    .sort()
    .map((f) => path.join(dir, f))

  if (files.length === 0) {
    const legacyFiles = fs.existsSync(LEGACY_CLAUDE_AGENTS_DIR)
      ? fs
        .readdirSync(LEGACY_CLAUDE_AGENTS_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => path.join(LEGACY_CLAUDE_AGENTS_DIR, f))
      : []
    if (legacyFiles.length === 0) {
      console.warn('[seed-agents] No agent files found in', dir)
      return []
    }
    return legacyFiles.flatMap((filePath) => {
      const parsedAgent = parseClaudeAgentFile(filePath)
      return parsedAgent ? [parsedAgent] : []
    })
  }

  const parsed: ParsedAgent[] = []
  for (const filePath of files) {
    const agent = parser(filePath)
    if (!agent) continue

    parsed.push(agent)
  }

  return parsed
}

function repoDefaultAgentTypes(): Set<string> {
  return new Set(
    repoDefaultPromptFiles().map((filePath) => path.basename(filePath, AGENT_PROMPT_EXTENSION)),
  )
}

export async function seedAgentConfigs(): Promise<void> {
  const agentPromptDir = await bootstrapWorkspacePrompts()
  const parsed = loadAgentFiles(agentPromptDir)
  const repositoryDefaults = repoDefaultAgentTypes()

  if (parsed.length === 0) {
    console.warn('[seed-agents] No valid agent files parsed — nothing to seed')
    return
  }

  console.log(`[seed-agents] Seeding ${parsed.length} agent(s)...`)

  const seededIdByType = new Map<string, string>()

  for (const agent of parsed) {
    const isRepositoryDefault = repositoryDefaults.has(agent.agentType)
    const [row] = await db
      .insert(agentConfigs)
      .values({
        agentType: agent.agentType,
        displayName: agent.displayName,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        isSystem: isRepositoryDefault,
        isActive: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agentConfigs.agentType,
        set: {
          displayName: agent.displayName,
          description: agent.description,
          systemPrompt: agent.systemPrompt,
          isSystem: isRepositoryDefault,
          ...(isRepositoryDefault && {
            isActive: true,
          }),
          updatedAt: new Date(),
        },
      })
      .returning({ id: agentConfigs.id })

    if (row?.id && isRepositoryDefault) seededIdByType.set(agent.agentType, row.id)

    const modelInfo = agent.model ? ` (model: ${agent.model})` : ''
    const seedType = isRepositoryDefault ? 'system' : 'workspace'
    console.log(`[seed-agents]   ✓ ${agent.agentType}${modelInfo}  [${seedType}:${agent.source}:${agent.fileName}]`)
  }

  // Workforces are editable operator configuration. By default ('keep') the seed
  // only creates missing default templates and never overwrites an existing
  // workforce's name/description/default flag or membership, so reruns and
  // upgrades preserve operator edits. Only the explicit reset path
  // (FORGE_PROMPT_UPGRADE_MODE=overwrite) restores repository defaults.
  const workforceUpgradeMode = promptUpgradeMode()
  for (const definition of DEFAULT_WORKFORCES) {
    const members = resolveWorkforceMembers(definition.roles, seededIdByType)
    if (members.length === 0) continue

    const setMembers = async (workforceId: string) => {
      await db.delete(workforceAgents).where(eq(workforceAgents.workforceId, workforceId))
      await db.insert(workforceAgents).values(
        members.map((member) => ({
          workforceId,
          agentConfigId: member.agentConfigId,
          roleLabel: member.roleLabel,
          sequence: member.sequence,
          isRequired: member.isRequired,
          metadata: member.metadata,
          updatedAt: new Date(),
        })),
      )
    }

    const workforceHasMembers = async (workforceId: string): Promise<boolean> => {
      const [member] = await db
        .select({ id: workforceAgents.id })
        .from(workforceAgents)
        .where(eq(workforceAgents.workforceId, workforceId))
        .limit(1)
      return Boolean(member)
    }

    const values = {
      slug: definition.slug,
      displayName: definition.displayName,
      description: definition.description,
      isDefault: definition.isDefault,
      isActive: true,
      updatedAt: new Date(),
    }

    if (workforceUpgradeMode === 'overwrite') {
      const [workforce] = await db
        .insert(workforces)
        .values(values)
        .onConflictDoUpdate({ target: workforces.slug, set: values })
        .returning({ id: workforces.id })
      if (workforce?.id) {
        await setMembers(workforce.id)
        console.log(`[seed-agents]   ✓ ${definition.slug} workforce reset (${members.length} agent(s))`)
      }
      continue
    }

    const [created] = await db
      .insert(workforces)
      .values(values)
      .onConflictDoNothing({ target: workforces.slug })
      .returning({ id: workforces.id })

    if (created?.id) {
      await setMembers(created.id)
      console.log(`[seed-agents]   ✓ ${definition.slug} workforce (${members.length} agent(s))`)
    } else {
      const [existing] = await db
        .select({ id: workforces.id })
        .from(workforces)
        .where(eq(workforces.slug, definition.slug))
        .limit(1)
      if (existing?.id && !await workforceHasMembers(existing.id)) {
        await setMembers(existing.id)
        console.log(`[seed-agents]   ✓ ${definition.slug} workforce backfilled (${members.length} agent(s))`)
      } else {
        console.log(`[seed-agents]   • ${definition.slug} workforce exists — preserved`)
      }
    }
  }

  await exportWorkforcesToWorkspace()
  console.log('[seed-agents]   ✓ exported workspace workforce files')

  console.log('[seed-agents] Done.')
}

if (require.main === module) {
  seedAgentConfigs()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-agents] Fatal error:', err)
      process.exit(1)
    })
}
