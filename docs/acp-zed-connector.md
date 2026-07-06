# ACP And The Zed Connector

This page explains Forge's Agent Client Protocol support in plain English.

## Introduction

ACP is a small protocol for talking to coding agents over standard input and
standard output. Think of it as a shared plug shape. Forge can send a prompt to
a local coding agent without needing to know that agent's private internals.

Forge does not bundle Zed, and it does not become Zed. For the currently wired
ACP providers, Forge starts a pinned Agent Client Protocol adapter dependency.
That adapter translates between Forge's ACP messages and the real local command
line tool, such as Codex CLI or Claude Code.

```text
Forge task
  -> Forge provider adapter
  -> pinned local codex-acp or claude-agent-acp adapter
  -> local codex or claude command
  -> model account already logged in on this machine
  -> streamed text back to Forge
```

## What You Need Installed

ACP providers are local providers. They depend on tools installed on the host:

| Need | Why |
|---|---|
| Node.js 22 or newer | Forge starts pinned ACP adapter dependencies from local `node_modules/.bin`. |
| The underlying CLI | `codex` for Codex CLI or `claude` for Claude Code. |
| CLI login/auth | The local CLI must already be authenticated. Forge does not collect those account credentials. |
| A project local folder | Forge uses the folder to validate and bound repository context. Architect ACP calls still run in an isolated runtime directory. |

There is no separate "install Zed editor" requirement for Forge's current ACP
path. The connector piece is the pinned ACP adapter package, not the desktop
editor.

## What Happens During A Health Check

When Forge checks an ACP provider, it:

1. Looks up the selected ACP agent, such as `codex-cli` or `claude-agent`.
2. Starts the matching pinned adapter binary from local dependencies.
3. Sends an ACP `initialize` JSON-RPC request.
4. Waits up to a short timeout for the adapter to answer.
5. Shows a clear status: ready, not configured, unreachable, handshake failed,
   or auth unavailable.

The check answers only "can Forge reach this local agent right now?" It does not
run a full task.

## What Happens During A Task

When a task uses an ACP provider, Forge:

1. Starts a fresh adapter process for that provider call, using a
   deny-by-default environment allowlist that does not forward Forge provider
   keys, GitHub tokens, database URLs, Redis URLs, or encryption secrets.
2. Sends `initialize`.
3. Opens a new ACP session in an isolated Architect runtime directory.
4. If the runtime supports model selection, sends the selected model as a
   session config option.
5. Flattens Forge's system prompt and user prompt into one text prompt.
6. Sends `session/prompt`.
7. Collects streamed `agent_message_chunk` text from the adapter.
8. Saves the resulting text as the Forge artifact.
9. Closes the adapter process.

Forge uses one adapter process per call. It does not keep a long-lived pool of
ACP agents.

Executable Workforce packages can use ACP providers. Forge starts the local CLI
from the package attempt sandbox and applies only the returned execution JSON
through its own path guards. Keep local CLI accounts and project folders scoped
to repositories where you are comfortable allowing generated local edits.

## Current Limits

- ACP output is plain text in Forge's current provider interface.
- Forge does not receive detailed token usage from ACP.
- Tool calls from the underlying coding agent are not exposed as Forge runtime
  MCP grants.
- ACP package execution relies on the package attempt working directory and
  Forge's execution JSON path guards; it is not a general live tool grant.
- If a runtime does not expose model selection through ACP, Forge stores the
  selected model on the provider record but cannot force the local runtime to
  use it.

## Troubleshooting

If an ACP provider is not ready:

- Confirm Node.js 22 or newer is available where Forge runs.
- Confirm the underlying CLI starts from the terminal.
- Log in with the CLI's own auth command.
- Confirm the Forge project has a local folder.
- Try the provider health check again from the Forge Providers page.

## Implementation Anchors

- `web/lib/providers/acp/catalog.ts`
- `web/lib/providers/acp/handshake.ts`
- `web/lib/providers/acp/client.ts`
- `web/lib/providers/acp/transport.ts`
- `web/lib/providers/acp/language-model.ts`
