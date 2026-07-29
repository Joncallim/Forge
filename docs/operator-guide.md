# Forge Operator Guide

This guide is for running Forge on a local machine or a small deployment. It
keeps the practical commands in one place so the README can stay short.

## Plain-English Summary

Forge has four moving pieces:

- The web dashboard you open in a browser.
- PostgreSQL, where Forge stores users, providers, projects, tasks, and results.
- Redis, where Forge queues background work.
- The worker, which picks up queued tasks and calls AI models.

For normal local use, `forge` starts both the dashboard and the worker. For
split deployments, the worker can still run separately.

The most important beta boundary: Forge may write plans, approval records,
work-package records, and handoff/review-gate state, but specialist execution
and file materialization are currently unavailable. Workforce materialization
and handoff are available after approval. `FORGE_WORK_PACKAGE_EXECUTION` is a
reserved setting and cannot enable execution today. Direct host writes,
branches, commits, pull
requests, merges, live specialist MCP grants, autonomous reviewer agents, and
parallel specialists are still future work.

The protected local-execution protocol designed in Epic #172 is also future work.
Its first release target is Ubuntu 24.04 with Linux 6.8 or newer because it depends
on cgroup v2, systemd scopes, separate run users, and kernel-verified Unix-socket
identity. The current beta installer still supports macOS and Linux as described
below, but a future #172 activation must refuse unsupported hosts and leave them on
the clearly labelled legacy/pre-cutover stream; it must not silently disable local
work or claim the new containment guarantee. Operators may migrate to a supported
Linux host or wait for a separately reviewed macOS adapter.

## Install

From the repository root:

```bash
bash scripts/install.sh
```

On macOS the installer uses Homebrew. On Linux it uses the detected package
manager: `apt`, `dnf`, `yum`, `zypper`, or `pacman`.

The installer can prepare:

- Node.js 22 or newer.
- PostgreSQL 16 or newer.
- Redis 7 or newer.
- GitHub CLI.
- Optional Ollama local model support.
- `~/Documents/Forge/config/forge.env` with generated local secrets.
- `web/node_modules`.
- Database migrations, workspace agent prompts, and workspace workforce exports.

Readiness and update commands:

```bash
bash scripts/install.sh --check
forge upgrade
FORGE_SKIP_OLLAMA=1 bash scripts/install.sh
```

If an install is interrupted, run `bash scripts/install.sh` again. The installer
preserves existing settings and resumes idempotent steps. Logs are written under
`~/Documents/Forge/runtime/install/`.

Repository files are source and defaults. Editable/runtime files are stored under
the active Forge workspace, which defaults to `~/Documents/Forge`:

```text
config/forge.env
prompts/agents/*.toml
workforces/<slug>/{workforce.json,workflow.json,manager-prompt.md}
projects/
mcps/
runtime/
logs/
backups/
```

## Start And Stop

Normal local startup:

```bash
forge
```

Open `http://localhost:3000`.

Split runtime:

```bash
cd web
FORGE_EMBED_WORKER=0 npm run dev
```

In another terminal:

```bash
cd web
npm run worker
```

Use split runtime only when you intentionally want the web app and worker as
separate processes. Running `npm run worker` alone does not serve the dashboard.

### Upgrade workers that may have legacy retry entries

This rollout needs a full worker stop between versions. A version 2 (v2) worker
expects every retry entry to use the newer queue envelope. It cannot understand
an older, plain-JSON retry entry and may exit when it reaches one. The current
worker can upgrade a legacy retry entry while promoting it, but Forge does not
detect worker versions, drain replicas, or run a separate queue migration for
you.

When upgrading from any version that may have written legacy retry entries:

1. Assume legacy entries are present. Do not dump or log raw Redis queue members
   to check; they may contain task data.
2. Stop and drain every v2 worker instance. Wait for each worker to finish its
   in-flight work and exit cleanly.
3. Use the deployment's real service manager or container platform to verify
   that no v2 process or replica remains. The guide cannot give one universal
   command because Forge supports both local and split deployments.
4. Only after that verification, start the current workers.

If a deployment accidentally overlaps versions and v2 wins the canonical
promotion of the same retry entry, the current worker records the fixed, nonfatal
`mixed_version_retry_promotion` category and continues its loop. That result is
not a successful promotion by the current worker, and Forge does not fabricate
a receipt. This containment does not let v2 read legacy plain-JSON entries and
does not remove the full stop-and-drain requirement.

The compatibility window is the drain period while a v2 worker may still be
finishing work. It ends when every v2 worker has stopped. There is no
compatibility key or manual receipt cleanup. The normal opaque disposition
receipts expire after 15 minutes and remain subject to bounded pruning.

For rollback, first stop and drain the current workers. If legacy retry entries
may remain, do not restart v2 workers; resume the current version or follow the
deployment's existing documented restore path. Do not invent a destructive
queue-cleanup procedure, edit receipts, or assume that rollback is automatically
safe.

## First Login And Providers

The first account creates a password and, by default, a passkey. For password
only, set this before creating the first account:

```bash
FORGE_PASSKEYS_ENABLED=0
```

Forge is single-user by default. If an uninstall kept settings and credentials,
the existing account remains in Postgres and registration stays closed after
reinstall. Reset that account from the host shell:

```bash
forge reset-credentials
```

The reset command also clears password sign-in throttle keys left in Redis, so
you do not need to wait for the retry window after repeated failed attempts.

Provider keys are needed only for the providers you configure. Forge stores
provider API keys encrypted in the database when entered through the UI. Fixed
cloud providers can also use the allowlisted environment variables below.
Custom, LiteLLM, and local endpoints do not read arbitrary Forge server
environment variables as API keys; enter any required key in the UI or configure
it inside the gateway.

Common provider variables:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LITELLM_BASE_URL` | LiteLLM gateway |
| `LITELLM_API_KEY` | Optional LiteLLM gateway key, for the gateway itself |

### ACP Providers

ACP providers connect Forge to local coding CLIs through the Agent Client
Protocol. In plain terms, Forge starts a small adapter process, sends it a
prompt, and reads the agent's streamed text response.

For the currently wired ACP adapters:

- Forge starts a pinned local adapter binary from `node_modules/.bin`.
- The adapter subprocess receives a deny-by-default environment allowlist; Forge
  provider keys, GitHub tokens, database URLs, Redis URLs, and encryption
  secrets are not forwarded.
- The adapter wraps the local `codex` or `claude` CLI.
- The local CLI must already be installed and logged in.
- The Forge project must have a local folder so Forge can validate and bound
  repository context. Architect planning uses an isolated runtime directory.
  Specialist ACP sessions are currently unavailable. The
  `FORGE_ACP_WORK_PACKAGE_EXECUTION` setting is reserved and cannot override
  the missing confined writer; ACP adapters are local processes and are not
  OS-confined by Forge.
- Installing the Zed editor is not required; Forge uses Agent Client Protocol
  adapter packages, not the editor itself.

See [ACP and the Zed connector](acp-zed-connector.md) for the full simple
explanation and troubleshooting checklist.

GitHub repository operations prefer the encrypted PAT from Settings, then the
authenticated `gh` CLI token. The legacy clone env-var fallback is limited to
`GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, or `FORGE_GITHUB_TOKEN`; arbitrary
server env vars are rejected.

## Test The Orchestrator

After install:

```bash
cd web
npm run doctor
```

Then create a project and task in the dashboard. A successful Orchestrator-stage
run moves through:

```text
Pending -> Running -> Awaiting Approval -> Completed
```

No-cost mock test:

```bash
cd web
FORGE_WORKER_MOCK_ARCHITECT=1 npm run dev
```

The task should reach `Awaiting Approval` with a plan that starts with
`Mock architect plan...`. That proves the dashboard, database, Redis, worker,
and approval flow are connected.

Provider reachability test:

```bash
cd web
npm run test:providers
npm run test:providers -- --provider "Provider Name"
```

### PostgreSQL proof commands

For the CI-style database boundary checks, run the general unit suite with the
S4 PostgreSQL file excluded:

```bash
cd web
npm run test:unit:zero-skip
```

Run `npm run test:mcp:s4-postgres` only against a freshly migrated, isolated
database with the S4 administrator, ordinary application, packet issuer, and
Architect writer/resolver/history-reader URLs configured. CI sets
`FORGE_S4_REQUIRE_POSTGRES_TEST=1` and fails if the command reports a skipped S4
test or no passing test. This proves the configured database boundary and test
fixture; it is not a complete proof of production safety.

For the separate legacy-data maintenance procedure, use the [legacy leakage
scrub runbook](operators/legacy-leakage-scrub-v1.md). It requires a dedicated
admin PostgreSQL connection and a private 32-byte HMAC key. The PostgreSQL
proof, Redis credential-revocation proof, and complete cross-sink proof are
separate gates; do not treat one as evidence for the others.

### Redis task-event cutover

The database-authoritative S4 runtime mode is the only authority that selects
the legacy or protected task-event path. Environment variables never activate,
downgrade, or bypass that decision. Credential selection is a separate
decision. In legacy mode, shared `REDIS_URL` is used only when neither
dedicated URL is configured. A complete, distinct, authenticated dedicated
pair takes precedence even in legacy mode. Exactly one dedicated URL is a
partial pair and fails closed. Protected mode requires the complete dedicated
pair and never falls back to shared `REDIS_URL`. The scrub command's private
`REDIS_URL` is a dedicated maintenance/admin connection. It does not authorize
a protected application to use the shared fallback.

Each protected URL must use `redis://` or `rediss://`, a username, a password,
and the same endpoint and explicit database. The publisher and subscriber
must be different ACL users. Do not use a shared principal, an unrestricted
`+select`, a broad command category, or a real password in a file, command
argument, shell history, log, or test output.

The closed-world Redis ACL contract proven by PR #290 is:

- Both users are `reset`, `on`, and `sanitize-payload`, have exactly one
  opaque password hash, and have no selectors.
- Both use only these key/channel patterns:
  `~forge:task-events:v2:*:history`,
  `~forge:task-events:v2:*:seq`, and
  `&forge:task-events:v2:*:live`.
- The publisher has only `+select|<db>`, `+ping`, `+info`,
  `+client|setinfo`, `+eval`, `+incr`, `+zadd`, `+zcard`,
  `+zremrangebyrank`, and `+publish`.
- The subscriber has only `+select|<db>`, `+ping`, `+info`,
  `+client|setinfo`, `+get`, `+zrangebyscore`, `+subscribe`,
  `+unsubscribe`, `+psubscribe`, and `+punsubscribe`.

Legacy keys, cross-prefix keys, unrelated channels, extra commands, and broad
ACL categories are outside this contract. Generate or import secrets through
a protected file, secret manager, or administrator-controlled channel; use
placeholders in operator documentation.

#### Ordered cutover checklist

1. Keep project ingress, packet issuance, and v2 producers disabled.
2. Create the Redis ACL principals and store their secrets out of process
   before the drain. Do not inject
   `FORGE_TASK_EVENT_PUBLISHER_REDIS_URL` or
   `FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL` into any running legacy web,
   worker, publisher, or subscriber process. A complete pair switches its
   task-event credentials immediately, even while database mode remains
   legacy.
3. Drain and stop every legacy process and old Server-Sent Events client
   before configuring replacement processes. Wait through the Server-Sent
   Events recycle window and verify that old Redis clients are absent.
4. Revoke or disable legacy publish/write authority and terminate remaining
   clients. Use the scrub runbook's dedicated admin connection for maintenance.
5. Preview, apply, and resume the existing scrub exactly as documented. Never
   edit a checkpoint.
6. Require a complete legacy zero scan and fail-closed v2 validation. After
   purge, permanently delete or revoke the legacy user and prove that both an
   old live connection and a fresh connection using old credentials cannot
   write.
7. Configure the dedicated URLs only on replacement processes while those
   processes remain stopped.
8. Only after those checks pass, permit the separately authorized,
   database-controlled protected-mode activation. Changing environment values
   alone cannot flip the mode.
9. Start the replacement processes with the dedicated URLs only after the
   separately authorized database activation step permits protected mode.
   Keep ingress and producers disabled until their separate release gates pass.

Do not treat expiration as erasure. The scrub exhaustively scans the full
`forge:task-events:v2:*` prefix, validates recognized `:history` and `:seq`
shapes, and treats unknown or malformed keys and invalid values as violations.
It never repairs, rewrites, expires, or deletes v2 evidence. It purges only
exact legacy `forge:task:<uuid>:history` and `forge:task:<uuid>:seq` keys.

#### Separate mandatory proof commands

Run each command against its own freshly migrated or disposable target. These
commands are destructive within their explicitly named test databases. Every
required test must pass with zero skips; a skipped proof is a failure.

```bash
# PostgreSQL: 14/14, zero skipped
FORGE_S4_REQUIRE_POSTGRES_TEST=1 npm run test:mcp:s4-postgres -- --reporter=default
# S4_SCRUB_POSTGRES_START
# S4_SCRUB_POSTGRES_AUTH_CAS_RESUME_OK
# S4_SCRUB_POSTGRES_ARTIFACT_LINK_RACE_OK

# Redis scrub: 3/3, zero skipped, disposable database 15
FORGE_S4_REQUIRE_REDIS_TEST=1 FORGE_S4_REDIS_DESTRUCTIVE_TEST=1 \
  FORGE_S4_REDIS_TEST_URL=redis://localhost:6380/15 \
  npm run test:mcp:s4-redis
# S4_SCRUB_REDIS_START
# S4_SCRUB_REDIS_V2_IMMUTABLE_OK
# S4_SCRUB_REDIS_PURGE_RETRY_OK

# Redis ACL: 3/3, zero skipped, disposable database 14
FORGE_S4_REDIS_ACL_TEST_REQUIRED=1 FORGE_S4_REDIS_ACL_DESTRUCTIVE_TEST=1 \
  FORGE_S4_REDIS_ACL_TEST_ADMIN_URL=redis://localhost:6380/14 \
  npm run test:mcp:s4-redis-acl
# S4_REDIS_ACL_ROLE_ISOLATION_OK
# S4_REDIS_ACL_DENIALS_OK
# S4_REDIS_ACL_LEGACY_REVOKED_OK
```

These are separate gates. Passing them does not claim the deferred complete
cross-sink production proof.

#### Rollback-safe handling

Before activation, keep the database mode legacy and do not inject the
dedicated URLs into running legacy processes while investigating. Creating the
ACL users and storing their secrets out of process does not select application
credentials. Never re-enable a legacy producer or user after purge or
revocation merely to roll back. Once the database mode is protected, missing
or partial dedicated URLs fail closed; changing environment variables cannot
downgrade it. Preserve the operation identity, checkpoint, and resume
credentials required by the scrub rather than editing or recreating a
checkpoint.

## Executable Workforce Beta

Workforce materialization and handoff are available after approval. Package
execution and file materialization are currently unavailable. Do not set
`FORGE_WORK_PACKAGE_EXECUTION=1` expecting it to enable execution. If
`FORGE_EMBED_WORKER` is enabled, that is the web process because it hosts the
worker loop; in split deployments, do not set it on the web-only process.

The normal path produces handoff artifacts only. You may make the unavailable
host-write setting explicit:

```bash
FORGE_HOST_REPOSITORY_WRITES=0
```

Do not set this flag to `1` or `true`. Direct host repository writes and file
materialization are unavailable, so the request fails closed before provider or
filesystem work. Path validation is not an operating-system sandbox; a real
confined writer is required before Forge can apply files automatically.
The legacy `FORGE_REPOSITORY_EDITS` alias follows the same rule. Review files
under `.forge/task-runs`, then apply accepted changes manually.

Deployments adopting the Epic #172 retention and signed-release substrate must
use the [Step 0 retention bridge runbook](operators/epic-172-step0-retention-bridge.md).
That maintenance checkpoint keeps project ingress and packet issuance disabled;
it is separate from normal day-to-day package execution.

With the default execution path:

1. The operator approves the Architect plan. Today, approval enforces only the
   required *filesystem* context grants; it does not yet run the full
   MCP/capability broker, so a plan can still block later at handoff for a
   non-filesystem MCP reason. EPIC #172 slice S2 (ADR
   [0009](adr/0009-mcp-admission-contract.md)) makes approval run the same
   admission check as handoff over a captured MCP health snapshot. Note that even
   after S2, MCP health and configuration can change between approval and handoff;
   the guarantee is only that a block already visible in the approval-time
   snapshot is surfaced at approval instead of being missed until handoff — not
   that an approved task can never block later.
2. Forge releases ready work packages and runs the MCP/capability broker.
3. Required blocked MCP/tool grants stop the package before execution. Optional
   grants can continue only when the approved fallback is non-blocking.
4. Forge prepares handoff artifacts for the eligible specialist package.
5. The package receives reviewable planning context and run-scoped instructions;
   no specialist provider or ACP process is called.
6. There is no generated execution sandbox while the confined writer is
   unavailable.
7. Review the handoff artifacts and apply any accepted changes manually.
8. QA, Reviewer, and Security gates appear when required. In this beta, those
   are manual operator decisions, not proof that separate reviewer agents ran.

EPIC #172 slice S5 hardens the task detail page so each MCP request resolves to
one of four states you can act on without reading logs (target-state UI; the
copy/badge contract lands with S5):

- **Planning context** -- the Architect only suggested an MCP; it is recorded as
  prompt instructions and never blocks handoff. Generated files stay in the
  Forge sandbox for manual review; they are not written through a live MCP tool.
- **Needs project context** -- the package needs bounded read-only filesystem
  context (`filesystem.project.read|list|search`). Approve or deny the exact
  grant shown. Approval today holds a never-approved required grant before the
  package runs; slice S3 extends the same held, zero-attempt treatment to an
  explicit denial so it is recorded and held rather than burning an execution
  attempt.
- **MCP needs setup** -- an MCP is missing/unhealthy/unauthenticated. Use the
  linked setup/retry action on the project MCP panel.
- **Deferred -- beta boundary** -- the request needs a live MCP tool handle (or a
  write/merge/admin capability). This is a product boundary, not a broken
  install; it is deferred to a later security-reviewed slice.

Operators can review:

- package status, assigned role, dependencies, acceptance criteria, and blocked
  reasons;
- proposed MCP/tool grants, broker decisions, operator-approved grant snapshots,
  and effective run-scoped instructions;
- prompt overlays and MCP-aware subtasks;
- sandbox file lists and static validation results;
- repository evidence and command audits;
- QA, Reviewer, and Security gates tied to the source run and source artifact;
- rework reasons, stale-gate replacement, and attempt history;
- structured security findings for high-risk packages.

Operators can intervene from the task detail page:

- Stop cancels a non-terminal task, marks active package/run state cancelled,
  and leaves package metadata available for diagnosis. Stopping is safe at any
  stage, including while the Architect is still planning: the worker will not
  publish plan results, materialize work packages, or complete its run for a
  task that was cancelled during the run.
- Delete removes one terminal task and its run history without deleting the
  project. Stop active tasks first.
- Retry task requeues the task from the beginning and can use the original or a
  different provider.
- Retry handoff retries a retryable blocked package after the operator fixes
  the broker, repository, or execution blocker.
- Agent history is the primary activity timeline; queue attempts are collapsed
  under it for lower-level retry evidence.

High-risk packages should not be accepted with only a checkbox. Security review
findings should name the review surface, asset, trust boundary, exploit path,
impact, required fix, evidence refs, severity, confidence, and verification
state.

What this beta does not do:

- no live MCP grants, credentials, or runtime tool handles for specialists;
- no branch creation, commits, check polling, pull requests, merges, issue
  closure, or release automation;
- no parallel specialists;
- no user-edited grant scopes;
- no autonomous QA, Reviewer, or Security agent-run gates;
- no harness-enforced execution policy for tools, reference paths, output
  schemas, or validation checks.

## Deployment Checklist

Set these for both the web process and worker:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `SESSION_SECRET` | Secret value used for local session material |
| `FORGE_SESSION_CREDENTIAL_MODE` | Session rollout mode. Keep `strict` on fresh installs; use `dual` only while old web processes are still draining. |
| `NEXT_PUBLIC_APP_URL` | Public browser URL for Forge |

Passkey deployments also need:

| Variable | Purpose |
|---|---|
| `FORGE_PASSKEYS_ENABLED` | Set `0` to disable passkeys |
| `FORGE_TRUST_PROXY` | Set `1` only behind a trusted proxy that controls forwarded IP headers |
| `WEBAUTHN_RP_ID` | Passkey domain, usually the hostname |
| `WEBAUTHN_RP_NAME` | Display name shown by passkey prompts |
| `WEBAUTHN_ORIGIN` | Public app origin, such as `https://forge.example.com` |

Worker and workspace options:

| Variable | Purpose |
|---|---|
| `FORGE_EMBED_WORKER` | Set `0` when running a separate worker |
| `FORGE_AGENT_WEB_SEARCH` | Set `0` to disable no-key web research context |
| `FORGE_AGENT_CONFIG_DIR` | Optional override for app-editable agent prompt files; must stay inside the workspace |
| `FORGE_PROMPT_UPGRADE_MODE` | `keep` or `overwrite` local workspace prompts during install/upgrade |
| `FORGE_WORKFORCE_MATERIALIZATION` | Set `0` or `false` to disable default Workforce record materialization |
| `FORGE_WORK_PACKAGE_HANDOFF` | Set `0` or `false` to disable default work-package handoff claims |
| `FORGE_WORK_PACKAGE_EXECUTION` | Reserved and currently unavailable; it cannot enable specialist execution or change the handoff-only path |
| `FORGE_HOST_REPOSITORY_WRITES` | Leave unset or disabled; enable values fail closed because path validation is not an operating-system sandbox |
| `FORGE_ACP_WORK_PACKAGE_EXECUTION` | Reserved and currently unavailable; it cannot enable ACP package execution |
| `FORGE_RUNNING_WORK_PACKAGE_STALE_SECONDS` | Defaults to `900`; retry handoff treats older running package rows as interrupted and recovers them before continuing |
| `FORGE_WORKSPACE_ROOT` | Fixed workspace root override |
| `FORGE_MCPS_ROOT` | Fixed shared MCP root override |
| `FORGE_WORKER_MAX_ATTEMPTS` | Retry ceiling per task or approval job |
| `FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS` | Stale job recovery window |
| `FORGE_REQUIRE_GITHUB_CLI` | Set `1` for doctor to fail on missing `gh` auth |

Before release:

```bash
cd web
npm run db:migrate
npm run db:seed-agents
npm run doctor
npm run lint
git diff --check
npx tsc --noEmit --pretty false
npm test
npm run build
```

Full browser smoke:

```bash
cd web
npx playwright install chromium
npm run e2e
```

### Manual QA checklist: task detail layout and badge colors (#92)

Visual changes to `web/app/dashboard/tasks/[id]/page.tsx` aren't covered by
Vitest (no jsdom/render harness in this repo). Verify by hand after touching
that file:

1. `cd web && npm run dev`, open a task that has workforce packages, an
   approval gate, required-capabilities classification, and an MCP execution
   design (a task that's reached `awaiting_approval` or later usually has
   all four).
2. At desktop width (≥1024px): confirm the `Prompt` column (left) and
   `Workforce`/`Implementation Plan` column (right) are approximately equal
   width — neither should look cramped or dominate.
3. Confirm `Required Capabilities`, `Open Questions` (if any), and `MCP tool
   access` render in the left-hand column, stacked under `Prompt`, not in
   the right-hand `Workforce` column.
4. Check badge colors are consistent across the page for the same status
   word — e.g. every `completed` badge (task header, agent runs, work
   packages, approval gates, retry history) should be the same green, every
   `failed`/`rejected`/`cancelled` badge the same red, every
   `pending`/`awaiting_*` badge the same amber.
5. Resize to mobile width (<768px): confirm both columns stack vertically
   with no horizontal overflow or clipped content.

### Manual smoke test: workforce task accept → retry → navigate (#86)

The dev-server build-manifest race this guards against (`next dev` evicting
and recompiling inactive route chunks under a long-held SSE connection) is a
timing-dependent Next.js internal behavior, not something that reproduces
deterministically in Vitest. Verify by hand after touching
`web/app/api/tasks/[id]/runs/route.ts`, `web/hooks/useTaskStream.ts`, or
`web/app/dashboard/error.tsx`:

1. `cd web && npm run dev`, sign in, open a project task with workforce
   packages.
2. Accept the first workforce task and leave the task detail page open for
   at least 60 seconds (past the SSE connection's 55s recycle point) — watch
   the Network tab: the `/api/tasks/:id/runs` request should close and a new
   one open automatically, with no "Lost connection" banner shown in the UI.
3. Retry the task, then immediately navigate to `/dashboard/projects` and
   back.
4. Confirm the page loads normally. If it doesn't, and the error overlay
   reads "The dev server is still recompiling," click Retry — confirm it
   recovers without a full `npm run dev` restart.

If step 4's overlay never appears even when forcing the original failure
(deleting `web/.next/dev` mid-request), check that
`web/app/dashboard/error.tsx`'s `isDevManifestError` matcher still matches
the current Next.js ENOENT message shape — it changes across Next versions.

## Database Updates

After pulling new code:

```bash
cd web
npm run db:migrate
```

If you changed the schema, follow the developer workflow in
[developer-guide.md](developer-guide.md).

### Legacy tasks with more than 256 work packages

Forge deliberately holds an older task if it has more than 256 work packages.
Do not split, move, or delete its packages. Use the fixed-principal archive
commands to preserve the whole source task as history and enable a separately
reviewed replacement task.

The procedure includes read-only inspection, dry-run, apply, crash-safe resume,
rollback that detaches the replacement for a fresh attempt, and cancellation that
permanently marks a bound replacement unused.
See [Archive a legacy task with more than 256 work packages](operators/local-projection-overlimit-archive-v2.md).

### Session credential upgrade in migration 0027

Migration 0027 adds the new session fields but deliberately leaves old rows
and old Redis keys unchanged. Old sessions get their expiry from Redis, so a
database migration cannot safely guess that lifetime.

For a rolling deployment, use this order:

1. Set `FORGE_SESSION_CREDENTIAL_MODE=dual` on the new web processes. New
   processes then write both the old and new Redis key formats while old web
   processes finish their requests.
2. Stop or drain every old web process. Set the mode back to `strict` and
   restart the new processes. Do this before reconciliation.
3. Preview the database state. This command changes nothing:

   ```bash
   cd web
   npm run session-credentials:reconcile
   ```

4. Reconcile and purge old keys:

   ```bash
   npm run session-credentials:reconcile -- --apply
   ```

   The command reads Redis `PEXPIRETIME`, copies that exact absolute expiry to
   PostgreSQL, writes the digest-keyed cache, records a pending purge, deletes
   the old key, and only then replaces the raw-cookie database ID. A malformed,
   missing, expired, or non-expiring legacy key is revoked instead of receiving
   a guessed lifetime.
5. Rerun the same command until it reports zero remaining rows. It is designed
   to resume after a process or network failure.
6. Apply the strict cutover only after the drain is complete:

   ```bash
   npm run session-credentials:reconcile -- --apply --finalize
   ```

   Finalization performs a zero scan before making the digest and expiry
   columns required. It refuses to continue if a raw-cookie ID or pending Redis
   purge remains.

If reconciliation fails, leave the web processes in `strict` mode, fix the
PostgreSQL or Redis problem, and rerun it. Before any row has been processed,
you may return the reconciliation state to `expansion` and temporarily restore
`dual` mode. After an old key has been purged, do not roll back to old web code:
that code cannot read the new key, and affected users would need to sign in
again. After `--finalize`, rollback means restoring the new application and
database together from a pre-cutover backup; do not drop the strict constraints
or recreate raw-cookie keys by hand.

The command requires PostgreSQL 16 or newer and Redis 7 or newer on both macOS
and Linux. `--help` is safe to run without either service configured.

## Runtime Health

`GET /api/health` checks required environment variables, PostgreSQL, Redis,
GitHub CLI readiness, and provider reachability.

Status meanings:

- `ok`: ready.
- `degraded`: running, but something needs attention.
- `down`: PostgreSQL or Redis is unavailable.

## Uninstall

Preview first:

```bash
forge uninstall --dry-run
```

Remove Forge while keeping settings for a future reinstall:

```bash
forge uninstall --keep-data
```

Remove local Forge data:

```bash
forge uninstall --remove-data
```

Also remove recorded local project folders:

```bash
forge uninstall --remove-data --remove-projects
```

The uninstall script removes only packages recorded as Forge-installed. It does
not remove Homebrew, Linux package managers, Docker, or packages that existed
before Forge.

## Common Problems

If `npm run doctor` fails, check `~/Documents/Forge/config/forge.env`,
PostgreSQL, Redis, and GitHub CLI readiness.

If a task stays `Pending`, the worker is not running or cannot reach Redis.

If a task changes to `Failed`, read the task page error, check the terminal
running Forge, and confirm the Architect agent has a provider assigned.

If provider health says an environment variable is missing, add the real key to
`~/Documents/Forge/config/forge.env` and restart the web app and worker.

If `next dev` starts and then crashes with missing internal Next.js modules
such as `flight-data-helpers`, `use-merged-ref`, or
`app-next-turbopack.js`, stop Forge and run:

```bash
forge repair
```

Repair clears generated Next.js caches, verifies the pinned Next dependency,
reinstalls web dependencies if package files are missing, applies database
migrations when `DATABASE_URL` is available from the workspace env or local/dev
repo/web `.env` fallbacks, and runs the doctor. Production dotenv fallbacks are
not used by repair. It does not delete Forge data or project files.

If an ACP provider is not ready, confirm Node, the local adapter dependency,
the underlying CLI, CLI login, and the project's local folder. Then rerun the
provider health check.

If passkey registration fails, use `http://localhost:3000` locally and confirm
`WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:3000`.

## CLI Shape

Forge installs a thin global `forge` launcher for normal operator workflows.
The launcher delegates to the existing install, uninstall, web, and recovery
scripts instead of duplicating their logic.

Supported starter commands:

| Command | Purpose |
|---|---|
| `forge` | Start the local dashboard and embedded worker |
| `forge upgrade` | Sync dependencies, migrations, seeds, and checks |
| `forge repair` | Repair local caches, dependencies, migrations, and checks |
| `forge uninstall` | Remove Forge runtime pieces, passing flags through |
| `forge reset-credentials` | Prompt for a new local account password |
| `forge doctor` | Run runtime readiness checks |

See [`cli-command-architecture.md`](cli-command-architecture.md) for command
ownership, routing, and non-goals.
