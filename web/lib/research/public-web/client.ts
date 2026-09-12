import { PUBLIC_RESEARCH_TOPICS, type PublicResearchTopicId } from './topics'

const ENDPOINT = 'https://api.duckduckgo.com/'
const TIMEOUT_MS = 4_000
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_RESULTS = 3
const MAX_TOPIC_DEPTH = 4
const MAX_FIELD_LENGTH = 500

export type PublicWebResult = Readonly<{ title: string; url: string; snippet: string }>

type DuckDuckGoTopic = { Text?: unknown; FirstURL?: unknown; Topics?: unknown }
type DuckDuckGoResponse = {
  AbstractText?: unknown
  AbstractURL?: unknown
  Heading?: unknown
  Answer?: unknown
  RelatedTopics?: unknown
}

function boundedText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : null
}

function publicHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function topicResults(topics: unknown, depth = 0): PublicWebResult[] {
  if (!Array.isArray(topics) || depth > MAX_TOPIC_DEPTH) return []
  const results: PublicWebResult[] = []
  for (const topic of topics.slice(0, MAX_RESULTS * 4)) {
    if (!topic || typeof topic !== 'object') continue
    const value = topic as DuckDuckGoTopic
    if (Array.isArray(value.Topics)) {
      results.push(...topicResults(value.Topics, depth + 1))
      if (results.length >= MAX_RESULTS) break
      continue
    }
    const snippet = boundedText(value.Text)
    const url = publicHttpUrl(value.FirstURL)
    if (!snippet || !url) continue
    results.push({ title: snippet.split(' - ')[0]?.slice(0, MAX_FIELD_LENGTH) || snippet, url, snippet })
    if (results.length >= MAX_RESULTS) break
  }
  return results
}

async function boundedJson(response: Response): Promise<DuckDuckGoResponse | null> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json') || !response.body) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks))
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as DuckDuckGoResponse : null
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

/**
 * The only pre-#335 public-search egress seam. It accepts a trusted closed
 * topic ID, never caller-provided text, and returns untrusted evidence only.
 */
export async function researchPublicTopic(
  topicId: PublicResearchTopicId,
  externalSignal?: AbortSignal,
): Promise<readonly PublicWebResult[]> {
  // Do not even construct a request after the owning workflow has been cancelled.
  if (externalSignal?.aborted) return []

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const abortForExternalSignal = (): void => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    externalSignal.addEventListener('abort', abortForExternalSignal, { once: true })
  }
  try {
    if (controller.signal.aborted) return []
    const url = new URL(ENDPOINT)
    url.searchParams.set('q', PUBLIC_RESEARCH_TOPICS[topicId])
    url.searchParams.set('format', 'json')
    url.searchParams.set('no_html', '1')
    url.searchParams.set('skip_disambig', '1')
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (!response.ok) return []
    const data = await boundedJson(response)
    if (!data) return []
    const results: PublicWebResult[] = []
    const abstract = boundedText(data.AbstractText)
    const abstractUrl = publicHttpUrl(data.AbstractURL)
    if (abstract && abstractUrl) {
      results.push({ title: boundedText(data.Heading) ?? 'Public web result', url: abstractUrl, snippet: abstract })
    }
    const answer = boundedText(data.Answer)
    if (answer && abstractUrl && results.length < MAX_RESULTS) {
      results.push({ title: 'Public web result', url: abstractUrl, snippet: answer })
    }
    results.push(...topicResults(data.RelatedTopics))
    return results.slice(0, MAX_RESULTS)
  } catch {
    // Deliberately do not expose request details: a future policy may authorize sensitive terms.
    return []
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortForExternalSignal)
  }
}
