# Issue #187 Architecture Review — Round 10

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Three material cross-subsystem gaps plus two reporting/maintenance gaps found. Amendment required.**

## R10-F1 — the Git executable itself is not yet a trusted pinned execution input

Severity: Blocker

Angle: Executable provenance / PATH injection

The design closes repository cwd and argv but still describes v1 as using "system Git through Forge's safe path policy." The current process PATH may contain workspace/project-controlled directories. A repository must not be able to become the `git` executable merely because Forge inherited such a PATH.

Required amendment:

- add a process-start `TrustedExecutableRegistry` (or equivalent reusable module);
- resolve Git to an absolute real path before any project cwd is entered;
- reject an executable residing in the Forge workspace, any registered project root, writable runtime prompt/template area, or other protected project-controlled path;
- capture file identity plus a bounded binary/content digest or equivalent reviewed executable identity at process startup;
- launch the absolute resolved executable, never `git` through child PATH lookup;
- re-stat identity before launch under the current local threat model; unexpected replacement disables goal execution;
- record Git executable identity digest/version in execution environment evidence and `GoalOperationExecutionProfileV1`;
- Node shim uses `process.execPath`/resolved absolute trusted Node identity similarly; no PATH resolution after entering the project.

A privileged host adversary able to replace system binaries/kernel state remains outside the local-project threat model and must be named as residual risk.

## R10-F2 — immutable schedule bindings need a protected current-head/supersession model

Severity: Blocker

Angle: Scheduler state / stale configuration

The current design creates immutable DB-time schedule bindings and slots, but it does not define which binding is current after a goal definition, registry binding, or project policy changes. Scanning all still-valid historical bindings risks continued execution of superseded schedules.

Required amendment:

```text
verification_goal_schedule_bindings  -- immutable
verification_goal_schedule_heads     -- one protected project+goal pointer
verification_goal_schedule_slots      -- append-only per binding+sequence
```

- reconciliation under project-first lock constructs the binding from the exact current executable registry entry + project policy + schedule declaration;
- protected CAS advances one current head to the exact new binding or to an explicit disabled/no-binding state;
- only the binding named by the current head may generate a slot;
- any registry head / execution-binding / policy change invalidates the prior head until reconciliation creates the matching current binding;
- removing/disabling a goal or schedule moves the head to disabled; historical bindings/slots remain evidence but are not scanned;
- concurrent reconciliation has one winner and is idempotent on exact binding fingerprint;
- scheduler eligibility rechecks the head and bound registry/policy in the slot-creation transaction.

## R10-F3 — process/nonzero command failure cannot automatically mean project functional failure

Severity: Blocker

Angle: Outcome semantics

The primary design currently states that a "durable functional command fail" is `functional`. A nonzero Git process can instead mean missing/changed executable, OS resource failure, permission error, corrupt/incomplete evidence, unsupported repository state, or an actual project regression. Classifying every nonzero as functional can make infrastructure failure look like "what still works" regression and feed false #190/#189 evidence.

Required amendment:

Each goal-eligible operation execution profile pins a **closed failure-classifier contract**:

```ts
type GoalOperationFailureDisposition =
  | 'functional'
  | 'policy'
  | 'authority'
  | 'infrastructure'
  | 'evidence'
  | 'cancelled'
```

- process-launch failure is never `functional`;
- deadline/abort/lease/root/catalog/policy/evidence drift are never `functional`;
- generic nonzero/unknown adapter error defaults to `infrastructure` or `evidence`, never functional;
- an operation may declare a specific functional negative only when a deterministic, versioned verifier/classifier can distinguish that semantic result from transport/process failure;
- the failure-classifier contract version/digest is included in the execution profile/registry binding;
- goal `failed` remains reachable only through an explicitly classified functional child outcome; everything else is inconclusive/recovery.

For the initial repository-read operations, classification should be deliberately conservative. If no deterministic functional-negative classifier exists, a command/process failure is inconclusive, not a project failure.

## R10-F4 — Git safety policy must be version-gated, not an open-ended denylist

Severity: High

Angle: Forward compatibility / supply-chain safety

Git documents that repository configuration can execute commands, and new Git versions may add new config or helper behavior. A static denylist combined with "any installed Git version" makes the safety proof open-ended.

Required amendment:

- define a versioned `GoalGitSafetyProfile` as a code-owned security contract;
- supported Git version families/ranges are explicit and CI-proven; unknown/unvalidated Git versions make verification-goal execution unavailable rather than falling through;
- the profile owns fixed global options/env, local-config structural inspection rules, metadata-layout rules, index/profile rules, executable identity requirements, no-lazy-fetch/no-replace behavior, and exact supported command templates;
- `GoalOperationExecutionProfileV1` references the exact Git safety profile version/digest;
- changing the supported Git safety contract changes execution binding and requires explicit registry re-import.

This is a security protocol version, not operator-editable configuration.

## R10-F5 — local config inspection itself needs a no-side-effect read contract

Severity: High

Angle: Security implementation boundary

The architecture says local `.git/config` is structurally validated but must not leave an implementer to choose a config-reading path that follows includes or invokes arbitrary repository behavior.

Required amendment:

- local config is read as a bounded real no-follow file under the anchored `.git` directory, or through an exact reviewed `git config --file .git/config --no-includes` equivalent under the safe profile;
- includes are detected as data but never followed;
- raw values/content are never logged/persisted;
- only safe normalized key names / booleans / digests cross the preflight boundary;
- malformed/oversize/unsupported config is inconclusive `unsupported_git_config`;
- adversarial tests include includeIf, filter/process, diff/helper, credential, worktree/object redirection and malformed config fixtures and prove no helper process starts.

## R10-F6 — current-health reporting should not hide a recent inconclusive run behind an older decisive streak

Severity: Medium

Angle: Operator reporting / downstream semantics

The current history text says inconclusive runs are ignored for decisive streaks. That is acceptable for a mathematically named decisive streak, but the operator/current-health contract must surface the latest observation separately so an infrastructure/evidence failure does not look like an uninterrupted current green state.

Required amendment:

History/read model reports at least:

- `latestObservationResult` (`passed|failed|inconclusive|recovery_required|expired` as applicable);
- `latestObservationAt`;
- `lastDecisiveResult` / `lastDecisiveAt`;
- decisive pass/fail streaks explicitly labelled as decisive-only;
- evidence freshness/age;
- current evidence state `stable|unstable|unavailable`.

#189/#190 must not infer current health from decisive streak alone.

## R10-F7 — supported v1 repository profile should include exact config/index/object checks as one digest

Severity: High

Angle: Modularity / drift

Round 8 and 9 add multiple Git constraints. To keep lower-tier implementation simple, collapse them behind one pure result:

```ts
type GoalRepositoryProfileV1 = {
  schemaVersion: 1
  supported: boolean
  reasonCode: closed-code|null
  objectFormat: 'sha1'|'sha256'|null
  metadataFingerprint: string|null
  indexFingerprint: string|null
  configFingerprint: string|null
  gitSafetyProfileVersion: number
  gitSafetyProfileDigest: string
}
```

The runner consumes this one audited profile result instead of reimplementing checks across admission, repository snapshot, adapters and scheduler.

## Round 10 conclusion

Material blockers remain until trusted Git executable provenance, schedule-head semantics, and conservative operation failure classification are incorporated. The Git safety/config profile and current-health read contract should be folded in at the same time. Then run a fresh full orthogonal pass from the consolidated architecture.