# ADR-0001: ACP Provider Bridge (Subscription-Client Routing)

## Status

Proposed

## Context

Forge's only model-access path today is direct API-key providers, defined in
`web/lib/providers/`:

- `types.ts` — the closed `ProviderType` union (`anthropic`, `openai`, `google`,
  `openrouter`, `xai`, `deepseek`, `moonshot`, `zhipu`, `litellm`, `ollama`,
  `lmstudio`, `custom`).
- `catalog.ts` — `PROVIDER_CATALOG`, a static metadata table per type (category,
  whether an API key/base URL is required, default base URL, model placeholder).
- `registry.ts` — `buildProvider()` switches on `providerType` and returns a
  Vercel AI SDK provider factory (`createAnthropic`/`createOpenAI`/...);
  `getModel(configId)` resolves a `LanguageModel` for a stored `ProviderConfig`
  row. All non-Anthropic/Google types are routed through `createOpenAI` with a
  custom `baseURL`, i.e. everything assumes an OpenAI-compatible or native
  Anthropic HTTP API reachable with a bearer key.
- `health.ts` — `checkProviderHealth()` does a 1-token `generateText` call
  against a 3s timeout and persists the result to `provider_health_checks`
  (`reachable`, `envVarPresent`, `latencyMs`, `error`).
- `serialize.ts` — strips `apiKeyCiphertext` before any config is returned to
  the client.
- `db/schema.ts` — `providerConfigs` (id, displayName, providerType, modelId,
  baseUrl, apiKeyEnvVar, apiKeyCiphertext, isLocal, isActive) and
  `providerHealthChecks` (1:1 keyed on providerConfigId).

Every provider in this model is invoked the same way: resolve a key, build an
HTTP-based SDK client, call it. Issue #29 asks for a second invocation path —
routing through an ACP-compatible client (e.g. a locally running Claude Code /
Goose-style agent process the user is already authenticated into) so a task
can use the user's existing subscription instead of a per-token API key.

## Decision

**Add ACP as a second, explicit provider family, not a drop-in replacement for
the existing one.** Concretely:

1. **Adapter-specific bridge first, generic ACP client later.** ACP
   (Agent Client Protocol) implementations vary in transport and capability
   reporting across clients. Building a fully generic ACP client before we have
   a second real client to test against is speculative. Ship one concrete
   adapter — a local Claude Code CLI/ACP bridge over stdio/JSON-RPC — behind an
   internal interface shaped so a second adapter (e.g. a future GPT/Codex ACP
   client) is a new adapter module, not a rewrite.

2. **Capability discovery is separate from invocation, and lives on the
   adapter, not the catalog.** Static `PROVIDER_CATALOG` entries describe
   fixed facts about cloud APIs (default base URL, whether a key is needed).
   ACP clients are processes whose capabilities (model identity, context
   window, tool support, streaming, file/image support) can only be known by
   asking the live client. Add a `discoverCapabilities(adapter)` call that
   adapters implement and that is invoked on connect/health-check, never
   hardcoded in `catalog.ts`. Results are cached in-memory and surfaced in the
   health check payload, not persisted as config.

3. **No subscription secrets are stored or scraped.** The ACP adapter never
   reads, stores, or transmits the underlying client's session token, cookie,
   or credential file. Forge only knows "is the local ACP client process
   reachable and authenticated," reported by the client itself over the
   protocol. `providerConfigs` gains no new secret column for ACP rows;
   `apiKeyCiphertext`/`apiKeyEnvVar` stay null for `providerType = 'acp'`.

4. **New `providerType: 'acp'`,** with a required `acpAdapterId` (e.g.
   `'claude-code-cli'`) instead of a model id/base URL pair, since the model
   identity is reported by the client rather than chosen by Forge.

## Alternatives considered

- **Generic ACP client now** — rejected: no second real-world ACP client to
  validate the abstraction against yet; would guess at protocol variance.
- **Bolt ACP onto the existing `buildProvider()` switch as just another case**
  — rejected: ACP invocation is process/IPC-based, not an HTTP client
  constructed once and reused; forcing it through `ProviderFactory`/
  `LanguageModel` would either lie about capabilities or require a fake HTTP
  shim. A parallel `lib/providers/acp/` module with its own narrow interface is
  more honest and keeps the existing registry untouched.
- **Auto-detect and silently substitute ACP for API providers** — rejected by
  the issue's own acceptance criteria: routing must be explicit, opt-in, per
  task or project, never a silent swap.

## First slice (smallest viable)

- One adapter: local Claude Code ACP bridge (stdio JSON-RPC to a process the
  user already has logged in).
- One new `providerType: 'acp'` row shape, created explicitly in
  Settings → Providers ("Add ACP Provider"), never auto-created.
- Health states surfaced per config: `connected`, `authenticated`,
  `unsupported` (adapter present but client doesn't speak ACP or lacks a
  needed capability), `expired` (client reports session expiry),
  `unavailable` (process not reachable). These replace the boolean
  `reachable` for ACP rows only; existing API-key rows are unchanged.
- Fallback to an API-key provider only fires if the user has explicitly
  checked "Allow fallback to API provider" on the task/project's PM provider
  selection, per the issue's acceptance criteria — never automatic.
- One task type (PM planning call) wired through the ACP path end-to-end as
  proof; broader task routing follows once this slice is reviewed.

## Out of scope for this slice

- GPT/Codex ACP adapter — defer until the Claude Code adapter validates the
  interface shape.
- Streaming, tool-call passthrough, and file/image support over ACP — first
  slice is text-in/text-out generation only; capability discovery reports
  these as unsupported until implemented.
- Per-task ACP routing UI (only project-level/PM-level routing in this slice).
- Any persistence of ACP session tokens for reconnect-without-reauth — out of
  scope by design (security boundary, not a missing feature).
- Multi-process pooling/lifecycle management of the local ACP client — assume
  one long-lived local process per machine for now.

## Acceptance criteria

1. A user can add a `providerType: 'acp'` config in Settings → Providers
   pointing at the local Claude Code ACP adapter, with no API key field shown.
2. `checkProviderHealth()` (or an ACP-specific equivalent) returns one of
   `connected | authenticated | unsupported | expired | unavailable` for an
   ACP config, persisted the same way existing health checks are.
3. A PM task can run end-to-end using only the ACP provider, with zero API key
   configured for Anthropic/OpenAI in that project.
4. If the ACP client is stopped mid-task, the task fails with a clear
   `unavailable` error and does **not** silently retry against an API
   provider unless fallback was explicitly enabled on that project.
5. No subscription session secret ever appears in `provider_configs`,
   application logs, or any API response (verified by a Reviewer pass before
   merge, given CLAUDE.md's security-sensitive escalation rule).
6. Existing API-key providers (`anthropic`, `openai`, etc.) pass their current
   health checks and task runs unmodified.

## Task breakdown

1. **[Architect]** (this ADR) — done; review with repo owner before slicing
   tickets.
2. **[Backend]** Add `acp` to `PROVIDER_TYPES`/`ProviderType`, add
   `acpAdapterId` column + migration to `providerConfigs`, add
   `lib/providers/acp/claude-code-adapter.ts` implementing connect, health,
   capability discovery, and a minimal `generate(prompt) -> text` call over
   stdio JSON-RPC.
3. **[Backend]** Extend `checkProviderHealth()`/`refreshProviderHealth()` to
   branch on `providerType === 'acp'` and call the adapter's health/capability
   check instead of `generateText`; map adapter states to the five health
   states above.
4. **[Backend]** Wire the explicit per-project "Allow fallback to API
   provider" flag (new boolean column, e.g. on `projects` or task-run config)
   and the fallback-on-`unavailable`/`expired` logic in whatever module
   currently invokes `getModel()` for PM task runs.
5. **[Frontend]** Add "Add ACP Provider" flow to
   `web/app/dashboard/providers/page.tsx` (adapter picker instead of API
   key/base URL fields) and render the five ACP health states distinctly from
   the boolean reachable/unreachable badge used for API providers.
6. **[QA]** Tests: adapter health-state mapping, fallback-only-when-enabled
   behavior, and a regression check that `apiKeyCiphertext`/`apiKeyEnvVar`
   stay null for `acp` rows and never appear in `toPublicProvider()` output or
   logs for ACP configs.
7. **[Reviewer]** Security-focused pass per CLAUDE.md's escalation rule for
   auth/credential-adjacent changes — confirm no session secret persistence
   or logging path exists before merge.
8. **[DevOps]** None required for this slice (no new infra, container, or
   queue changes — the ACP adapter is an in-process child/IPC call from the
   existing Next.js/worker runtime).

## Open decisions (need repo owner input before implementation)

1. **Where does the ACP client process come from?** Does Forge spawn the
   Claude Code ACP process itself (lifecycle management, restart on crash) or
   does it only attach to one the user already has running? This changes the
   adapter's complexity significantly and affects the `unavailable` health
   state's meaning.
2. **Per-project vs per-task granularity for the fallback toggle.** The issue
   says "fail gracefully back ... only if the user has enabled fallback" but
   doesn't say at what scope. This ADR assumes project-level for the first
   slice; confirm or override.
3. **Model identity reporting.** When the ACP client reports its model id
   (e.g. "claude-opus-4"), should Forge surface that as freeform text, or
   validate/normalize it against a known model list for cost/capability UI
   elsewhere in the app? Affects whether `acpAdapterId` alone is sufficient or
   a `reportedModelId` column is also needed.
4. **GPT/Codex ACP feasibility timeline.** The issue asks for "Claude and GPT
   as first-class ACP-backed targets where technically feasible" — confirm
   whether a second adapter is an immediate follow-up PR or an indefinitely
   deferred stretch goal, since it affects how much the adapter interface
   needs to generalize now vs. later.
