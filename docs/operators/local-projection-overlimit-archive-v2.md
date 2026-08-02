# Archive a legacy task with more than 256 work packages

Forge can build a task's local-change summary from at most 256 sibling work
packages. Migration 0026 puts an older task with 257 or more packages into an
`archive_pending` hold. The hold is deliberate: Forge must not silently ignore
some packages or build a partial summary.

This procedure preserves the old task as history and enables a separately
reviewed replacement task. It does not move, split, delete, or rewrite any old
package, run, review, artifact, or evidence row.

## Before you start

You need all of the following:

- the source task is on the typed `local_projection_package_limit` hold and its
  scope state is `archive_pending`;
- a separately planned and reviewed replacement task exists with new work-package
  identities, at most 256 packages, all eight projection heads for every
  package, and no existing replacement binding;
- no source package is running, leased, or waiting for review;
- the database migration and fixed-principal bootstrap are complete; and
- `FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL` is set to the dedicated
  `forge_local_projection_archiver` login.

Do not use `DATABASE_URL` or `FORGE_DATABASE_ADMIN_URL`. The dedicated login has
no direct table-write permission. It can call only the fixed, audited archive
routines.

An administrator installs or verifies the fixed role after migration with:

```sh
cd web
DATABASE_URL='<migration-connection>' \
FORGE_DATABASE_ADMIN_URL='<short-lived-admin-connection>' \
npm run protocol:bootstrap-epic-172-s4-roles
```

Provision certificate or local peer authentication outside Forge, then configure
the operator command without a password in the URL. For example:

```sh
export FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL='postgresql://forge_local_projection_archiver@<host>/<database>?sslmode=verify-full'
```

Add the certificate and key parameters required by your PostgreSQL platform. The
command refuses a URL for any other database user and refuses a URL containing a
password. It also refuses inherited password or service-file configuration in
`PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`, `PGSERVICEFILE`, or `PGSSLPASSWORD`.
Unset those variables before running either command.

Use universally unique identifiers (UUIDs) for the source task, replacement
task, actor, and operation values below.

## 1. Inspect both tasks

From the `web/` directory, inspect the held source:

```sh
npm run protocol:inspect-local-projection-overlimit -- --task <legacy-task-id>
```

Then inspect the replacement:

```sh
npm run protocol:inspect-local-projection-overlimit -- --task <replacement-task-id>
```

The command is read-only and prints one JSON object. Check these fields:

- the source has `"scopeState":"archive_pending"`, more than 256 packages,
  the typed over-limit count exactly equals its package count, and
  `"claimable":false`;
- an exact migration-0026 source has zero projection heads because migration
  0026 deliberately skipped the bounded projection for held tasks. Its exact
  fields are `"actualHeadCount":0`, `"distinctPackageCount":0`, and
  `"integrityState":"missing_heads"`; any nonzero partial, duplicate, or
  mismatched source-head set is corruption and must stop the archive;
- the replacement has at most 256 packages, `"replacement":null`, and
  `"claimable":true` before apply;
- the replacement projection has `"expectedHeadKindCount":8`, equal expected
  and actual head counts, and `"integrityState":"coherent"`.

Stop if any ID, count, state, or fingerprint is unexpected.

## 2. Preview the archive

Run archive without an action flag:

```sh
npm run protocol:archive-local-projection-overlimit -- \
  --task <legacy-task-id> \
  --replacement <replacement-task-id> \
  --actor <operator-user-id>
```

This is an exact dry run. It calls the same fixed inspect routine for both tasks,
prints both labeled snapshots, and makes no database change. Save the JSON with
your change record.

## 3. Start the archive

Run the same command with `--apply`:

```sh
npm run protocol:archive-local-projection-overlimit -- \
  --task <legacy-task-id> \
  --replacement <replacement-task-id> \
  --actor <operator-user-id> \
  --apply
```

Apply re-inspects both tasks and passes their exact `taskFingerprint` values to
the database. The database rejects a changed task instead of archiving a state
you did not review. It atomically binds the previously unbound replacement,
changes it to `pending` and non-claimable, records a new operation, and commits
only the `validated` checkpoint on this call. A source can have only one live
or completed archive operation, so a second replacement is rejected.

Copy the returned `operationId` and `operationFingerprint`. Every fingerprint
uses the exact `sha256:<64 lowercase hex characters>` form. Exit code `2` means
the operation is safely checkpointed but not finished. It is a prompt to resume,
not a failed archive.

## 4. Resume to completion

Resume with the latest fingerprint returned by the preceding call:

```sh
npm run protocol:archive-local-projection-overlimit -- \
  --operation <operation-id> \
  --operation-fingerprint <latest-sha256> \
  --actor <operator-user-id> \
  --resume
```

Each invocation advances at most one durable checkpoint:

1. `validated` records the reviewed source and replacement snapshots.
2. `quiesced` proves the source has no live claim, lease, or review and closes
   its ingress.
3. `archived` atomically makes the source permanent history and changes the
   replacement from `pending` to `eligible`.

After `validated` or `quiesced`, the command exits with code `2`. Copy the new
`operationFingerprint` and resume again. When it returns `archived`, it exits
with code `0` and the change is complete.

If the terminal, network, or process stops after a checkpoint, rerun `--resume`
with the last JSON result. A committed checkpoint is not repeated. Never guess
or reuse an older fingerprint.

## Stop before final archive

Two explicit recovery actions are available before `archived`.

To stop this operation while preserving the source's `archive_pending` hold and
detaching the replacement so it becomes claimable again:

```sh
npm run protocol:archive-local-projection-overlimit -- \
  --operation <operation-id> \
  --operation-fingerprint <latest-sha256> \
  --actor <operator-user-id> \
  --rollback
```

To mark the unused pending replacement `cancelled` while preserving all of its
rows and evidence:

```sh
npm run protocol:archive-local-projection-overlimit -- \
  --operation <operation-id> \
  --operation-fingerprint <latest-sha256> \
  --actor <operator-user-id> \
  --cancel
```

Rollback permits a later apply with a freshly reviewed replacement. Cancellation
keeps the unused replacement bound as `cancelled`. The database rejects either
action once the final archive is committed. `legacy_archived` is intentionally
irreversible through this tool. Do not try to reverse it with direct SQL.

After rollback, inspect the replacement again. It must show `"replacement":null`
and `"claimable":true` before a fresh attempt.

## Verify the result

Inspect both task IDs again. A completed archive must show:

- source `scopeState` is `legacy_archived` and `claimable` is false;
- every source package and relationship is still present under the source task;
- replacement state is `eligible`, its projection remains coherent, and its
  package count is at most 256; and
- the operation's final state is `archived`.

Before printing a routine result, the command verifies the exact outer object,
both bounded task snapshots, and a checkpoint that matches the returned state.
Unexpected or widened database output fails closed.

The commands print JSON only. Exit code `0` means the requested read or terminal
transition completed, `2` means apply/resume committed a non-terminal checkpoint,
and `1` means the request was rejected or failed. On code `1`, keep the source
held, inspect both tasks again, and investigate the changed state. Do not edit
the archive tables or task states by hand.
