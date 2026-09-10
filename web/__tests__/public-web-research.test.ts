import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { publicWebResearchEnabled, researchPublicTopic } from '@/lib/research/public-web'
import { buildWebResearchContext } from '@/worker/architect-context'

const SENTINEL = 'PRIVATE_TASK_PROMPT_PROJECT_REPOSITORY_ARTIFACT_SECRET'
const originalFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  globalThis.fetch = originalFetch
})

describe('public web research privacy boundary', () => {
  it.each([undefined, '', '0', 'true', 'yes', ' 1 ', '2'])('fails closed for %j', (value) => {
    if (value === undefined) vi.stubEnv('FORGE_AGENT_WEB_SEARCH', '')
    else vi.stubEnv('FORGE_AGENT_WEB_SEARCH', value)
    expect(publicWebResearchEnabled()).toBe(false)
  })

  it('requires the single explicit opt-in value', () => {
    vi.stubEnv('FORGE_AGENT_WEB_SEARCH', '1')
    expect(publicWebResearchEnabled()).toBe(true)
  })

  it('makes no request when disabled, including with private task-like sentinels in process state', async () => {
    vi.stubEnv('FORGE_AGENT_WEB_SEARCH', '0')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    process.env.UNRELATED_PRIVATE_CONTEXT = SENTINEL

    const context = await buildWebResearchContext()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(context).toContain('disabled')
    delete process.env.UNRELATED_PRIVATE_CONTEXT
  })

  it('sends only a trusted static query after explicit opt-in and marks returned text untrusted', async () => {
    vi.stubEnv('FORGE_AGENT_WEB_SEARCH', '1')
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      AbstractText: 'ordinary result',
      AbstractURL: 'https://example.test/reference',
      Heading: 'Reference',
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)

    const context = await buildWebResearchContext()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toContain('api.duckduckgo.com')
    expect(url.searchParams.get('q')).toBe('software engineering reliability accessibility testing best practices')
    expect(url.toString()).not.toContain(SENTINEL)
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
    expect(context).toContain('UNTRUSTED DATA')
    expect(context).toContain('ordinary result')
  })

  it('rejects redirects, non-JSON, oversized bodies, and unsafe result links without exposing request data', async () => {
    const cases = [
      new Response('not json', { headers: { 'content-type': 'text/html' } }),
      new Response('x'.repeat(70 * 1024), { headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ AbstractText: 'bad', AbstractURL: `javascript:${SENTINEL}` }), { headers: { 'content-type': 'application/json' } }),
    ]
    for (const response of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      await expect(researchPublicTopic('software_engineering_basics')).resolves.toEqual([])
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`redirect ${SENTINEL}`)))
    await expect(researchPublicTopic('software_engineering_basics')).resolves.toEqual([])
  })

  it('keeps the DuckDuckGo constructor and environment interpretation inside the common boundary', () => {
    const root = path.resolve(__dirname, '..')
    const architect = fs.readFileSync(path.join(root, 'worker/architect-context.ts'), 'utf8')
    const evaluation = fs.readFileSync(path.join(root, 'lib/agent-evaluation.ts'), 'utf8')
    const client = fs.readFileSync(path.join(root, 'lib/research/public-web/client.ts'), 'utf8')

    expect(architect).not.toContain('FORGE_AGENT_WEB_SEARCH')
    expect(evaluation).not.toContain('FORGE_AGENT_WEB_SEARCH')
    expect(architect).not.toContain('duckduckgo.com')
    expect(evaluation).not.toContain('duckduckgo.com')
    expect(client).toContain("redirect: 'error'")
  })
})
