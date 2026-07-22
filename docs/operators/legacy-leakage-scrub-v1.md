# Remove old task-log and event payloads

This command removes historical text that older Forge versions may have copied
into task logs, artifacts, work-package metadata, or Redis event history. It
does not change protected Architect plan history.

Run it only after the old web, worker, and event-publisher processes have stopped,
their database and Redis write credentials have been revoked, and Forge has
recorded the signed `s4_producers_disabled` release receipt. Otherwise an old
process could put the data back after the scrub.

## What the command changes

Set `FORGE_DATABASE_ADMIN_URL` to the dedicated administrative PostgreSQL
connection before running this command. The ordinary application `DATABASE_URL`
is deliberately not accepted for this privileged maintenance operation.

The apply command:

- replaces old `task_logs.message` text with the fixed
  `legacy_task_log_unavailable` marker;
- replaces content only for legacy `adr_text` artifacts owned by an Architect
  run; ordinary code, diff, test, review, and log artifact content is preserved;
- treats an Architect artifact as protected only when its ID is present in the
  authoritative `architect_plan_versions` table; metadata such as
  `historyAvailable` cannot claim this exemption;
- recursively removes prompt and secret aliases from task-log front matter and
  task-log, artifact, or `work_packages.metadata` values, including the old
  `promptOverlay`, `requirementContexts`, and `mcpAwareSubtasks` producer fields;
- keeps only count-only `unknown_legacy_digest` records for legacy output-like
  snapshots;
- deletes old `forge:task:{taskId}:history` and
  `forge:task:{taskId}:seq` Redis keys;
- checks that `forge:task-events:v2:{taskId}:history` values match the fixed
  event-envelope allowlist and contain no forbidden prompt, content, path,
  locator, digest, secret, or operator-provided sentinel;
- saves a path-free checkpoint in `app_settings`, so a stopped command can resume.

It joins `architect_plan_versions` only to identify protected artifact IDs. It
never reads protected entry content and never updates `architect_plan_entries`
or `architect_plan_versions`. It also does not change the database schema.

## 1. Preview without changing anything

From the `web/` directory, run:

```sh
npm run protocol:scrub-legacy-leakage -- --actor <operator-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id>
```

The preview verifies the same fixed signed receipt as apply and resume. It reads
at most 100 rows from each database table unless you set a different
`--batch-size`. It performs complete bounded Redis cursor scans. No checkpoint
is created, no row is updated, and no Redis key is deleted.

You may add the unique test strings used during rollout. Repeat `--sentinel` for
more than one value:

```sh
npm run protocol:scrub-legacy-leakage -- \
  --actor <operator-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id> \
  --sentinel <task-prompt-sentinel> \
  --sentinel <path-sentinel>
```

Stop if the preview reports an incomplete Redis scan or any v2 violation.

## 2. Start an authorized scrub

Choose a unique operation ID. Supply the signed S4 producers-disabled receipt
recorded in `forge_epic_172_release_evidence`:

```sh
npm run protocol:scrub-legacy-leakage -- \
  --actor <operator-id> \
  --apply \
  --operation <operation-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id> \
  --sentinel <task-prompt-sentinel>
```

Every mode is rejected unless the receipt satisfies the fixed drain contract:
the canonical issue 179 `s4_producers_disabled` manifest, its exact `s4_expand`
predecessor and build bindings, its expected evidence names and signed-envelope
shape, and the current authoritative enablement state of `disabled`. The actor
and receipt are stored in the checkpoint and must remain identical on every
resume.

Each row is locked and compared with the fingerprint seen by the scanner. The row
update and checkpoint update commit together. If another writer changes the row,
the command pauses instead of overwriting it. Exit code `2` means the operation is
paused and needs inspection or resume; exit code `1` means the command failed.

The JSON output contains counts, opaque row fingerprints, the last primary key,
the current phase, and database time. It never prints the historical source text.

## 3. Resume safely

Use the same actor, operation ID, receipt, and rollout sentinels:

```sh
npm run protocol:scrub-legacy-leakage -- \
  --actor <operator-id> \
  --resume \
  --operation <operation-id> \
  --authorization-receipt <s4-producers-disabled-receipt-id> \
  --sentinel <task-prompt-sentinel>
```

Resume revalidates the authorization receipt. A previously committed row is not
reconstructed from old Redis data or a backup copy. A row that changed during the
first attempt is read again and sanitized from its current value, preserving the
concurrent safe fields.

Use `--batch-size` to cap rows per database scan and `--max-batches` to cap work
per invocation. Both default to bounded values. Repeat resume until the output has
`"phase":"complete"` and `"state":"complete"`.

## 4. Verify completion

Run the same resume command once more. A completed operation revalidates its
authorization and performs read-only zero scans over all three database sources,
both legacy Redis namespaces, and every v2 history value. It fails if database
leakage or an old namespace key has reappeared, or if a v2 value is outside the
fixed allowlist or contains a forbidden field or sentinel.

Also verify the web route writes only these keys:

```text
forge:task-events:v2:{taskId}:history
forge:task-events:v2:{taskId}:seq
```

Do not treat key expiry as deletion. Completion requires the full cursor scan to
find zero old history or sequence keys.

## Recovery

- If a row fingerprint conflicts, keep old writers stopped and resume. Repeated
  conflicts mean another writer is still active; stop and investigate it.
- If a v2 Redis violation is found, do not delete the v2 key with this command.
  Identify and stop the producer, then repair through a separately reviewed path.
- If a protected prompt context is required for a new work package, do not put
  raw text back into metadata. The package remains blocked until the server-side
  protected Architect-entry projection/resolution path provides an eligible
  reference. That API is a separate implementation dependency.
- If a completed operation later detects an old key, treat that as a revoked or
  undrained publisher recreating data. The command fails closed and does not hide
  the recurrence by deleting it automatically.
