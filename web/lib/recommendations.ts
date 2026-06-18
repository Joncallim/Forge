// Static recommendation data — no runtime reads, no DB queries.
// Sourced from docs/agent-recommendations.md.

export type Preset = {
  id: 'best-quality' | 'best-value' | 'hybrid' | 'fully-local'
  label: string
  description: string
  estimatedMonthlyCost: string
  agents: Record<
    string,
    {
      providerType: string
      modelId: string
      baseUrl?: string
      apiKeyEnvVar?: string
      isLocal: boolean
    }
  >
}

export const PRESETS: Preset[] = [
  {
    id: 'best-quality',
    label: 'Best Quality',
    description: 'Cloud-only. Highest reasoning quality for every role. Highest cost.',
    estimatedMonthlyCost: '~$200–600 / month',
    agents: {
      architect: { providerType: 'anthropic', modelId: 'claude-opus-4-8', isLocal: false, apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
      backend:   { providerType: 'openai',    modelId: 'gpt-4.1',          isLocal: false, apiKeyEnvVar: 'OPENAI_API_KEY' },
      frontend:  { providerType: 'openai',    modelId: 'gpt-4.1',          isLocal: false, apiKeyEnvVar: 'OPENAI_API_KEY' },
      reviewer:  { providerType: 'anthropic', modelId: 'claude-opus-4-8', isLocal: false, apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
      qa:        { providerType: 'openrouter', modelId: 'deepseek/deepseek-v4', isLocal: false, apiKeyEnvVar: 'OPENROUTER_API_KEY' },
      devops:    { providerType: 'openai',    modelId: 'gpt-4.1',          isLocal: false, apiKeyEnvVar: 'OPENAI_API_KEY' },
    },
  },
  {
    id: 'best-value',
    label: 'Best Value',
    description: 'Cloud-only. Best quality-to-cost ratio. Recommended starting point.',
    estimatedMonthlyCost: '~$20–60 / month',
    agents: {
      architect: { providerType: 'anthropic',  modelId: 'claude-sonnet-4-6',         isLocal: false, apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
      backend:   { providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',       isLocal: false, apiKeyEnvVar: 'OPENROUTER_API_KEY' },
      frontend:  { providerType: 'openrouter', modelId: 'moonshotai/kimi-k2',         isLocal: false, apiKeyEnvVar: 'OPENROUTER_API_KEY' },
      reviewer:  { providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',       isLocal: false, apiKeyEnvVar: 'OPENROUTER_API_KEY' },
      qa:        { providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',       isLocal: false, apiKeyEnvVar: 'OPENROUTER_API_KEY' },
      devops:    { providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',       isLocal: false, apiKeyEnvVar: 'OPENROUTER_API_KEY' },
    },
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    description: 'Frontier model for Architect and Reviewer; local Ollama workers for implementation. Balances quality and cost.',
    estimatedMonthlyCost: '~$30–80 / month',
    agents: {
      architect: { providerType: 'anthropic', modelId: 'claude-opus-4-8',      isLocal: false, apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
      backend:   { providerType: 'ollama',    modelId: 'devstral-small:24b',    isLocal: true,  baseUrl: 'http://localhost:11434' },
      frontend:  { providerType: 'ollama',    modelId: 'devstral-small:24b',    isLocal: true,  baseUrl: 'http://localhost:11434' },
      reviewer:  { providerType: 'anthropic', modelId: 'claude-sonnet-4-6',    isLocal: false, apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
      qa:        { providerType: 'ollama',    modelId: 'qwen3-235b-a22b',       isLocal: true,  baseUrl: 'http://localhost:11434' },
      devops:    { providerType: 'ollama',    modelId: 'qwen3-235b-a22b',       isLocal: true,  baseUrl: 'http://localhost:11434' },
    },
  },
  {
    id: 'fully-local',
    label: 'Fully Local',
    description: 'Zero API cost. Requires Ollama running with sufficient VRAM (~40 GB). No internet required after model pull.',
    estimatedMonthlyCost: '$0 / month',
    agents: {
      architect: { providerType: 'ollama', modelId: 'qwen3-235b-a22b',    isLocal: true, baseUrl: 'http://localhost:11434' },
      backend:   { providerType: 'ollama', modelId: 'devstral-small:24b', isLocal: true, baseUrl: 'http://localhost:11434' },
      frontend:  { providerType: 'ollama', modelId: 'devstral-small:24b', isLocal: true, baseUrl: 'http://localhost:11434' },
      reviewer:  { providerType: 'ollama', modelId: 'qwen3-235b-a22b',    isLocal: true, baseUrl: 'http://localhost:11434' },
      qa:        { providerType: 'ollama', modelId: 'devstral-small:24b', isLocal: true, baseUrl: 'http://localhost:11434' },
      devops:    { providerType: 'ollama', modelId: 'qwen3-235b-a22b',    isLocal: true, baseUrl: 'http://localhost:11434' },
    },
  },
]

export type RoleRecommendation = {
  layer: 'Anthropic API' | 'OpenAI API' | 'OpenRouter' | 'LiteLLM' | 'Ollama'
  tier: 'Best' | 'Value'
  modelId: string
  providerType: string
  baseUrl?: string
  note: string
}

export const ROLE_RECOMMENDATIONS: Record<string, RoleRecommendation[]> = {
  architect: [
    { layer: 'Anthropic API', tier: 'Best',  providerType: 'anthropic',  modelId: 'claude-opus-4-8',        note: 'Highest reasoning quality; worth the cost for architecture decisions.' },
    { layer: 'Anthropic API', tier: 'Value', providerType: 'anthropic',  modelId: 'claude-sonnet-4-6',      note: 'Strong design quality at ~5× lower cost than Opus.' },
    { layer: 'OpenRouter',    tier: 'Best',  providerType: 'openrouter', modelId: 'moonshotai/kimi-k2',     note: '1M context, top open-source orchestrator.' },
    { layer: 'OpenRouter',    tier: 'Value', providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',   note: 'Strong at reasoning and design at ~$0.27/1M in.' },
    { layer: 'LiteLLM',       tier: 'Best',  providerType: 'litellm',    modelId: 'litellm/claude-opus-4-8', note: 'Opus via self-hosted gateway.' },
    { layer: 'LiteLLM',       tier: 'Value', providerType: 'litellm',    modelId: 'litellm/kimi-k2',        note: 'Kimi K2 without OpenRouter markup.' },
    { layer: 'Ollama',        tier: 'Best',  providerType: 'ollama',     modelId: 'qwen3-235b-a22b',        note: 'Strongest local reasoning model.', baseUrl: 'http://localhost:11434' },
    { layer: 'Ollama',        tier: 'Value', providerType: 'ollama',     modelId: 'devstral-small:24b',     note: 'Lighter VRAM, still capable.', baseUrl: 'http://localhost:11434' },
  ],
  backend: [
    { layer: 'OpenAI API',  tier: 'Best',  providerType: 'openai',     modelId: 'gpt-4.1',                note: '1M context, precise at following long API specs.' },
    { layer: 'OpenRouter',  tier: 'Value', providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',   note: 'Top-tier coder at ~$0.27/1M.' },
    { layer: 'LiteLLM',     tier: 'Best',  providerType: 'litellm',    modelId: 'litellm/gpt-4.1',        note: 'GPT-4.1 via self-hosted gateway.' },
    { layer: 'LiteLLM',     tier: 'Value', providerType: 'litellm',    modelId: 'litellm/devstral-small', note: 'Routes to local Ollama.' },
    { layer: 'Ollama',      tier: 'Best',  providerType: 'ollama',     modelId: 'devstral-small:24b',     note: 'Purpose-built for agentic coding.', baseUrl: 'http://localhost:11434' },
    { layer: 'Ollama',      tier: 'Value', providerType: 'ollama',     modelId: 'qwen3-235b-a22b',        note: '77% SWE-bench.', baseUrl: 'http://localhost:11434' },
  ],
  frontend: [
    { layer: 'OpenAI API',  tier: 'Best',  providerType: 'openai',     modelId: 'gpt-4.1',                note: 'Precise at following component specs.' },
    { layer: 'OpenRouter',  tier: 'Value', providerType: 'openrouter', modelId: 'moonshotai/kimi-k2',     note: '1M context, cheaper than GPT-4.1.' },
    { layer: 'LiteLLM',     tier: 'Best',  providerType: 'litellm',    modelId: 'litellm/gpt-4.1',        note: 'GPT-4.1 via self-hosted gateway.' },
    { layer: 'LiteLLM',     tier: 'Value', providerType: 'litellm',    modelId: 'litellm/kimi-k2',        note: 'Kimi K2 via self-hosted gateway.' },
    { layer: 'Ollama',      tier: 'Best',  providerType: 'ollama',     modelId: 'devstral-small:24b',     note: 'Best local model for UI work.', baseUrl: 'http://localhost:11434' },
    { layer: 'Ollama',      tier: 'Value', providerType: 'ollama',     modelId: 'qwen3-235b-a22b',        note: 'Strong local alternative.', baseUrl: 'http://localhost:11434' },
  ],
  reviewer: [
    { layer: 'Anthropic API', tier: 'Best',  providerType: 'anthropic',  modelId: 'claude-opus-4-8',      note: 'Highest correctness and security review quality. Do not downgrade without good reason.' },
    { layer: 'OpenRouter',    tier: 'Value', providerType: 'openrouter', modelId: 'deepseek/deepseek-v4', note: 'Strong reviewer at very low cost; acceptable for non-security-critical reviews.' },
    { layer: 'LiteLLM',       tier: 'Best',  providerType: 'litellm',    modelId: 'litellm/claude-opus-4-8', note: 'Opus via self-hosted gateway.' },
    { layer: 'LiteLLM',       tier: 'Value', providerType: 'litellm',    modelId: 'litellm/deepseek-v4', note: 'DeepSeek v4 via self-hosted gateway.' },
    { layer: 'Ollama',        tier: 'Best',  providerType: 'ollama',     modelId: 'qwen3-235b-a22b',      note: 'Best local reviewer.', baseUrl: 'http://localhost:11434' },
    { layer: 'Ollama',        tier: 'Value', providerType: 'ollama',     modelId: 'deepseek-r1:14b',      note: 'Reasoning-focused, ~10 GB VRAM.', baseUrl: 'http://localhost:11434' },
  ],
  qa: [
    { layer: 'OpenRouter',  tier: 'Best',  providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',         note: 'Excellent test writer, strong at edge-case reasoning.' },
    { layer: 'OpenRouter',  tier: 'Value', providerType: 'openrouter', modelId: 'qwen/qwen3-235b-a22b',         note: 'Solid at test generation at very low cost.' },
    { layer: 'LiteLLM',     tier: 'Best',  providerType: 'litellm',    modelId: 'litellm/deepseek-v4',          note: 'DeepSeek v4 via self-hosted gateway.' },
    { layer: 'LiteLLM',     tier: 'Value', providerType: 'litellm',    modelId: 'litellm/devstral-small',       note: 'Routes to local Ollama.' },
    { layer: 'Ollama',      tier: 'Best',  providerType: 'ollama',     modelId: 'devstral-small:24b',           note: 'Purpose-built for agentic coding.', baseUrl: 'http://localhost:11434' },
    { layer: 'Ollama',      tier: 'Value', providerType: 'ollama',     modelId: 'qwen3-235b-a22b',              note: 'Strong local alternative.', baseUrl: 'http://localhost:11434' },
  ],
  devops: [
    { layer: 'OpenAI API',  tier: 'Best',  providerType: 'openai',     modelId: 'gpt-4.1',                    note: 'Most reliable at Dockerfile / YAML / HCL generation.' },
    { layer: 'OpenRouter',  tier: 'Value', providerType: 'openrouter', modelId: 'deepseek/deepseek-v4',       note: 'Strong at structured config at very low cost.' },
    { layer: 'LiteLLM',     tier: 'Best',  providerType: 'litellm',    modelId: 'litellm/gpt-4.1',            note: 'GPT-4.1 via self-hosted gateway.' },
    { layer: 'LiteLLM',     tier: 'Value', providerType: 'litellm',    modelId: 'litellm/qwen3-235b-a22b',    note: 'Routes to local Ollama.' },
    { layer: 'Ollama',      tier: 'Best',  providerType: 'ollama',     modelId: 'devstral-small:24b',         note: 'Best local model for infra work.', baseUrl: 'http://localhost:11434' },
    { layer: 'Ollama',      tier: 'Value', providerType: 'ollama',     modelId: 'qwen3-235b-a22b',            note: 'Strong local alternative.', baseUrl: 'http://localhost:11434' },
  ],
}
