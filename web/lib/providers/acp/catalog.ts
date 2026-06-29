export type AcpAuthMode = 'web' | 'cli' | 'unknown'

export type AcpAgentCatalogEntry = {
  id: string
  label: string
  sourceUrl: string
  adapterUrl?: string
  authMode: AcpAuthMode
  modelSelection?: AcpModelSelectionSupport
  note?: string
}

export type AcpModelOption = {
  id: string
  label: string
  description?: string
}

export type AcpModelSelectionSupport = {
  type: 'session_config_option'
  configIdCandidates: string[]
  optionCategoryCandidates: string[]
  options: AcpModelOption[]
  helpText: string
}

export const ACP_AGENTS_SOURCE_URL = 'https://agentclientprotocol.com/get-started/agents'

const CODEX_CLI_MODEL_SELECTION: AcpModelSelectionSupport = {
  type: 'session_config_option',
  configIdCandidates: ['model', 'model_id', 'codex_model'],
  optionCategoryCandidates: ['model'],
  options: [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  ],
  helpText: 'Forge passes this via the ACP session model config option. Exact availability follows the local Codex CLI account/runtime.',
}

const CLAUDE_CODE_MODEL_SELECTION: AcpModelSelectionSupport = {
  type: 'session_config_option',
  configIdCandidates: ['model', 'model_id', 'claude_model'],
  optionCategoryCandidates: ['model'],
  options: [
    { id: 'opus', label: 'Opus alias' },
    { id: 'sonnet', label: 'Sonnet alias' },
    { id: 'haiku', label: 'Haiku alias' },
  ],
  helpText: 'Forge passes this via the ACP session model config option. Claude Code aliases resolve inside the local Claude runtime; pin exact versions in Claude Code when your runtime supports it.',
}

export const ACP_AGENTS: AcpAgentCatalogEntry[] = [
  { id: 'agentpool', label: 'AgentPool', sourceUrl: 'https://phil65.github.io/agentpool/advanced/acp-integration/', authMode: 'unknown' },
  { id: 'augment-code', label: 'Augment Code', sourceUrl: 'https://docs.augmentcode.com/cli/acp', authMode: 'web' },
  { id: 'autodev', label: 'AutoDev', sourceUrl: 'https://github.com/phodal/auto-dev', authMode: 'unknown' },
  { id: 'blackbox-ai', label: 'Blackbox AI', sourceUrl: 'https://docs.blackbox.ai/features/blackbox-cli/introduction', authMode: 'web' },
  { id: 'bub', label: 'Bub', sourceUrl: 'https://github.com/bubbuild/bub', adapterUrl: 'https://github.com/bubbuild/bub-contrib/tree/main/packages/bub-acp-server', authMode: 'unknown' },
  { id: 'claude-agent', label: 'Claude Code', sourceUrl: 'https://docs.anthropic.com/en/docs/claude-code/model-config', adapterUrl: 'https://github.com/zed-industries/claude-agent-acp', authMode: 'web', modelSelection: CLAUDE_CODE_MODEL_SELECTION, note: 'Via Zed SDK adapter.' },
  { id: 'cline', label: 'Cline', sourceUrl: 'https://cline.bot/', authMode: 'web' },
  { id: 'codex-cli', label: 'Codex CLI', sourceUrl: 'https://developers.openai.com/codex/cli', adapterUrl: 'https://github.com/zed-industries/codex-acp', authMode: 'web', modelSelection: CODEX_CLI_MODEL_SELECTION, note: 'Via Zed adapter.' },
  { id: 'code-assistant', label: 'Code Assistant', sourceUrl: 'https://github.com/stippi/code-assistant?tab=readme-ov-file#configuration', authMode: 'unknown' },
  { id: 'crow-cli', label: 'crow-cli', sourceUrl: 'https://crow-ai.dev', authMode: 'unknown' },
  { id: 'cursor', label: 'Cursor', sourceUrl: 'https://cursor.com/docs/cli/acp', authMode: 'web' },
  { id: 'docker-cagent', label: "Docker's cagent", sourceUrl: 'https://github.com/docker/cagent', authMode: 'unknown' },
  { id: 'fast-agent', label: 'fast-agent', sourceUrl: 'https://fast-agent.ai/acp', authMode: 'unknown' },
  { id: 'factory-droid', label: 'Factory Droid', sourceUrl: 'https://factory.ai/', authMode: 'web' },
  { id: 'fount', label: 'fount', sourceUrl: 'https://github.com/steve02081504/fount', authMode: 'unknown' },
  { id: 'gemini-cli', label: 'Gemini CLI', sourceUrl: 'https://github.com/google-gemini/gemini-cli', authMode: 'web' },
  { id: 'github-copilot', label: 'GitHub Copilot', sourceUrl: 'https://github.com/features/copilot', adapterUrl: 'https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/', authMode: 'web', note: 'Public preview.' },
  { id: 'goose', label: 'Goose', sourceUrl: 'https://block.github.io/goose/docs/guides/acp-clients', authMode: 'unknown' },
  { id: 'hermes-agent', label: 'Hermes Agent', sourceUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp', authMode: 'unknown' },
  { id: 'junie', label: 'Junie by JetBrains', sourceUrl: 'https://junie.jetbrains.com/', authMode: 'web' },
  { id: 'kimi-cli', label: 'Kimi CLI', sourceUrl: 'https://github.com/MoonshotAI/kimi-cli', authMode: 'web' },
  { id: 'kiro-cli', label: 'Kiro CLI', sourceUrl: 'https://kiro.dev/docs/cli/acp/', authMode: 'web' },
  { id: 'minion-code', label: 'Minion Code', sourceUrl: 'https://github.com/femto/minion-code', authMode: 'unknown' },
  { id: 'mistral-vibe', label: 'Mistral Vibe', sourceUrl: 'https://github.com/mistralai/mistral-vibe', authMode: 'web' },
  { id: 'openclaw', label: 'OpenClaw', sourceUrl: 'https://docs.openclaw.ai/cli/acp', authMode: 'web' },
  { id: 'opencode', label: 'OpenCode', sourceUrl: 'https://github.com/sst/opencode', authMode: 'unknown' },
  { id: 'openhands', label: 'OpenHands', sourceUrl: 'https://docs.openhands.dev/openhands/usage/run-openhands/acp', authMode: 'unknown' },
  { id: 'pi', label: 'Pi', sourceUrl: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent', adapterUrl: 'https://github.com/svkozak/pi-acp', authMode: 'unknown' },
  { id: 'poolside', label: 'Poolside', sourceUrl: 'https://github.com/poolsideai/pool', authMode: 'unknown' },
  { id: 'qoder-cli', label: 'Qoder CLI', sourceUrl: 'https://docs.qoder.com/cli/acp', authMode: 'web' },
  { id: 'qwen-code', label: 'Qwen Code', sourceUrl: 'https://github.com/QwenLM/qwen-code', authMode: 'web' },
  { id: 'sigit-code', label: 'siGit Code', sourceUrl: 'https://github.com/getsigit/sigit', authMode: 'unknown' },
  { id: 'stakpak', label: 'Stakpak', sourceUrl: 'https://github.com/stakpak/agent?tab=readme-ov-file#agent-client-protocol-acp', authMode: 'unknown' },
  { id: 'stdio-bus', label: 'stdio Bus', sourceUrl: 'https://github.com/stdiobus/stdiobus', authMode: 'unknown' },
  { id: 'vt-code', label: 'VT Code', sourceUrl: 'https://github.com/vinhnx/vtcode/blob/main/README.md#zed-ide-integration-agent-client-protocol', authMode: 'unknown' },
]

export const ACP_AGENT_IDS = new Set(ACP_AGENTS.map((agent) => agent.id))

export function isAcpAgentId(value: string): boolean {
  return ACP_AGENT_IDS.has(parseAcpProviderModelId(value).agentId)
}

export function getAcpAgent(value: string): AcpAgentCatalogEntry | undefined {
  return ACP_AGENTS.find((agent) => agent.id === parseAcpProviderModelId(value).agentId)
}

export function getAcpModelSelection(value: string): AcpModelSelectionSupport | null {
  return getAcpAgent(value)?.modelSelection ?? null
}

export type ParsedAcpProviderModelId = {
  agentId: string
  selectedModel: string | null
  supportsModelSelection: boolean
}

export type AcpProviderDisplay = ParsedAcpProviderModelId & {
  runtimeLabel: string
  modelSelectionLabel: string
}

export function acpProviderModelId(agentId: string, selectedModel?: string | null): string {
  const model = selectedModel?.trim()
  return model ? `${agentId}::${model}` : agentId
}

export function parseAcpProviderModelId(value: string): ParsedAcpProviderModelId {
  const [agentIdRaw, ...modelParts] = value.split('::')
  const agentId = agentIdRaw.trim()
  const selectedModel = modelParts.join('::').trim() || null
  const agent = ACP_AGENTS.find((entry) => entry.id === agentId)
  return {
    agentId,
    selectedModel,
    supportsModelSelection: agent?.modelSelection !== undefined,
  }
}

export function acpProviderDisplay(value: string): AcpProviderDisplay {
  const parsed = parseAcpProviderModelId(value)
  const agent = ACP_AGENTS.find((entry) => entry.id === parsed.agentId)
  const runtimeLabel = agent?.label ?? parsed.agentId
  const modelSelectionLabel = parsed.selectedModel
    ? parsed.supportsModelSelection
      ? parsed.selectedModel
      : `${parsed.selectedModel} (not passed to this ACP runtime)`
    : parsed.supportsModelSelection
      ? 'Runtime default model'
      : 'Runtime-managed model'
  return {
    ...parsed,
    runtimeLabel,
    modelSelectionLabel,
  }
}
