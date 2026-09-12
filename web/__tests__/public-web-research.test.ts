import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { publicWebResearchEnabled, researchPublicTopic } from '@/lib/research/public-web'
import { buildWebResearchContext } from '@/worker/architect-context'

const SENTINEL = 'PRIVATE_TASK_PROMPT_PROJECT_REPOSITORY_ARTIFACT_SECRET'
const originalFetch = globalThis.fetch

afterEach(() => {
  vi.useRealTimers()
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

  it('does not start or continue public search after the owning workflow is cancelled', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(researchPublicTopic('software_engineering_basics', preAborted.signal)).resolves.toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()

    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true })
    })))

    const research = researchPublicTopic('software_engineering_basics', controller.signal)
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    controller.abort(new Error('architect claim lost'))

    await expect(research).resolves.toEqual([])
    expect(requestSignal?.aborted).toBe(true)
  })

  it('retains the four-second request bound when no external cancellation occurs', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true })
    })))

    const research = researchPublicTopic('software_engineering_basics', new AbortController().signal)
    expect(requestSignal).toBeDefined()

    await vi.advanceTimersByTimeAsync(4_000)
    await expect(research).resolves.toEqual([])
    expect(requestSignal?.aborted).toBe(true)
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

  it('keeps the DuckDuckGo constructor and environment parser inside the common boundary repo-wide', () => {
    const repositoryRoot = path.resolve(__dirname, '../..')
    const permitted = new Set([
      'web/lib/research/public-web/client.ts',
      'web/lib/research/public-web/config.ts',
      'web/__tests__/public-web-research.test.ts',
      'web/__tests__/orchestrator-eval.test.ts',
    ])
    const sourceFiles: string[] = []
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.next') continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(absolute)
        else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) sourceFiles.push(absolute)
      }
    }
    walk(repositoryRoot)

    for (const absolute of sourceFiles) {
      const relative = path.relative(repositoryRoot, absolute)
      if (permitted.has(relative)) continue
      const source = fs.readFileSync(absolute, 'utf8')
      expect(source, relative).not.toMatch(/api\.duckduckgo\.com|process\.env\.FORGE_AGENT_WEB_SEARCH/)
    }

    const client = fs.readFileSync(path.join(repositoryRoot, 'web/lib/research/public-web/client.ts'), 'utf8')
    expect(client).toContain("redirect: 'error'")
  })
})
