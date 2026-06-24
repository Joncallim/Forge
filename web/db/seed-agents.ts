/**
 * Seed app agent configurations from .codex/agents/*.toml.
 *
 * Falls back to legacy .claude/agents/*.md files if the Codex directory is not
 * present. Seeded agents are defaults only; users can add their own agents and
 * assign them to editable workforces in the web UI.
 *
 * Run with: npx tsx db/seed-agents.ts
 * Or via:   npm run db:seed-agents
 *
 * This script upserts rows into agent_configs, inserting on first run and
 * updating systemPrompt + updatedAt on subsequent runs.
 */

import '../lib/load-env'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from './index'
import { agentConfigs, workforceAgents, workforces } from './schema'

const REPO_ROOT = path.resolve(__dirname, '../..')
const CODEX_AGENTS_DIR = path.join(REPO_ROOT, '.codex/agents')
const LEGACY_CLAUDE_AGENTS_DIR = path.join(REPO_ROOT, '.claude/agents')
interface ParsedAgent {
  agentType: string
  displayName: string
  description: string
  model: string | null
  systemPrompt: string
  fileName: string
  source: 'codex' | 'claude'
}

/**
 * Parse a .md file with YAML frontmatter delimited by '---' lines.
 * Returns the name, model (if present), and body as systemPrompt.
 */
function parseClaudeAgentFile(filePath: string): ParsedAgent | null {
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

function parseTomlString(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))
  return match?.[1]?.trim() ?? null
}

function parseTomlMultilineString(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key}\\s*=\\s*"""\\n?([\\s\\S]*?)\\n?"""`, 'm'))
  return match?.[1]?.trim() ?? null
}

function parseCodexAgentFile(filePath: string): ParsedAgent | null {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const fileName = path.basename(filePath)
  const agentType = parseTomlString(raw, 'name')
  const description = parseTomlString(raw, 'description') ?? ''
  const systemPrompt = parseTomlMultilineString(raw, 'developer_instructions')

  if (!agentType) {
    console.warn(`[seed-agents] Skipping ${fileName}: 'name' field not found`)
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

function displayNameForSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function loadAgentFiles(): ParsedAgent[] {
  const useCodex = fs.existsSync(CODEX_AGENTS_DIR)
  const dir = useCodex ? CODEX_AGENTS_DIR : LEGACY_CLAUDE_AGENTS_DIR
  const extension = useCodex ? '.toml' : '.md'
  const parser = useCodex ? parseCodexAgentFile : parseClaudeAgentFile

  if (!fs.existsSync(dir)) {
    console.error(`[seed-agents] Agents directory not found: ${dir}`)
    process.exit(1)
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(extension))
    .map((f) => path.join(dir, f))

  if (files.length === 0) {
    console.warn('[seed-agents] No agent files found in', dir)
    process.exit(0)
  }

  const parsed: ParsedAgent[] = []
  for (const filePath of files) {
    const agent = parser(filePath)
    if (!agent) continue

    parsed.push(agent)
  }

  return parsed
}

async function main() {
  const parsed = loadAgentFiles()

  if (parsed.length === 0) {
    console.warn('[seed-agents] No valid agent files parsed — nothing to seed')
    process.exit(0)
  }

  console.log(`[seed-agents] Seeding ${parsed.length} agent(s)...`)

  const seededAgentIds: string[] = []

  for (const agent of parsed) {
    const [row] = await db
      .insert(agentConfigs)
      .values({
        agentType: agent.agentType,
        displayName: agent.displayName,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        isSystem: true,
        isActive: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agentConfigs.agentType,
        set: {
          displayName: agent.displayName,
          description: agent.description,
          systemPrompt: agent.systemPrompt,
          isSystem: true,
          isActive: true,
          updatedAt: new Date(),
        },
      })
      .returning({ id: agentConfigs.id })

    if (row?.id) seededAgentIds.push(row.id)

    const modelInfo = agent.model ? ` (model: ${agent.model})` : ''
    console.log(`[seed-agents]   ✓ ${agent.agentType}${modelInfo}  [${agent.source}:${agent.fileName}]`)
  }

  if (seededAgentIds.length > 0) {
    const [workforce] = await db
      .insert(workforces)
      .values({
        slug: 'core-delivery',
        displayName: 'Core delivery',
        description: 'Default workforce seeded from the repository agent prompts.',
        isDefault: true,
        isActive: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workforces.slug,
        set: {
          displayName: 'Core delivery',
          description: 'Default workforce seeded from the repository agent prompts.',
          isDefault: true,
          isActive: true,
          updatedAt: new Date(),
        },
      })
      .returning({ id: workforces.id })

    if (workforce?.id) {
      await db.delete(workforceAgents).where(eq(workforceAgents.workforceId, workforce.id))
      await db.insert(workforceAgents).values(
        seededAgentIds.map((agentConfigId, index) => ({
          workforceId: workforce.id,
          agentConfigId,
          sequence: index + 1,
          isRequired: true,
          updatedAt: new Date(),
        })),
      )
      console.log(`[seed-agents]   ✓ core-delivery workforce (${seededAgentIds.length} agent(s))`)
    }
  }

  console.log('[seed-agents] Done.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[seed-agents] Fatal error:', err)
  process.exit(1)
})
