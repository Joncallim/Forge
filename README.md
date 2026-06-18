# Forge

Autonomous coding factory — Claude as project manager, OpenRouter worker fleet for implementation.

## How it works

Claude Code acts as PM and architect. It decomposes tasks, delegates implementation to specialist subagents routed through OpenRouter, reviews PRs, and controls merges.

```
Issue → Claude PM → Architect → Backend / Frontend / QA / DevOps → Reviewer → Merge
```

## Quick start

```bash
cp .env.example .env        # fill in ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GITHUB_TOKEN
bash scripts/setup.sh       # starts PostgreSQL + Redis via Docker
claude                      # opens Claude PM session
```

## Agents

| Agent | Model | Role |
|---|---|---|
| architect | kimi-k2 | Design, API contracts, task decomposition |
| backend | gpt-4.1 | APIs, migrations, business logic |
| frontend | gpt-4.1 | UI, state, API integration |
| reviewer | deepseek-r1 | Code review, security, correctness |
| qa | deepseek-r1 | Tests, coverage, regression |
| devops | minimax-01 | Docker, CI/CD, deployment |

## Stack

- **Claude Code** — PM session (model configurable: Opus 4.8, Kimi K2, Gemini 2.5 Pro, etc.)
- **OpenRouter** — routes worker agents to cloud models (single API key, 341+ models)
- **LiteLLM** — self-hosted OpenAI-compatible gateway for local + hybrid routing
- **Ollama** — local model runner (Devstral 24B, Qwen3 27B, DeepSeek R1 14B)
- **PostgreSQL 16** — task history, agent state, decision logs
- **Redis 7** — job queues, scheduling, session state
- **Docker Compose** — local infrastructure

## Architecture

See the [Notion doc](https://app.notion.com/p/3825797fd36e81dcbdfbfab23ea4c0e5) for full architecture and operating model.
