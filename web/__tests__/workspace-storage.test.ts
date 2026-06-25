import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

describe('workspace-native storage safeguards', () => {
  it('loads forge.env from FORGE_WORKSPACE_ROOT when FORGE_ENV_FILE is unset', async () => {
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousEnvFile = process.env.FORGE_ENV_FILE
    const previousSentinel = process.env.FORGE_LOAD_ENV_SENTINEL
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-load-env-root-'))

    try {
      await fs.mkdir(path.join(workspaceRoot, 'config'), { recursive: true })
      await fs.writeFile(
        path.join(workspaceRoot, 'config', 'forge.env'),
        'FORGE_LOAD_ENV_SENTINEL=from-workspace-root\n',
      )
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
      delete process.env.FORGE_ENV_FILE
      delete process.env.FORGE_LOAD_ENV_SENTINEL
      vi.resetModules()

      await import('@/lib/load-env')

      expect(process.env.FORGE_LOAD_ENV_SENTINEL).toBe('from-workspace-root')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousEnvFile === undefined) {
        delete process.env.FORGE_ENV_FILE
      } else {
        process.env.FORGE_ENV_FILE = previousEnvFile
      }
      if (previousSentinel === undefined) {
        delete process.env.FORGE_LOAD_ENV_SENTINEL
      } else {
        process.env.FORGE_LOAD_ENV_SENTINEL = previousSentinel
      }
      vi.resetModules()
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('refuses to update symlinked workspace agent prompt files', async () => {
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousPromptDir = process.env.FORGE_AGENT_CONFIG_DIR
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-prompt-symlink-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-prompt-outside-'))

    try {
      const promptDir = path.join(workspaceRoot, 'prompts', 'agents')
      const outsideFile = path.join(outsideRoot, 'target.toml')
      await fs.mkdir(promptDir, { recursive: true })
      await fs.writeFile(outsideFile, 'do not overwrite')
      await fs.symlink(outsideFile, path.join(promptDir, 'reviewer.toml'))
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
      delete process.env.FORGE_AGENT_CONFIG_DIR

      const { syncAgentPromptFileToWorkspace } = await import('@/lib/agent-prompts')

      await expect(syncAgentPromptFileToWorkspace({
        agentType: 'reviewer',
        systemPrompt: 'new prompt',
      })).rejects.toThrow(/symlink/)
      await expect(fs.readFile(outsideFile, 'utf-8')).resolves.toBe('do not overwrite')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousPromptDir === undefined) {
        delete process.env.FORGE_AGENT_CONFIG_DIR
      } else {
        process.env.FORGE_AGENT_CONFIG_DIR = previousPromptDir
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects workforce export slugs that would escape the workforces directory', async () => {
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workforce-slug-'))

    try {
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
      const { exportWorkforcesToWorkspace } = await import('@/lib/workforce-exports')

      await expect(exportWorkforcesToWorkspace([{
        id: 'workforce-1',
        slug: '../../outside',
        displayName: 'Bad Workforce',
        description: '',
        isDefault: false,
        isActive: true,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        members: [],
      } as never])).rejects.toThrow(/unsafe workforce slug/i)
      await expect(fs.stat(path.join(workspaceRoot, '..', 'outside'))).rejects.toThrow()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('parses escaped TOML strings emitted for workspace agent prompts', async () => {
    const promptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-toml-parse-'))

    try {
      const { renderCodexAgentToml } = await import('@/lib/agent-prompts')
      const { parseCodexAgentFile } = await import('@/db/seed-agents')
      const filePath = path.join(promptRoot, 'quote-agent.toml')
      await fs.writeFile(filePath, renderCodexAgentToml({
        agentType: 'quote-agent',
        description: 'Review "risky" C:\\Temp\nnext',
        systemPrompt: 'Prompt with a literal C:\\Temp path.',
      }))

      const parsed = parseCodexAgentFile(filePath)
      expect(parsed?.description).toBe('Review "risky" C:\\Temp\nnext')
      expect(parsed?.systemPrompt).toBe('Prompt with a literal C:\\Temp path.')

      const mismatchedPath = path.join(promptRoot, 'different-agent.toml')
      await fs.writeFile(mismatchedPath, renderCodexAgentToml({
        agentType: 'quote-agent',
        description: 'Should be skipped',
        systemPrompt: 'Prompt.',
      }))
      expect(parseCodexAgentFile(mismatchedPath)).toBeNull()
    } finally {
      await fs.rm(promptRoot, { recursive: true, force: true })
    }
  })

  it('does not create MCP install directories while reading missing manifests', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-read-'))

    try {
      const { readManifest } = await import('@/lib/mcps/manager')
      const installPath = path.join(workspaceRoot, 'mcps', 'filesystem')

      await expect(readManifest(installPath, workspaceRoot)).resolves.toBeNull()
      await expect(fs.stat(installPath)).rejects.toThrow()
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects MCP installs when the shared MCP root is a symlink escape', async () => {
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-symlink-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-outside-'))

    try {
      await fs.symlink(outsideRoot, path.join(workspaceRoot, 'mcps'))
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
      const { installMcps } = await import('@/lib/mcps/manager')

      await expect(installMcps(['filesystem'])).rejects.toThrow(/symlink|workspace/i)
      await expect(fs.stat(path.join(outsideRoot, 'filesystem', 'forge.mcp.json'))).rejects.toThrow()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('keeps Docker secrets out of compose placeholders and starts Docker with the workspace env file', async () => {
    const repoRoot = path.resolve(__dirname, '../..')
    const [compose, install] = await Promise.all([
      fs.readFile(path.join(repoRoot, 'docker-compose.yml'), 'utf-8'),
      fs.readFile(path.join(repoRoot, 'scripts', 'install.sh'), 'utf-8'),
    ])

    expect(compose).not.toMatch(/SESSION_SECRET:\s*\$\{SESSION_SECRET:-change_me/)
    expect(compose).not.toMatch(/OPENROUTER_API_KEY:\s*\$\{OPENROUTER_API_KEY:-}/)
    expect(install).toContain('--env-file "$ENV_FILE"')
    expect(install).toContain('FORGE_WORKSPACE_ROOT="$WORKSPACE_ROOT"')
  })

  it('does not derive destructive uninstall database drops from DATABASE_URL', async () => {
    const repoRoot = path.resolve(__dirname, '../..')
    const uninstall = await fs.readFile(path.join(repoRoot, 'scripts', 'uninstall.sh'), 'utf-8')

    expect(uninstall).not.toContain('admin_url="${url%/*}/postgres"')
    expect(uninstall).not.toContain('DROP DATABASE IF EXISTS "$dbname"')
    expect(uninstall).toContain('drop_recorded_postgres_data')
  })
})
