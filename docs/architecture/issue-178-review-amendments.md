# Issue #178 Architecture Review Amendments

This document is authoritative where it narrows or clarifies `issue-178-filesystem-grant-recovery.md`.

## Review round 1 findings and resolutions

### 1. `allow_once` was incorrectly included in project-wide reconciliation

The shared project-wide reconciliation requirement applies to project-scoped `always_allow` mutations, including the `always_allow` path initiated from the task endpoint and the project endpoint. A package-local `allow_once` decision must not scan or recover unrelated project packages.

Revised service boundary:

```ts
async function reconcileFilesystemGrantsForProject(
  tx: DbTransaction,
  input: {
    lockedProject: LockedProject;
    trigger: 'task_always_allow' | 'project_always_allow' | 'project_grant_revocation';
    actorId: string;
  },
): Promise<FilesystemGrantReconciliationResult>;
```

Package-local `allow_once`, denial, and reapproval use a package-scoped mutation path under the same global lock order and may reevaluate/recover only the targeted package. The task endpoint delegates to project-wide reconciliation only when its selected mode is `always_allow`.

### 2. Reconciliation must compose with an already-locked project transaction

The reconciliation service must not reacquire the project lock or reread project state independently. The endpoint owns authorization and begins the transaction; the service receives the locked project row and fresh `nextMcpConfig`. This avoids nested lock acquisition and makes the persistence source explicit.

Suggested call shape:

```ts
reconcileFilesystemGrantsForProject(tx, {
  lockedProject,
  nextMcpConfig,
  trigger,
  actorId,
});
```

The service asserts that the project row was locked by the caller and uses no pre-transaction project object for writes.

### 3. Lock ordering must remain compatible with #179 issuance

The cross-slice global order is:

```text
project → task(s ascending) → package(s ascending) → grant approval → runtime audit claim
```

#178 normally stops at package rows. If a grant endpoint rotates an approval nonce after #179 lands, it must continue to the approval row only after all project/task/package locks required by that transaction have been acquired. #178 must not introduce package → task or approval → package paths.

### 4. Recovery must distinguish wake-up from recovery truth

Database recovery commits first. Redis enqueue happens after commit and may be retried. To avoid duplicate semantic work, the reconciliation result contains a deduplicated set of task IDs; queue duplication remains harmless because worker claims are conditional and PostgreSQL is authoritative.

### 5. Historical failed-package recovery is migration-only and bounded

The implementation should prefer explicit existing filesystem block metadata. A legacy failure-signature adapter, if required, must be:

- versioned;
- exact and test-fixture-backed;
- unable to match generic executor failures;
- removed or disabled after the supported migration window.

It must not infer recoverability from filesystem requirements alone.

## Review round 2 conclusion

The amended architecture now keeps `allow_once` package-local, provides one shared project-wide path for equivalent `always_allow` decisions, composes with endpoint-owned locks, and remains compatible with #179's extended lock order. No further architecture findings were identified in the reviewed scope. This is not proof of implementation correctness; real PostgreSQL concurrency tests remain mandatory.
