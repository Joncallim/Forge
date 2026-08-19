# Issue #187 Normative Architecture Amendments — Round 13

Status: **Normative.** Apply this with the primary architecture and prior normative amendments. Where more restrictive, this document wins.

## C1. Goal operation execution is provisional until post-execution guard succeeds

For goal subjects, the shared operation executor must not create the canonical child outcome immediately after adapter/verifier completion.

Required abstract phases:

```text
request validation
policy
preflight
execution
verifier
post_execution_guard
canonical outcome
```

Existing task operation-run phase/history behavior remains compatible; implementation may represent the goal-only guard as an additive goal-subject phase/event rather than changing historical task event sequences.

Goal execution API becomes one of these equivalent reviewed patterns:

```ts
prepareGoalOperation(...): Promise<ProvisionalOperationResult>
finalizeGoalOperationAfterGuard(...): Promise<OperationExecutionResult>
```

or

```ts
executeOperation({
  ...,
  beforeCanonicalFinalize: async (provisional) => GoalPostExecutionGuardResult
})
```

Task callers omit the seam and retain existing behavior.

The goal post-execution guard revalidates, using the exact current run lease and stored binding:

- PostgreSQL project/run/lease/policy/filesystem authority;
- current registry head + live registry manifest;
- TrustedProjectRootLease/current path identity;
- GoalRepositoryProfileV1 and its keyed metadata/index/config fingerprints;
- exact HEAD OID + symbolic-HEAD state;
- operation verification-input fingerprint;
- current Operation Catalog definition, eligibility and execution-profile digest;
- deadline/system availability.

Only after all of these pass may the protected goal child-finalizer create a canonical `completed` pass or `functional` fail.

Any guard mismatch overrides the provisional verdict with the exact non-functional authority/evidence/infrastructure/cancelled outcome. If guard/quiescence cannot be established, do not canonicalize the provisional verdict; enter recovery-required according to the primary recovery contract.

## C2. Goal child persistence records post-attestation validity

Goal-subject `operation_runs` / a goal-owned child evidence table gains an immutable postcondition identity, conceptually:

```text
evidence_validated boolean
post_attestation_fingerprint keyed/sha fingerprint
post_attested_at timestamp
```

Shape rules:

- task subject: new goal-only fields null/legacy-compatible;
- goal running/nonterminal: validation fields null;
- goal terminal decisive pass/functional fail: `evidence_validated=true` and post-attestation fingerprint required;
- goal terminal non-functional after an explicit successful guard classification may also store its validation fingerprint when relevant;
- an uncertain/recovery-required child never claims `evidence_validated=true`.

Protected child-finalization derives/validates this shape; ordinary application SQL cannot set it arbitrarily after the fact.

## C3. Reliability-v2 eligibility predicate

A goal child may enter capability reliability only when:

```text
subject_kind = verification_goal_run
operation_run terminal
canonical outcome terminal
post_execution_guard completed
evidence_validated = true
stored post-attestation fingerprint re-derives correctly
evidence-unit fingerprint re-derives correctly
no evidence drift
```

The parent overall goal outcome remains excluded.

A later unrelated child/run condition may make the parent overall run inconclusive; an earlier child can still be a valid operation-capability observation **only if its own post-guard evidence remains complete and stable for its captured evidence unit**. Reporting must not mislabel that child observation as an overall goal result.

## C4. Protected HMAC key stays in the parent Forge security boundary

The TrustedRootCommandLauncher / Node shim must never receive the persistent repository-evidence HMAC secret through argv, environment, stdin or a normal child-readable file.

For sensitive metadata:

1. shim performs anchored no-follow structural reads/checks;
2. shim computes a bounded domain-tagged inner SHA-256 digest (or equivalent collision-resistant ephemeral digest) over canonical sensitive bytes/set;
3. shim returns only the inner digest plus safe structural result through private IPC;
4. parent worker immediately computes domain-separated HMAC over:
   - evidence contract/version;
   - evidence kind;
   - project/run binding as required;
   - inner digest;
5. parent persists only HMAC digest + digestKeyId;
6. raw values and inner digests are never logged/persisted/public evidence.

The stable HMAC key remains in the parent Forge protected secret service. Tests inspect child environment/argv and prove the key/sentinel is absent.

## C5. Execution profile pins the post-execution guard

Extend `GoalOperationExecutionProfileV1`:

```text
postExecutionGuardContractVersion
postExecutionGuardDigest
```

The digest covers the required postcondition families, not environment-specific values. Registry execution binding pins this profile. Weakening/removing the post-execution guard changes the binding and requires explicit re-import.

## C6. Goal command audit semantics

Normative terms:

- `repository_command_audit` / command audit = immutable execution evidence that a fixed process invocation occurred;
- command audit may exist without a canonical child verdict;
- exit code alone is never a goal verdict;
- orphan audit after crash/lease loss remains evidence only;
- recovery never synthesizes a pass/fail from an audit;
- canonical child verdict exists only after deterministic verifier + post-execution guard + protected finalization.

## C7. Verification/release tests added

Mandatory tests include:

- branch/profile/registry changes between adapter return and canonical finalization -> provisional result suppressed, non-functional outcome/recovery;
- mutation removing one post-guard check changes profile digest/source-contract failure;
- reliability ingest refuses a terminal-looking goal child lacking `evidence_validated`;
- earlier child remains valid operation evidence when later child is inconclusive, while overall goal remains inconclusive;
- HMAC key sentinel absent from shim argv/env/stdin and only outer keyed digest is persisted;
- orphan command audit never becomes pass/fail through recovery.
