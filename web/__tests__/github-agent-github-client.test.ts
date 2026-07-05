import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestGitHubClient } from '@/scripts/github-agent-workflow/io/github-client'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RestGitHubClient comment pagination', () => {
  it('updates an existing marker comment on a later page instead of creating a duplicate', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `Comment ${index + 1}`,
      user: { login: 'someone-else', type: 'User' },
      html_url: `https://github.com/owner/repo/issues/1#issuecomment-${index + 1}`,
    }))
    const markerComment = {
      id: 101,
      body: '<!-- forge-marker --> old body',
      user: { login: 'forge-bot', type: 'Bot' },
      html_url: 'https://github.com/owner/repo/issues/1#issuecomment-101',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, firstPage))
      .mockResolvedValueOnce(jsonResponse(200, [markerComment]))
      .mockResolvedValueOnce(jsonResponse(200, {
        ...markerComment,
        body: '<!-- forge-marker --> new body',
      }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new RestGitHubClient({ token: 'token', repo: 'owner/repo' })
    const updated = await client.upsertComment(1, {
      markerPrefix: '<!-- forge-marker -->',
      botLogin: 'forge-bot',
      body: '<!-- forge-marker --> new body',
    })

    expect(updated.id).toBe(101)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[0][0])).toContain('page=1')
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2')
    expect(String(fetchMock.mock.calls[2][0])).toContain('/issues/comments/101')
    expect(fetchMock.mock.calls[2][1]?.method).toBe('PATCH')
  })

  it('collects every comments page when listing issue comments', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        body: `Comment ${index + 1}`,
        user: { login: 'user', type: 'User' },
        html_url: `https://github.com/owner/repo/issues/1#issuecomment-${index + 1}`,
      }))))
      .mockResolvedValueOnce(jsonResponse(200, [{
        id: 101,
        body: 'Comment 101',
        user: { login: 'user', type: 'User' },
        html_url: 'https://github.com/owner/repo/issues/1#issuecomment-101',
      }]))
    vi.stubGlobal('fetch', fetchMock)

    const client = new RestGitHubClient({ token: 'token', repo: 'owner/repo' })
    const comments = await client.listComments(1)

    expect(comments).toHaveLength(101)
    expect(comments[100]).toMatchObject({ id: 101, body: 'Comment 101' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('page=1')
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2')
  })
})
