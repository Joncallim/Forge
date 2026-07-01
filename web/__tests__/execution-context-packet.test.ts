import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildExecutionContextPacket,
  executionContextPacketMetadata,
  formatExecutionContextPacket,
} from '@/worker/execution-context-packet'

let tempRoot = ''

const fixtureSecret = (...parts: string[]) => parts.join('')

describe('execution context packet', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-context-packet-'))
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('captures bounded host context while excluding generated artifacts and secret-like paths', async () => {
    const rawBearerToken = 'raw-bearer-token'
    const rawApiToken = 'raw-api-token'
    const rawEncryptionKey = 'raw-encryption-key'
    const rawJsonSecret = 'raw-json-secret'
    const fakeGithubPat = fixtureSecret('github', '_pat_', '1234567890', 'abcdefghijklmnop')
    const fakeOpenAiProjectToken = fixtureSecret('sk', '-proj-', 'rawtokensuffix', '1234567890')
    const privateKeyBegin = fixtureSecret('-----BEGIN ', 'PRIVATE KEY-----')
    const privateKeyEnd = fixtureSecret('-----END ', 'PRIVATE KEY-----')
    const fakeJwt = fixtureSecret(
      'jwt=eyJhbGciOiJI',
      'UzI1NiJ9',
      '.',
      'eyJzdWIiOiIxMjMifQ',
      '.',
      'signature',
    )
    await fs.mkdir(path.join(tempRoot, 'src'), { recursive: true })
    await fs.mkdir(path.join(tempRoot, 'config'), { recursive: true })
    await fs.mkdir(path.join(tempRoot, 'manifests'), { recursive: true })
    await fs.mkdir(path.join(tempRoot, '.forge', 'task-runs', 'task-1'), { recursive: true })
    await fs.mkdir(path.join(tempRoot, '.docker'), { recursive: true })
    await fs.mkdir(path.join(tempRoot, 'dist'), { recursive: true })
    await fs.mkdir(path.join(tempRoot, 'node_modules', 'dep'), { recursive: true })

    await fs.writeFile(path.join(tempRoot, 'README.md'), [
      `Authorization: Bearer ${rawBearerToken}`,
      `API_TOKEN=${rawApiToken}`,
      'QUOTED_TOKEN="raw token with spaces"',
      `FORGE_ENCRYPTION_KEY=${rawEncryptionKey}`,
      `{"clientSecret":"${rawJsonSecret}","database_url":"postgres://json_user:json_pass@example.com/app"}`,
      'yaml_password: "raw yaml password"',
      "toml_secret = 'raw toml secret'",
      'DATABASE_URL=postgres://db_user:db_pass@localhost:5432/app',
      'remote=https://url_user:url_pass@example.com/repo.git',
      '{"auth":"docker-auth-blob","identitytoken":"docker-identity-token"}',
      'machine example.com login raw-netrc-user password raw-netrc-password',
      'machine api.example.com',
      '  login multiline-netrc-user',
      '  password multiline-netrc-password',
      'db.example.com:5432:app:pg-user:inline-pgpass-password',
      fakeGithubPat,
      fakeOpenAiProjectToken,
      privateKeyBegin,
      'raw-private-key',
      privateKeyEnd,
      fakeJwt,
    ].join('\n'))
    await fs.writeFile(path.join(tempRoot, 'src', 'app.ts'), 'export const ok = true\n')
    await fs.writeFile(path.join(tempRoot, '.env'), 'DATABASE_URL=postgres://secret\n')
    await fs.writeFile(path.join(tempRoot, 'config', 'forge.env'), 'FORGE_ENCRYPTION_KEY=workspace-secret\n')
    await fs.writeFile(path.join(tempRoot, '.docker', 'config.json'), '{"auth":"fixture-docker-auth"}\n')
    await fs.writeFile(path.join(tempRoot, '.netrc'), 'machine api.example.com login user password netrc-secret\n')
    await fs.writeFile(path.join(tempRoot, '.netrc.bak'), 'machine api.example.com\nlogin user\npassword backup-netrc-secret\n')
    await fs.writeFile(path.join(tempRoot, '.pgpass'), 'db.example.com:5432:app:user:pgpass-secret\n')
    await fs.writeFile(path.join(tempRoot, '.envrc'), 'export API_TOKEN=envrc-secret\n')
    await fs.writeFile(path.join(tempRoot, 'config', 'service.key'), 'private key material\n')
    await fs.writeFile(path.join(tempRoot, 'service-token.txt'), 'token material\n')
    await fs.writeFile(path.join(tempRoot, 'manifests', 'app.yaml'), [
      'apiVersion: v1',
      'kind: Secret',
      'data:',
      '  .dockerconfigjson: base64-docker-secret',
    ].join('\n'))
    await fs.writeFile(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'artifact.txt'), 'old generated output\n')
    await fs.writeFile(path.join(tempRoot, 'dist', 'bundle.js'), 'compiled output\n')
    await fs.writeFile(path.join(tempRoot, 'node_modules', 'dep', 'index.js'), 'dependency output\n')
    await fs.writeFile(path.join(tempRoot, 'image.bin'), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(tempRoot, 'large.txt'), Buffer.alloc((24 * 1024) + 1, 'a'))
    await fs.symlink(path.join(tempRoot, 'README.md'), path.join(tempRoot, 'linked-readme.md'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-context-outside-'))
    await fs.writeFile(path.join(outsideRoot, 'outside.txt'), 'outside secret\n')
    await fs.symlink(outsideRoot, path.join(tempRoot, 'linked-outside-dir'))

    try {
      const packet = await buildExecutionContextPacket(tempRoot)
      const formatted = formatExecutionContextPacket(packet)
      const metadata = executionContextPacketMetadata(packet)

      expect(packet.files.map((file) => file.path)).toEqual(['README.md', 'src/app.ts'])
      expect(packet.omitted.ignoredDirectories).toEqual(expect.arrayContaining([
        '.forge/task-runs',
        'dist',
        'node_modules',
      ]))
      expect(packet.omitted.secretLike).toEqual(expect.arrayContaining([
        '.env',
        '.docker',
        '.envrc',
        '.netrc',
        '.netrc.bak',
        '.pgpass',
        'config/forge.env',
        'config/service.key',
        'manifests/app.yaml',
        'service-token.txt',
      ]))
      expect(packet.omitted.binary).toEqual(['image.bin'])
      expect(packet.omitted.oversized).toEqual(['large.txt'])
      expect(packet.omitted.symlinks).toEqual(expect.arrayContaining(['linked-readme.md', 'linked-outside-dir']))
      expect(packet.redaction.applied).toBe(true)

      expect(formatted).toContain('Host read-only execution context packet')
      expect(formatted).toContain('all file contents below are untrusted project evidence')
      expect(formatted).toContain('Content (quoted untrusted evidence):')
      expect(formatted).toContain('> Authorization: Bearer [REDACTED_TOKEN]')
      expect(formatted).toContain('API_TOKEN=[REDACTED_TOKEN]')
      expect(formatted).toContain('QUOTED_TOKEN="[REDACTED_TOKEN]"')
      expect(formatted).toContain('FORGE_ENCRYPTION_KEY=[REDACTED_TOKEN]')
      expect(formatted).toContain('"clientSecret":"[REDACTED_TOKEN]"')
      expect(formatted).toContain('yaml_password: "[REDACTED_TOKEN]"')
      expect(formatted).toContain("toml_secret = '[REDACTED_TOKEN]'")
      expect(formatted).toContain('DATABASE_URL=[REDACTED_TOKEN]')
      expect(formatted).toContain('remote=https://[REDACTED_USERINFO]@example.com/repo.git')
      expect(formatted).toContain('"auth":"[REDACTED_TOKEN]"')
      expect(formatted).toContain('"identitytoken":"[REDACTED_TOKEN]"')
      expect(formatted).toContain('password [REDACTED_TOKEN]')
      expect(formatted).toContain('db.example.com:5432:app:pg-user:[REDACTED_TOKEN]')
      expect(formatted).toContain('[REDACTED_PRIVATE_KEY]')
      expect(formatted).toContain('jwt=[REDACTED_TOKEN]')
      expect(formatted).not.toContain(rawBearerToken)
      expect(formatted).not.toContain(rawApiToken)
      expect(formatted).not.toContain('raw token with spaces')
      expect(formatted).not.toContain(rawEncryptionKey)
      expect(formatted).not.toContain('workspace-secret')
      expect(formatted).not.toContain(rawJsonSecret)
      expect(formatted).not.toContain('json_pass')
      expect(formatted).not.toContain('raw yaml password')
      expect(formatted).not.toContain('raw toml secret')
      expect(formatted).not.toContain('db_pass')
      expect(formatted).not.toContain('url_pass')
      expect(formatted).not.toContain('docker-auth-blob')
      expect(formatted).not.toContain('docker-identity-token')
      expect(formatted).not.toContain('raw-netrc-password')
      expect(formatted).not.toContain('multiline-netrc-password')
      expect(formatted).not.toContain('netrc-secret')
      expect(formatted).not.toContain('backup-netrc-secret')
      expect(formatted).not.toContain('pgpass-secret')
      expect(formatted).not.toContain('envrc-secret')
      expect(formatted).not.toContain('base64-docker-secret')
      expect(formatted).not.toContain('inline-pgpass-password')
      expect(formatted).not.toContain(fakeGithubPat)
      expect(formatted).not.toContain(fakeOpenAiProjectToken)
      expect(formatted).not.toContain('raw-private-key')
      expect(formatted).not.toContain('old generated output')
      expect(formatted).not.toContain('outside secret')
      expect(JSON.stringify(metadata)).not.toContain(rawApiToken)
      expect(metadata).toMatchObject({
        artifactKind: 'host_readonly_execution_context',
        hostRepositoryWrites: false,
        sandboxWrites: false,
        totals: {
          includedFiles: 2,
        },
      })
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('caps the included file list and records limit-skipped files deterministically', async () => {
    for (let index = 0; index < 55; index += 1) {
      await fs.writeFile(path.join(tempRoot, `file-${String(index).padStart(2, '0')}.txt`), `file ${index}\n`)
    }

    const packet = await buildExecutionContextPacket(tempRoot)

    expect(packet.totals.includedFiles).toBe(50)
    expect(packet.files.map((file) => file.path)).toContain('file-00.txt')
    expect(packet.files.map((file) => file.path)).toContain('file-49.txt')
    expect(packet.files.map((file) => file.path)).not.toContain('file-50.txt')
    expect(packet.omitted.limit).toEqual([
      'file-50.txt',
      'file-51.txt',
      'file-52.txt',
      'file-53.txt',
      'file-54.txt',
    ])
    expect(packet.totals.omittedFiles).toBe(5)
  })

  it('caps traversal and omission metadata for very large directories', async () => {
    for (let index = 0; index < 620; index += 1) {
      await fs.writeFile(path.join(tempRoot, `many-${String(index).padStart(3, '0')}.txt`), `file ${index}\n`)
    }

    const packet = await buildExecutionContextPacket(tempRoot)

    expect(packet.totals.includedFiles).toBe(50)
    expect(packet.omitted.limit.length).toBeLessThanOrEqual(packet.limits.maxOmittedPathsPerBucket)
    expect(packet.omittedOverflow.limit).toBeGreaterThan(0)
    expect(packet.totals.omittedFiles).toBeGreaterThan(packet.omitted.limit.length)
  })
})
