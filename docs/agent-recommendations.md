# Agent Model Recommendations

This document defines the built-in recommendation presets that the Forge web app
ships with. The app reads this data at runtime from
`web/lib/recommendations.ts` to populate the setup wizard, provider presets, and
the agent config UI. No database queries needed — it is static config.

---

## Presets

Four named presets cover the most common deployment scenarios.

### `best-quality`
Cloud-only. Highest reasoning quality for every role. Highest cost.

| Agent | Provider | Model |
|---|---|---|
| architect | anthropic | claude-opus-4-8 |
| backend | openai | gpt-4.1 |
| frontend | openai | gpt-4.1 |
| reviewer | anthropic | claude-opus-4-8 |
| qa | deepseek | deepseek-v4 |
| devops | openai | gpt-4.1 |

### `best-value`
Cloud-only. Best quality-to-cost ratio. Recommended starting point.

| Agent | Provider | Model |
|---|---|---|
| architect | anthropic | claude-sonnet-4-6 |
| backend | deepseek | deepseek-v4 |
| frontend | openrouter | moonshotai/kimi-k2 |
| reviewer | deepseek | deepseek-v4 |
| qa | deepseek | deepseek-v4 |
| devops | deepseek | deepseek-v4 |

### `hybrid`
Frontier model for PM/Architect and Reviewer; local Ollama workers for
implementation. Balances quality and cost.

| Agent | Provider | Model |
|---|---|---|
| architect | anthropic | claude-opus-4-8 |
| backend | ollama | devstral-small:24b |
| frontend | ollama | devstral-small:24b |
| reviewer | anthropic | claude-sonnet-4-6 |
| qa | ollama | qwen3-235b-a22b |
| devops | ollama | qwen3-235b-a22b |

### `fully-local`
Zero API cost. Requires Ollama running with sufficient VRAM (~40 GB for the
full set). No internet required after model pull.

| Agent | Provider | Model |
|---|---|---|
| architect | ollama | qwen3-235b-a22b |
| backend | ollama | devstral-small:24b |
| frontend | ollama | devstral-small:24b |
| reviewer | ollama | qwen3-235b-a22b |
| qa | ollama | devstral-small:24b |
| devops | ollama | qwen3-235b-a22b |

---

## Per-role recommendations

Used by the agent config UI to show inline "Recommended" suggestions when a
user is manually editing a single agent's provider, regardless of preset.

### architect
- Best: Anthropic `claude-opus-4-8` — highest reasoning quality; worth the
  cost because architecture decisions have the highest downstream impact.
- Value: Anthropic `claude-sonnet-4-6` — default; strong design quality at
  ~5× lower cost than Opus.
- OpenRouter Best: `moonshotai/kimi-k2` — 1M context, top open-source
  orchestrator.
- OpenRouter Value: `deepseek/deepseek-v4` — strong at reasoning and design
  at ~$0.27/1M in.
- LiteLLM Best: `litellm/claude-opus-4-8` — Opus via self-hosted gateway.
- LiteLLM Value: `litellm/kimi-k2` — Kimi K2 without OpenRouter markup.
- Local Best: `ollama/qwen3-235b-a22b` — strongest local reasoning.
- Local Value: `ollama/devstral-small:24b` — lighter VRAM, still capable.

### backend
- Best: OpenAI `gpt-4.1` — 1M context, precise at following long API specs.
- Value: DeepSeek `deepseek-v4` — top-tier coder at ~$0.27/1M.
- LiteLLM Best: `litellm/gpt-4.1`
- LiteLLM Value: `litellm/devstral-small` (routes to local Ollama)
- Local Best: `ollama/devstral-small:24b` — purpose-built for agentic coding.
- Local Value: `ollama/qwen3-235b-a22b` — 77% SWE-bench.

### frontend
- Best: OpenAI `gpt-4.1` — precise at following component specs.
- Value: Moonshot `kimi-k2` via OpenRouter — 1M context, cheaper than GPT-4.1.
- LiteLLM Best: `litellm/gpt-4.1`
- LiteLLM Value: `litellm/kimi-k2`
- Local Best: `ollama/devstral-small:24b`
- Local Value: `ollama/qwen3-235b-a22b`

### reviewer
- Best: Anthropic `claude-opus-4-8` — default; highest correctness and
  security review quality. Do not downgrade without good reason.
- Value: DeepSeek `deepseek-v4` via OpenRouter — strong reviewer at very low
  cost; acceptable for non-security-critical reviews.
- LiteLLM Best: `litellm/claude-opus-4-8`
- LiteLLM Value: `litellm/deepseek-v4`
- Local Best: `ollama/qwen3-235b-a22b`
- Local Value: `ollama/deepseek-r1:14b` — reasoning-focused, ~10 GB VRAM.

### qa
- Best: DeepSeek `deepseek-v4` — excellent test writer, strong at edge-case
  reasoning.
- Value: Qwen `qwen3-235b-a22b` via OpenRouter — solid at test generation at
  very low cost.
- LiteLLM Best: `litellm/deepseek-v4`
- LiteLLM Value: `litellm/devstral-small` (routes to local Ollama)
- Local Best: `ollama/devstral-small:24b`
- Local Value: `ollama/qwen3-235b-a22b`

### devops
- Best: OpenAI `gpt-4.1` — most reliable at Dockerfile / YAML / HCL
  generation.
- Value: DeepSeek `deepseek-v4` — strong at structured config at very low
  cost.
- LiteLLM Best: `litellm/gpt-4.1`
- LiteLLM Value: `litellm/qwen3-235b-a22b` (routes to local Ollama)
- Local Best: `ollama/devstral-small:24b`
- Local Value: `ollama/qwen3-235b-a22b`

---

## App implementation notes

- `web/lib/recommendations.ts` — exports `PRESETS` (the four named configs
  above) and `ROLE_RECOMMENDATIONS` (per-role inline suggestions). Both are
  plain TypeScript constants, no DB required.
- Setup wizard and provider presets UI — show the four presets. User picks one;
  the app creates the corresponding `provider_configs` rows and sets each
  `agent_configs` row's `provider_config_id`. Provider health checks flag
  missing API key environment variables after providers exist.
- Agent config UI — when editing a single agent's provider, the sidebar shows
  the relevant `ROLE_RECOMMENDATIONS` entries with "Recommended" badges,
  grouped by routing layer (Anthropic API / OpenAI API / OpenRouter / LiteLLM
  / Ollama).
- Cross-provider dispatch — provider selection per agent is stored in
  `agent_configs.provider_config_id`. The worker reads the active agent config
  from this table at dispatch time. The current helper dispatches only the
  architect stage; future specialist stages should use the same per-agent
  provider mapping.
