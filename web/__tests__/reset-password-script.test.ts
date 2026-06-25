import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..')
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

describe('reset-password script argument handling', () => {
  it('rejects extra argv values after --stdin before reading application state', () => {
    let stderr = ''

    try {
      execFileSync(tsxBin, ['scripts/reset-password.ts', '--stdin', 'leaked-secret'], {
        cwd: repoRoot,
        encoding: 'utf8',
        input: 'new-password-from-stdin\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      const failure = err as { status?: number; stderr?: string }
      stderr = failure.stderr ?? ''
      expect(failure.status).toBe(1)
    }

    expect(stderr).toContain('Refusing extra arguments')
  })
})
