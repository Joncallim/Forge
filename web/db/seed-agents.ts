/**
 * Seed agent configurations from .claude/agents/*.md frontmatter.
 *
 * Run with: npx tsx db/seed-agents.ts
 * Or via:   npm run db:seed-agents
 *
 * Each agent .md file has YAML frontmatter between the first and second '---'
 * lines. We parse the `name:` field as the agentType and take everything after
 * the second '---' as the systemPrompt. The `model:` field is extracted for
 * informational logging only — it is stored in providerConfigs, not here.
 *
 * This script upserts rows into agent_configs, inserting on first run and
 * updating systemPrompt + updatedAt on subsequent runs.
 */

import fs from 'node:fs'
import path from 'node:path'
import { db } from './index'
import { agentConfigs } from './schema'
import { eq } from 'drizzle-orm'

// Agents directory is two levels above web/ (repo root .claude/agents/)
const AGENTS_DIR = path.resolve(__dirname, '../../.claude/agents')

interface ParsedAgent {
  agentType: string
  model: string | null
  systemPrompt: string
  fileName: string
}

/**
 * Parse a .md file with YAML frontmatter delimited by '---' lines.
 * Returns the name, model (if present), and body as systemPrompt.
 */
function parseAgentFile(filePath: string): ParsedAgent | null {
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

  return { agentType, model, systemPrompt: body, fileName }
}

async function main() {
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`[seed-agents] Agents directory not found: ${AGENTS_DIR}`)
    process.exit(1)
  }

  const mdFiles = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(AGENTS_DIR, f))

  if (mdFiles.length === 0) {
    console.warn('[seed-agents] No .md files found in', AGENTS_DIR)
    process.exit(0)
  }

  const parsed: ParsedAgent[] = []
  for (const filePath of mdFiles) {
    const agent = parseAgentFile(filePath)
    if (agent) {
      parsed.push(agent)
    }
  }

  if (parsed.length === 0) {
    console.warn('[seed-agents] No valid agent files parsed — nothing to seed')
    process.exit(0)
  }

  console.log(`[seed-agents] Seeding ${parsed.length} agent(s)...`)

  for (const agent of parsed) {
    await db
      .insert(agentConfigs)
      .values({
        agentType: agent.agentType,
        systemPrompt: agent.systemPrompt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agentConfigs.agentType,
        set: {
          systemPrompt: agent.systemPrompt,
          updatedAt: new Date(),
        },
      })

    const modelInfo = agent.model ? ` (model: ${agent.model})` : ''
    console.log(`[seed-agents]   ✓ ${agent.agentType}${modelInfo}  [${agent.fileName}]`)
  }

  console.log('[seed-agents] Done.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[seed-agents] Fatal error:', err)
  process.exit(1)
})
