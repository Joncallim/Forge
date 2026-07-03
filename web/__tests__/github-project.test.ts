import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ROADMAP_FILE_CANDIDATES,
  createProjectIssue,
  fetchProjectRoadmap,
  isValidGitHubRepo,
  listProjectIssues,
} from '@/lib/github-project'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isValidGitHubRepo', () => {
  it('accepts owner/repo and rejects malformed values', () => {
    expect(isValidGitHubRepo('Joncallim/Forge')).toBe(true)
    expect(isValidGitHubRepo('owner/repo.name-1')).toBe(true)
    expect(isValidGitHubRepo('noslash')).toBe(false)
    expect(isValidGitHubRepo('a/b/c')).toBe(false)
    expect(isValidGitHubRepo('../etc/passwd')).toBe(false)
    expect(isValidGitHubRepo(null)).toBe(false)
  })
})

describe('fetchProjectRoadmap', () => {
  it('discovers roadmap files in priority order (docs/roadmap.md first)', () => {
    expect(ROADMAP_FILE_CANDIDATES.map((c) => c.path)).toEqual([
      'docs/roadmap.md',
      'ROADMAP.md',
      'docs/roadmap.json',
      'roadmap.json',
    ])
  })

  it('returns the first existing candidate and decodes base64 content', async () => {
    const fetchMock = vi.fn()
      // docs/roadmap.md -> 404
      .mockResolvedValueOnce(jsonResponse(404, {}))
      // ROADMAP.md -> found
      .mockResolvedValueOnce(jsonResponse(200, { encoding: 'base64', content: b64('# Plan\n- ship it') }))
    vi.stubGlobal('fetch', fetchMock)

    const roadmap = await fetchProjectRoadmap('token', 'owner/repo')
    expect(roadmap).toEqual({ path: 'ROADMAP.md', format: 'markdown', content: '# Plan\n- ship it' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/repos/owner/repo/contents/docs/roadmap.md')
  })

  it('returns null when no candidate exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, {}))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchProjectRoadmap('token', 'owner/repo')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(ROADMAP_FILE_CANDIDATES.length)
  })

  it('throws on a non-404 error instead of treating it as missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})))
    await expect(fetchProjectRoadmap('token', 'owner/repo')).rejects.toThrow(/500/)
  })
})

describe('listProjectIssues', () => {
  it('excludes pull requests and normalizes labels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, [
      {
        number: 5,
        title: 'A real issue',
        state: 'open',
        labels: [{ name: 'bug', color: 'ff0000' }, { name: '', color: null }],
        updated_at: '2026-07-01T00:00:00Z',
        html_url: 'https://github.com/owner/repo/issues/5',
        body: 'details',
      },
      {
        number: 6,
        title: 'A pull request',
        state: 'open',
        pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/6' },
      },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const issues = await listProjectIssues('token', 'owner/repo')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ number: 5, title: 'A real issue', state: 'open' })
    expect(issues[0].labels).toEqual([{ name: 'bug', color: 'ff0000' }])
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(403, {})))
    await expect(listProjectIssues('token', 'owner/repo')).rejects.toThrow(/403/)
  })
})

describe('createProjectIssue', () => {
  it('posts the title/body and returns the normalized issue', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, {
      number: 9,
      title: 'New one',
      state: 'open',
      updated_at: '2026-07-02T00:00:00Z',
      html_url: 'https://github.com/owner/repo/issues/9',
      body: 'body text',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const issue = await createProjectIssue('token', 'owner/repo', { title: 'New one', body: 'body text' })
    expect(issue).toMatchObject({ number: 9, title: 'New one', htmlUrl: 'https://github.com/owner/repo/issues/9' })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ title: 'New one', body: 'body text' })
  })

  it('rejects an empty title before calling the API', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createProjectIssue('token', 'owner/repo', { title: '   ' })).rejects.toThrow(/title is required/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
