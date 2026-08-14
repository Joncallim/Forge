# ADR 0013: Verification goal definition registry

**Status:** Accepted for the first slice of issue #187

**Date:** 2026-08-14

## Decision

A project may describe the behaviours it wants Forge to verify in JSON files
under `.forge/verification-goals/`. This first slice only validates and stores
those descriptions. It does not run them and a stored row never means a goal
passed.

The registry accepts direct-child `.json` files only. Directories, symlinks,
special files, unsafe names, and files that escape the project are rejected.
File count, file size, total size, and JSON nesting are bounded. Forge validates
the whole registry before writing any snapshots, so one invalid file means no
database changes.

## Version 1 format

Every definition has exactly these fields:

```json
{
  "schemaVersion": 1,
  "goalId": "repository-readable",
  "definitionVersion": 1,
  "title": "Repository remains readable",
  "description": "Forge can inspect the trusted project without running repository code.",
  "capability": "filesystem.project.read",
  "severity": "high",
  "enabled": true,
  "operations": [
    {
      "operationId": "repository.status.read",
      "operationVersion": 1
    }
  ]
}
```

`severity` is `low`, `medium`, `high`, or `critical`. A registry contains at
most one current file for a `goalId`. To change a goal, replace its file and
increase `definitionVersion`; old snapshots remain in PostgreSQL.

Operations are references to the existing deterministic operation catalog.
They must be enabled, not deprecated, use the same capability as the goal, and
require no inputs. Version 1 has no place for commands, arguments, working
directories, paths, tools, adapters, policy overrides, or custom executable
content. Unknown keys and versions fail closed.

Forge sorts operation references, writes a canonical JSON object, and computes
a domain-separated SHA-256 digest. Registry results are sorted by `goalId`, so
filesystem order cannot change an import.

## Storage and conflicts

`verification_goal_snapshots` is an append-only project-scoped table. Its
identity is `(project_id, goal_id, definition_version)`.

- Importing the same identity and digest returns the existing snapshot.
- Importing the same identity with a different digest is a hard conflict.
- A registry import is one transaction; a conflict rolls back the whole import.
- Removing a source file does not delete historical snapshots.
- The ordinary application login can select and insert snapshots, but cannot
  update or delete them. A database trigger also rejects privileged mutation.

The table stores only identity fields, the validated canonical definition, its
digest, the bounded repository-relative source path, and the creation time. It
does not store a source revision because this slice does not yet have a safely
bound revision at import time.

## Deferred work

Later slices must separately design and review goal runs, dispatch and
execution, manual-run application programming interface (API) and user
interface (UI), schedules and Redis queueing, canonical outcomes, reliability
ingestion, last-green and first-failure state, retries, notifications, and all
issue #188 integration. Nothing in this registry authorizes execution or an
automatic repair.
