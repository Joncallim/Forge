/**
 * Planned agent breakdown parsing
 * ------------------------------------------------------------------------
 * The architect emits a machine-readable block summarizing the worker roles
 * requested by the Markdown plan. Older plans may only contain `[Role]` task
 * tags, so this parser falls back to those tags when the structured block is
 * missing or malformed.
 */

export const AGENT_BREAKDOWN_FENCE = 'agent_breakdown_json'

export interface PlannedAgent {
  role: string
  tasks: number
  summary: string
}

export interface ParsedAgentBreakdown {
  planText: string
  agents: PlannedAgent[]
}

const FENCE_REGEX = new RegExp(
  '```' + AGENT_BREAKDOWN_FENCE + '\\s*\\n([\\s\\S]*?)\\n?```',
  'i',
)

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function normalizeAgents(raw: unknown): PlannedAgent[] {
  const items =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { agents?: unknown }).agents)
      ? (raw as { agents: unknown[] }).agents
      : []

  const byRole = new Map<string, PlannedAgent>()
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue

    const role = cleanText((item as { role?: unknown }).role, 40)
    if (role === '') continue

    const rawTasks = Number((item as { tasks?: unknown }).tasks)
    const tasks = Number.isInteger(rawTasks) && rawTasks > 0 ? rawTasks : 1
    const summary = cleanText((item as { summary?: unknown }).summary, 180)

    const existing = byRole.get(role)
    if (existing) {
      existing.tasks += tasks
      if (existing.summary === '' && summary !== '') existing.summary = summary
      continue
    }

    byRole.set(role, { role, tasks, summary })
  }

  return [...byRole.values()]
}

function fallbackAgentsFromRoleTags(planText: string): PlannedAgent[] {
  const byRole = new Map<string, { role: string; tasks: number; snippets: string[] }>()
  const lines = planText.split('\n')
  const roleLine = /(?:^|\s)\[([A-Za-z][A-Za-z0-9 /_-]{0,38})\]\s*(.+)$/u

  for (const line of lines) {
    const match = roleLine.exec(line)
    if (!match) continue

    const role = match[1].trim()
    const task = match[2]
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim()
    if (role === '') continue

    const existing = byRole.get(role) ?? { role, tasks: 0, snippets: [] }
    existing.tasks += 1
    if (task !== '' && existing.snippets.length < 2) existing.snippets.push(task)
    byRole.set(role, existing)
  }

  return [...byRole.values()].map((agent) => ({
    role: agent.role,
    tasks: agent.tasks,
    summary: agent.snippets.join('; ').slice(0, 180),
  }))
}

export function parseAgentBreakdown(rawText: string): ParsedAgentBreakdown {
  const match = FENCE_REGEX.exec(rawText)
  if (!match) {
    const planText = rawText.trim()
    return { planText, agents: fallbackAgentsFromRoleTags(planText) }
  }

  const jsonBlock = match[1]
  let agents: PlannedAgent[] = []
  try {
    agents = normalizeAgents(JSON.parse(jsonBlock))
  } catch {
    agents = []
  }

  const planText = rawText.replace(match[0], '').trim()
  return {
    planText,
    agents: agents.length > 0 ? agents : fallbackAgentsFromRoleTags(planText),
  }
}
