import { describe, expect, it } from 'vitest'
import { OWNER_REPO_RE, redactToken } from '@/app/api/projects/route'

describe('OWNER_REPO_RE', () => {
  it('accepts well-formed owner/repo strings', () => {
    expect(OWNER_REPO_RE.test('octocat/Hello-World')).toBe(true)
    expect(OWNER_REPO_RE.test('my.org_name/repo.name-2')).toBe(true)
  })

  it('rejects shell metacharacters and command-injection attempts', () => {
    expect(OWNER_REPO_RE.test('owner/repo; rm -rf /')).toBe(false)
    expect(OWNER_REPO_RE.test('owner/repo`whoami`')).toBe(false)
    expect(OWNER_REPO_RE.test('owner/repo && echo pwned')).toBe(false)
    expect(OWNER_REPO_RE.test('owner/repo$(id)')).toBe(false)
    expect(OWNER_REPO_RE.test('--upload-pack=evil/repo')).toBe(false)
  })

  it('rejects missing slash, extra slashes, and empty segments', () => {
    expect(OWNER_REPO_RE.test('owner-only')).toBe(false)
    expect(OWNER_REPO_RE.test('owner/repo/extra')).toBe(false)
    expect(OWNER_REPO_RE.test('/repo')).toBe(false)
    expect(OWNER_REPO_RE.test('owner/')).toBe(false)
  })
})

describe('redactToken', () => {
  it('redacts the embedded credential from a clone URL', () => {
    const message = 'Command failed: git clone https://x-access-token:ghp_secret123@github.com/owner/repo.git /tmp/x'
    const redacted = redactToken(message)
    expect(redacted).not.toContain('ghp_secret123')
    expect(redacted).toContain('x-access-token:***@github.com/owner/repo.git')
  })

  it('leaves messages without embedded credentials unchanged', () => {
    const message = 'fatal: repository not found'
    expect(redactToken(message)).toBe(message)
  })

  it('redacts multiple occurrences', () => {
    const message = 'a https://x-access-token:tok1@github.com b https://x-access-token:tok2@github.com'
    const redacted = redactToken(message)
    expect(redacted).not.toContain('tok1')
    expect(redacted).not.toContain('tok2')
  })
})
