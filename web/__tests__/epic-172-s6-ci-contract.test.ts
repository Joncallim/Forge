import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import packageJson from '@/package.json'

const repositoryRoot = path.resolve(process.cwd(), '..')

describe('Epic 172 S6 trusted CI wiring', () => {
  it('keeps the six exact timeout-bearing command interfaces', () => {
    expect(packageJson.scripts['preflight:mcp:host-boundary']).toBe(
      'node scripts/run-with-deadline.mjs 30 -- node scripts/verify-mcp-host-boundary-attestation.mjs --harness-socket /run/forge-host-boundary/attest.sock --controller-challenge /run/forge-host-boundary/controller-challenge.json --public-key /usr/share/forge-host-boundary/attestation.pub --signed-envelope-out .artifacts/mcp-host-boundary-preflight.signed.json',
    )
    expect(packageJson.scripts['test:mcp:postgres']).toContain('run-with-deadline.mjs 240')
    expect(packageJson.scripts['test:mcp:issuance']).toContain('run-with-deadline.mjs 300')
    expect(packageJson.scripts['e2e:mcp-operator']).toContain('run-with-deadline.mjs 240')
    expect(packageJson.scripts['test:mcp:host-boundary']).toContain('run-with-deadline.mjs 420')
    expect(packageJson.scripts['test:mcp:contract']).toContain('run-with-deadline.mjs 60')
  })

  it('allows only a protected trusted handoff and never uploads checkout artifacts', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github/workflows/mcp-host-boundary-trusted.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('reviewed_sha:')
    expect(workflow).toContain('ref: ${{ inputs.reviewed_sha }}')
    expect(workflow).toContain('environment: forge-host-boundary-release')
    expect(workflow).toContain('runs-on: [self-hosted, linux, x64, forge-host-boundary]')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('npm ci --offline --ignore-scripts')
    expect(workflow).not.toMatch(/pull_request(?:_target)?:/)
    expect(workflow).not.toContain('actions/upload-artifact')
    expect(workflow).not.toContain('checks: write')
  })

  it('keeps every controller mutation behind the fixed external socket and documented exact commands', async () => {
    const guide = await readFile(path.join(repositoryRoot, 'docs/operators/host-boundary-controller-v2.md'), 'utf8')
    const commands = [
      'npm run protocol:inspect-host-boundary-controller -- --run <controller-run-id> --sha <sha>',
      'npm run protocol:verify-host-boundary-controller-ruleset -- --repository <owner/repo> --app-id <github-app-id> --check forge/host-boundary-controller',
      'npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state failed --apply',
      'npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state timed_out --apply',
      'npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>',
      'npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply',
      'npm run protocol:inspect-host-boundary-controller-key-rotation -- --rotation <rotation-id>',
      'npm run protocol:rotate-host-boundary-controller-key -- --rotation <rotation-id> --discard --actor <operator-id> --apply',
    ]
    for (const command of commands) expect(guide).toContain(command)
    expect(guide).toContain('macOS, Windows, a same-user container')
    expect(guide).toContain('not trusted release proof')
  })
})
