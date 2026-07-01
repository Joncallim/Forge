import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('runtime metadata', () => {
  it('requires Node 22 for pinned ACP adapters', async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { engines?: { node?: string } }
    const packageLock = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package-lock.json'), 'utf-8'),
    ) as { packages?: Record<string, { engines?: { node?: string } }> }
    const installScript = await fs.readFile(path.join(process.cwd(), '..', 'scripts', 'install.sh'), 'utf-8')
    const setupScript = await fs.readFile(path.join(process.cwd(), '..', 'scripts', 'setup.sh'), 'utf-8')

    expect(packageJson.engines?.node).toBe('>=22')
    expect(packageLock.packages?.['']?.engines?.node).toBe('>=22')
    expect(installScript).toContain('[ "$major" -ge 22 ]')
    expect(installScript).toContain('Node.js 22 or newer is required.')
    expect(setupScript).toContain('[ "$NODE_MAJOR" -lt 22 ]')
    expect(setupScript).toContain('Forge needs Node 22 or newer.')
  })
})
