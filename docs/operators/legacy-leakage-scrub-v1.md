# Legacy leakage scrub runbook

This maintenance command removes old task-log, artifact, work-package, approval,
and legacy Redis event data that older Forge writers may have copied into
durable storage. It is a one-way cleanup tool. It does not make old data safe to
expose, and it does not rewrite protected Architect plan history.

The command must run only after old web, worker, event-publisher, and subscriber
processes are stopped or drained, their write credentials are revoked, and Forge
has recorded the signed `s4_producers_disabled` receipt. Close old Server-Sent
Events connections through their recycle window and verify old Redis clients
are absent before scrubbing. Use a dedicated admin PostgreSQL connection and a
private Redis maintenance/admin connection. The ordinary application role is
rejected. This receipt is an existing precondition; the scrub command does not
invent or issue a new release receipt.

## Required secrets and connections

Set these values only in the private environment used by the maintenance
operator. Do not put them in this document, shell history, logs, tickets, or
CI output.

- `FORGE_DATABASE_ADMIN_URL` — the dedicated PostgreSQL admin connection for
  the scrub. It is not `DATABASE_URL`.
- `REDIS_URL` — the operator-private Redis maintenance/admin connection whose
  legacy namespaces are scanned and, during apply/resume, purged. This is not
  permission for a protected application to use the shared application
  fallback.
- `FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY` — a private HMAC key containing
  exactly 32 random bytes, encoded as 64 lowercase hexadecimal characters or
  base64. Generate it without printing it, for example:

  ```bash
  umask 077
  key_file="$(mktemp)"
  openssl rand -hex 32 >"$key_file"
  # Import the accepted text directly from the protected file; never cat or echo it.
  export FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY="$(<"$key_file")"
  rm -f -- "$key_file"
  ```

  The parser decodes exactly 32 bytes: this example produces the accepted
  64-character hexadecimal form. Keep the file private until it is imported
  into the deployment secret store or the operator's private command
  environment.

- `FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID` — a bounded, non-secret
  label for that key. It must start with a letter or digit and contain only
  letters, digits, `.`, `_`, `:`, or `-`, with at most 100 characters. Use the
  same key and key ID for every resume of one operation.

The example file leaves these scrub values blank. The private key is never
stored in a checkpoint and is never printed by the command.

## What is scrubbed and what remains authoritative

The command has one closed database mutation inventory. It may inspect and
update only:

- `task_logs.message`, `task_logs.front_matter`, and `task_logs.metadata`;
- eligible, unversioned legacy Architect `artifacts.content` and
  `artifacts.metadata` only;
- `work_packages.metadata`;
- `approval_gates.metadata`; and
- the operation-scoped `app_settings` checkpoint key at
  `epic172:s4:legacy-leakage-scrub:v1:<operation-id>`.

Redis is a separate boundary, not part of that database inventory. Apply and
resume purge only exact legacy keys matching
`forge:task:<uuid>:history` and `forge:task:<uuid>:seq`. They exhaustively scan
the full `forge:task-events:v2:*` prefix, validate recognized `:history` and
`:seq` shapes and values against the fixed event schema and sentinel set, and
fail closed on unknown or malformed v2 keys. The scrub never repairs, rewrites,
expires, or deletes v2 evidence. Expiry is not erasure.

The corresponding current v2 history key shape is
`forge:task-events:v2:{taskId}:history`.

Protected Architect plan entries are not selected or updated. The scrub also
does not change `architect_plan_versions` or `architect_plan_entries` content.
The authoritative sources that remain separate include canonical
`tasks.prompt`, question and answer records, internal task/attempt/run error
fields, protected plan tables, and ordinary non-plan artifact content. Keeping
these records does not grant a generic API, log, export, or operator permission
to expose their contents.

Legacy task-log text is replaced by the fixed
`legacy_task_log_unavailable` marker. Legacy output-like values become only
count-only `unknown_legacy_digest` records. The result is fixed and
non-disclosing: it reports bounded counts, phases, timestamps, and keyed opaque
fingerprints, never the historical source text, paths, secrets, or sentinels.

## Checkpoint rules

Apply and resume use an immutable checkpoint v2 shape. It binds the operation
to `operationId`, `actor`, `authorizationReceiptId`,
`fingerprintKeyId`, and the keyed `sentinelSetFingerprint`, along with the
phase, row/checkpoint fingerprints, counters, and database time. Every row and
checkpoint update is compare-and-set protected. A row conflict pauses rather
than overwriting a concurrent writer; a crash after commit can be resumed.
The checkpoint begins with the exact `schemaVersion: 2` contract.

Version 1, malformed, incomplete, mismatched, or manually edited checkpoints
fail closed. Start a fresh `--apply` operation; never edit a checkpoint by hand.
Resume must use the same operation ID, actor, receipt, key ID, private key, and
sentinel set as the original apply.

## Preconditions

Before preview or apply, confirm that:

1. ingress, issuance, and v2 producers remain disabled;
2. old web, worker, publisher, and subscriber writers are stopped and drained;
3. old Server-Sent Events connections have passed their recycle window and old
   Redis clients are absent;
4. their database and Redis credentials are revoked or disabled;
5. the signed exact `s4_producers_disabled` receipt is present;
6. the authoritative release state is disabled;
7. the dedicated admin PostgreSQL and private Redis maintenance connections are
   available; and
8. you have a unique operation ID for apply.

If a row or checkpoint conflict occurs, keep old writers stopped and investigate
before resuming. A process crash or lost response is handled by rerunning the
same resume command. A completed resume performs a full database and Redis
zero-scan. It fails if leakage reappears, if a v2 value violates its fixed
allowlist, or if a protected artifact becomes linked while the scrub is waiting
on its row lock.

## Preview

From `web/`, preview without changing rows, checkpoints, or Redis keys:

```bash
npm run protocol:scrub-legacy-leakage -- \
  --actor <operator-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id>
```

Add rollout-specific sentinels by repeating `--sentinel`:

```bash
npm run protocol:scrub-legacy-leakage -- \
  --actor <operator-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id> \
  --sentinel <task-prompt-sentinel> \
  --sentinel <path-sentinel>
```

Stop if the preview reports an incomplete Redis scan or a v2 violation.

## Apply and resume

Start one bounded operation:

```bash
npm run protocol:scrub-legacy-leakage -- \
  --actor <operator-id> \
  --apply \
  --operation <operation-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id> \
  --sentinel <task-prompt-sentinel>
```

Resume the same operation after a conflict, crash, or lost response:

```bash
npm run protocol:scrub-legacy-leakage -- \
  --actor <operator-id> \
  --resume \
  --operation <operation-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id> \
  --sentinel <task-prompt-sentinel>
```

`--batch-size` and `--max-batches` are bounded controls for each invocation.
Repeat resume until the JSON result reports `"phase":"complete"` and
`"state":"complete"`. A completed resume is read-only verification; it does
not silently delete newly reappeared data.

## Proof boundary

The focused real-PostgreSQL proof is run in CI against a freshly migrated,
isolated database:

```bash
FORGE_S4_REQUIRE_POSTGRES_TEST=1 npm run test:mcp:s4-postgres -- --reporter=default
```

The test must report all tests passed with zero skips and emits these markers:

- `S4_SCRUB_POSTGRES_START`;
- `S4_SCRUB_POSTGRES_AUTH_CAS_RESUME_OK`;
- `S4_SCRUB_POSTGRES_ARTIFACT_LINK_RACE_OK`.

That proof covers the PostgreSQL authorization, row/checkpoint compare-and-set,
resume, reappearance, and protected-artifact link-race contracts. It does not
claim the separate Redis credential-revocation/namespace proof or the combined
cross-sink production boundary by itself. Those are separate gates and must be
run together through the mandatory proof below.

## Combined cross-sink production proof

The mandatory combined CI proof is
`cross-sink-production-sentinel.postgres-redis.test.ts`. It must pass exactly
1/1 and emit `S4_CROSS_SINK_PRODUCTION_SENTINEL_OK`. It composes the supported
production writers, readers, routes, projections, and scrub adapters against
disposable PostgreSQL and Redis services and verifies the supported sink set
collectively:

- canonical `tasks.prompt` authorization;
- task API projections;
- logs and export;
- Server-Sent Events live, snapshot, and replay;
- Redis history, sequence, and live data;
- worker diagnostics;
- the scrubbed database inventory;
- the signed producers-disabled receipt;
- zero-scan and reappearance checks; and
- legacy Redis ACL revocation.

This is exact hosted disposable-service release evidence, not a production
deployment, not proof for arbitrary future producers or sinks, and not proof of correctness. New producer or sink surfaces must extend the proof corpus and
inspection before they can rely on this marker. It does not imply that the
future specialist, ACP, or three-lease execution lifecycle is implemented or
enabled.

## Redis ACL and protected-mode cutover

The database-authoritative S4 runtime mode alone selects legacy or protected
task-event operation. Environment variables never activate, downgrade, or
bypass that decision. Credential selection is a separate decision. In legacy
mode, shared `REDIS_URL` is used only when neither dedicated URL is configured.
A complete, distinct, authenticated dedicated pair takes precedence even in
legacy mode. Exactly one dedicated URL is a partial pair and fails closed.
Protected mode requires the complete dedicated pair and never falls back to
shared `REDIS_URL`.

The Redis URL used by this scrub is an operator-private maintenance/admin
connection. It is not authorization for a protected application to use the
shared fallback. Do not put real passwords or hashes in this runbook, command
arguments, shell history, logs, or test output; use a protected secret file,
secret manager, or administrator-controlled import channel.

Create the Redis ACL principals and store their secrets out of process before
the drain. Do not inject `FORGE_TASK_EVENT_PUBLISHER_REDIS_URL` or
`FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL` into any running legacy web, worker,
publisher, or subscriber process. A complete pair switches task-event
credentials immediately, even while database mode remains legacy.

Drain and stop every legacy process and old Server-Sent Events client before
configuring replacement processes. Revoke the legacy write authority and
terminate remaining clients. Complete preview/apply/resume, the legacy zero
scan, and fail-closed v2 validation. Permanently delete or revoke the legacy
user and prove the old live connection and fresh old
credentials cannot write. Configure the dedicated URLs only on replacement
processes while those processes remain stopped. Only then permit the separately authorized,
database-controlled protected-mode activation. Start the replacement processes
with the dedicated URLs only after the separately authorized database
activation step permits protected mode. Environment changes alone cannot flip
the mode. Keep ingress and producers disabled until their separate release
gates pass.

The closed-world ACL contract proven by PR #290 uses `reset`, `on`,
`sanitize-payload`, exactly one opaque password hash, no selectors, one endpoint,
and one explicit database. Publisher keys/channels are
`~forge:task-events:v2:*:history`, `~forge:task-events:v2:*:seq`, and
`&forge:task-events:v2:*:live`; its only commands are
`+select|<db>`, `+ping`, `+info`, `+client|setinfo`, `+eval`, `+incr`,
`+zadd`, `+zcard`, `+zremrangebyrank`, and `+publish`. Subscriber keys/channels
are the same; its only commands are `+select|<db>`, `+ping`, `+info`,
`+client|setinfo`, `+get`, `+zrangebyscore`, `+subscribe`, `+unsubscribe`,
`+psubscribe`, and `+punsubscribe`. Broad categories, unrestricted `+select`,
shared principals, legacy/cross-prefix keys, unrelated channels, and extra
commands are prohibited.

## Separate mandatory proof commands

Run each command against its own freshly migrated or disposable target. These
commands are destructive within their explicitly named test databases. Each
proof must pass with zero skips; a skipped proof is a failure.

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

These are separate gates and do not replace the mandatory combined cross-sink
production proof. Before activation, keep the database mode legacy and do not
inject the dedicated URLs into running legacy processes while investigating.
Creating the ACL users and storing their secrets out of process does not select
application credentials. After protected activation, missing or partial
dedicated URLs fail closed and environment changes cannot downgrade the mode.
Preserve checkpoint and resume identities; never edit a checkpoint or recreate
a revoked legacy user to roll back.
