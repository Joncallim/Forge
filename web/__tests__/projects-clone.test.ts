import { describe, expect, it } from 'vitest'
import { buildCloneUrl, OWNER_REPO_RE, redactToken } from '@/lib/projects/clone'
import { validateGitHubTokenEnvVar } from '@/lib/github'

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

// Built from parts (not a contiguous literal) so secret scanners don't flag
// this placeholder test fixture as a real basic-auth credential.
function fakeCloneUrl(placeholderToken: string): string {
  return ['https://x-access-token:', placeholderToken, '@github.com/owner/repo.git'].join('')
}

describe('redactToken', () => {
  it('redacts the embedded credential from a clone URL', () => {
    const placeholder = ['not', 'a', 'real', 'token', '123'].join('-')
    const message = `Command failed: git clone ${fakeCloneUrl(placeholder)} /tmp/x`
    const redacted = redactToken(message)
    expect(redacted).not.toContain(placeholder)
    expect(redacted).toContain('x-access-token:***@github.com/owner/repo.git')
  })

  it('leaves messages without embedded credentials unchanged', () => {
    const message = 'fatal: repository not found'
    expect(redactToken(message)).toBe(message)
  })

  it('redacts multiple occurrences', () => {
    const placeholderA = ['placeholder', 'a'].join('-')
    const placeholderB = ['placeholder', 'b'].join('-')
    const message = `a ${fakeCloneUrl(placeholderA)} b ${fakeCloneUrl(placeholderB)}`
    const redacted = redactToken(message)
    expect(redacted).not.toContain(placeholderA)
    expect(redacted).not.toContain(placeholderB)
  })
})

describe('buildCloneUrl', () => {
  it('returns a clean repository URL without embedding credentials', () => {
    const cloneUrl = buildCloneUrl('owner/repo')

    expect(cloneUrl).toBe('https://github.com/owner/repo.git')
    expect(cloneUrl).not.toContain('x-access-token')
  })
})

describe('validateGitHubTokenEnvVar', () => {
  it('allows only fixed GitHub token environment variable names', () => {
    expect(validateGitHubTokenEnvVar('GITHUB_TOKEN')).toBeNull()
    expect(validateGitHubTokenEnvVar('GH_TOKEN')).toBeNull()
    expect(validateGitHubTokenEnvVar('SESSION_SECRET')).toMatch(/GitHub token env var/i)
  })
})
