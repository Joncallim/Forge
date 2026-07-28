# Legacy leakage scrub runbook

This maintenance command removes old task-log, artifact, work-package, approval,
and legacy Redis event data that older Forge writers may have copied into
durable storage. It is a one-way cleanup tool. It does not make old data safe to
expose, and it does not rewrite protected Architect plan history.

The command must run only after old web, worker, and event-publisher processes
are stopped or drained, their write credentials are revoked, and Forge has
recorded the signed `s4_producers_disabled` receipt. Use a dedicated admin
PostgreSQL connection. The ordinary application role is rejected.

## Required secrets and connections

Set these values only in the private environment used by the maintenance
operator. Do not put them in this document, shell history, logs, tickets, or
CI output.

- `FORGE_DATABASE_ADMIN_URL` — the dedicated PostgreSQL admin connection for
  the scrub. It is not `DATABASE_URL`.
- `REDIS_URL` — the Redis connection whose legacy namespaces are scanned and,
  during apply/resume, purged.
- `FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY` — a private HMAC key containing
  exactly 32 random bytes, encoded as 64 lowercase hexadecimal characters or
  base64. Generate it without printing it, for example:

  ```bash
  umask 077
  key_file="$(mktemp)"
  openssl rand 32 >"$key_file"
  # Import the bytes into the deployment secret store; do not cat the file.
  rm -f "$key_file"
  ```

- `FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID` — a bounded, non-secret
  label for that key. It must start with a letter or digit and contain only
  letters, digits, `.`, `_`, `:`, or `-`, with at most 100 characters. Use the
  same key and key ID for every resume of one operation.

The example file leaves these scrub values blank. The private key is never
stored in a checkpoint and is never printed by the command.

## What is scrubbed and what remains authoritative

The command has a closed database policy. It may inspect and update only:

- `task_logs.message`, `task_logs.front_matter`, and `task_logs.metadata`;
- legacy `artifacts.content` and `artifacts.metadata`;
- `work_packages.metadata` and `approval_gates.metadata`;
- legacy Redis keys matching `forge:task:*:history` and `forge:task:*:seq`;
- v2 Redis history values matching `forge:task-events:v2:*:history`, which are
  scanned against their fixed event schema and sentinel set.

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

1. old writers are stopped and drained;
2. their database and Redis credentials are revoked;
3. the signed exact `s4_producers_disabled` receipt is present;
4. the authoritative release state is disabled;
5. the dedicated admin PostgreSQL connection is available; and
6. you have a unique operation ID for apply.

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
claim the separate Redis credential-revocation/namespace proof or the complete cross-sink production proof.
Those are later gates and must be run and reviewed separately.
