import type { projects, Task } from '../db/schema'

type TaskRow = Task
type ProjectRow = typeof projects.$inferSelect

type SearchResult = {
  title: string
  url: string
  snippet: string
}

type DuckDuckGoTopic = {
  Text?: string
  FirstURL?: string
  Topics?: DuckDuckGoTopic[]
}

type DuckDuckGoResponse = {
  AbstractText?: string
  AbstractURL?: string
  Heading?: string
  Answer?: string
  RelatedTopics?: DuckDuckGoTopic[]
}

type SoftwareProfile = {
  type: string
  persona: string
  specialists: string[]
  searchQueries: string[]
}

const PROFILE_LIBRARY: Array<SoftwareProfile & { patterns: RegExp[] }> = [
  {
    type: 'game',
    patterns: [/\bgame\b/i, /\bunity\b/i, /\bgodot\b/i, /\bphaser\b/i, /\bplayable\b/i],
    persona: 'Game director and technical game designer focused on mechanics, loops, feel, progression, content pipeline, performance, and playtestability.',
    specialists: [
      'Game designer',
      'Gameplay engineer',
      'Level/content designer',
      'Game UI/UX designer',
      'Performance QA',
      'Audio/visual polish specialist',
    ],
    searchQueries: ['HTML5 game design implementation patterns', 'game feel mechanics prototyping checklist'],
  },
  {
    type: 'web_frontend',
    patterns: [/\bfrontend\b/i, /\bfront-end\b/i, /\bUI\b/, /\bReact\b/i, /\bNext\.?js\b/i, /\bpage\b/i],
    persona: 'Product-minded frontend architect focused on interaction design, responsive layout, accessibility, component boundaries, visual hierarchy, and state management.',
    specialists: [
      'UX flow designer',
      'Web design specialist',
      'React implementation specialist',
      'Accessibility specialist',
      'Frontend performance specialist',
      'Visual QA reviewer',
    ],
    searchQueries: ['modern web accessibility checklist', 'React UI architecture state management patterns'],
  },
  {
    type: 'backend_api',
    patterns: [/\bAPI\b/, /\bbackend\b/i, /\bdatabase\b/i, /\bschema\b/i, /\bauth\b/i, /\bqueue\b/i],
    persona: 'Backend systems architect focused on API contracts, data integrity, authorization, observability, migrations, reliability, and operability.',
    specialists: [
      'API specialist',
      'Database specialist',
      'Auth/security specialist',
      'Integration specialist',
      'Unit test specialist',
      'Security reviewer',
    ],
    searchQueries: ['API design reliability checklist', 'database migration backward compatibility best practices'],
  },
  {
    type: 'marketing_or_content',
    patterns: [/\bmarketing\b/i, /\bcampaign\b/i, /\bad\b/i, /\bcopy\b/i, /\blanding\b/i, /\bpositioning\b/i],
    persona: 'Growth and marketing systems planner focused on audience, offer clarity, campaign surfaces, messaging tests, analytics, and brand consistency.',
    specialists: [
      'Positioning strategist',
      'Copywriter',
      'Landing page designer',
      'Creative producer',
      'Analytics specialist',
      'Brand reviewer',
    ],
    searchQueries: ['landing page conversion copy framework', 'marketing campaign analytics measurement plan'],
  },
  {
    type: 'devops_install',
    patterns: [/\binstall\b/i, /\bdeploy\b/i, /\bCI\b/, /\bDocker\b/i, /\bmigration\b/i, /\bdoctor\b/i],
    persona: 'DevOps and local-install architect focused on reproducibility, diagnostics, rollback, service lifecycle, logs, and operator recovery.',
    specialists: [
      'Local install specialist',
      'CI specialist',
      'Deployment specialist',
      'Documentation specialist',
      'Regression QA',
      'Release manager',
    ],
    searchQueries: ['developer tool installer UX checklist', 'local development service health check best practices'],
  },
]

const GENERAL_PROFILE: SoftwareProfile = {
  type: 'general_software',
  persona: 'Senior product and software architect focused on requirements, modular design, implementation sequencing, verification, and risk reduction.',
  specialists: [
    'Product planner',
    'Requirements analyst',
    'Implementation specialist',
    'QA specialist',
    'Documentation specialist',
    'Reviewer',
  ],
  searchQueries: ['software architecture decision record checklist'],
}

function flattenTopics(topics: DuckDuckGoTopic[] = []): SearchResult[] {
  const results: SearchResult[] = []
  for (const topic of topics) {
    if (topic.Topics) {
      results.push(...flattenTopics(topic.Topics))
      continue
    }
    if (!topic.Text || !topic.FirstURL) continue
    results.push({
      title: topic.Text.split(' - ')[0] ?? topic.Text,
      url: topic.FirstURL,
      snippet: topic.Text,
    })
  }
  return results
}

async function searchWeb(query: string): Promise<SearchResult[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4_000)

  try {
    const url = new URL('https://api.duckduckgo.com/')
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('no_html', '1')
    url.searchParams.set('skip_disambig', '1')

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return []

    const data = await response.json() as DuckDuckGoResponse
    const results: SearchResult[] = []
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
      })
    }
    if (data.Answer) {
      results.push({
        title: query,
        url: data.AbstractURL || 'https://duckduckgo.com/',
        snippet: data.Answer,
      })
    }
    results.push(...flattenTopics(data.RelatedTopics))
    return results.slice(0, 3)
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

export function detectSoftwareProfile(task: TaskRow, project: ProjectRow): SoftwareProfile {
  const text = `${project.name}\n${task.title}\n${task.prompt}`
  return PROFILE_LIBRARY.find((profile) => profile.patterns.some((pattern) => pattern.test(text))) ?? GENERAL_PROFILE
}

export async function buildWebResearchContext(profile: SoftwareProfile, task: TaskRow): Promise<string> {
  if (process.env.FORGE_AGENT_WEB_SEARCH === '0') {
    return 'Web research: disabled by FORGE_AGENT_WEB_SEARCH=0.'
  }

  const queries = [
    `${task.title} ${profile.type} best practices`,
    ...profile.searchQueries,
  ].slice(0, 3)

  const groups = await Promise.all(queries.map(async (query) => ({
    query,
    results: await searchWeb(query),
  })))

  const lines = ['Web research context:']
  for (const group of groups) {
    lines.push(`- Query: ${group.query}`)
    if (group.results.length === 0) {
      lines.push('  - No results returned.')
      continue
    }
    for (const result of group.results) {
      lines.push(`  - ${result.title}: ${result.snippet} (${result.url})`)
    }
  }

  return lines.join('\n')
}

export function buildSpecialistContext(profile: SoftwareProfile): string {
  return [
    `Detected work type: ${profile.type}`,
    `Lens to design through: ${profile.persona}`,
    '',
    'Forge has exactly these worker agents. Every implementation handoff MUST be assigned to one of them, using the [Role] tag verbatim:',
    '- [Architect] — only when a step needs further design (API contract, data model, ADR) before it can be built',
    '- [Backend] — server code, APIs, database/migrations, background jobs, scripts, CLI tooling',
    '- [Frontend] — UI components, client-side state, routing, styling, calling APIs',
    '- [QA] — tests and coverage for the work produced above',
    '- [Reviewer] — security, correctness, and performance review before merge',
    '- [DevOps] — Docker, CI/CD, install/deploy scripts, environment configuration',
    '',
    'Do NOT invent specialist job titles such as "UX flow designer" or "React implementation specialist". Fold those concerns into the matching agent above. The detected lens and the considerations below are framing only — they are not agents.',
    '',
    `Considerations worth weighing for ${profile.type} work (attach each to whichever agent above owns it, and skip any that do not apply to this specific task):`,
    ...profile.specialists.map((specialist) => `- ${specialist}`),
    '',
    'Assign work to the smallest set of agents the task actually needs. Many small tasks need only one implementation agent plus [QA] and [Reviewer]. For each handoff, state whether it needs repository inspection, implementation, or verification.',
  ].join('\n')
}
