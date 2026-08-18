# Issue #187 Architecture Review — Round 13

Architecture under review = primary + normative Round-11 + normative Round-12 amendments.

Status: **One execution-order blocker and two security/evidence boundary findings found. Amendment required.**

## R13-F1 — child outcome finalization occurs before post-command evidence re-attestation

Severity: Blocker

Angle: Runtime ordering / canonical outcome integrity

The primary runner flow currently says:

```text
execute child
-> lease-fenced child audit/outcome/evidence
-> post-check profile/HEAD/clean/live registry
```

That is too late. A branch/index/registry/root or project authority change during the command window can make the command's provisional result stale. If the child has already been canonicalized as a functional failure/pass, the later post-check can make the parent inconclusive but leaves a misleading child outcome that could feed #186.

Required amendment:

Goal-subject operation execution becomes explicitly two-stage around canonical finalization:

```text
pre-attest exact repository/registry/authority
-> protected begin exact child ordinal
-> run fixed adapter + deterministic verifier (PROVISIONAL result only)
-> write protected command audit as execution evidence
-> post-execution guard re-attests:
     DB lease/authority
     live registry == imported binding
     TrustedProjectRootLease/path identity
     GoalRepositoryProfileV1
     exact HEAD OID + symbolic-HEAD verification input
     strict clean/index/config/profile fingerprints
     operation/catalog/eligibility/profile contract
-> only if guard passes may protected child-finalize store the canonical pass/functional-fail outcome
-> if guard detects drift, child canonical outcome is non-functional evidence/authority inconclusive, never the provisional functional result
```

Implementation contract:

- shared operation executor gains an optional goal-subject `beforeCanonicalFinalize` / post-execution guard seam, or is refactored into prepare-result + finalize phases;
- existing task callers keep current behavior when the seam is absent;
- the guard runs after deterministic adapter verification but before `OperationLedger.finalize` for goal subjects;
- guard failure has a closed non-functional outcome mapping;
- if the guard itself cannot settle before lease/deadline, the child/run enters recovery-required uncertainty; it does not infer the provisional result;
- goal operation row stores an `evidence_validated`/post-attestation fingerprint (closed immutable field or equivalent) only when this guard succeeds.

This is required for both pass and functional fail. A functional verdict is not authoritative until its postcondition evidence is stable.

## R13-F2 — reliability-v2 ingest must require a post-guard validated child

Severity: High

Angle: #186 evidence ingestion

It is not sufficient to ingest any terminal child outcome merely because it is syntactically decisive.

Required amendment:

Goal-subject reliability ingest requires:

- child operation is terminal;
- canonical outcome created only through the post-execution guard path;
- `evidence_validated=true` / exact post-attestation fingerprint is present and re-derivable;
- child evidence unit matches the stored repository/environment/verification-input state;
- no later evidence-drift adjudication/reader mismatch for that child.

Parent overall result need not be decisive if an earlier child was independently post-guard validated before a later unrelated inconclusive condition; however, the child's own evidence must remain complete and stable. If the parent becomes inconclusive because the repository state changed after that child, the earlier child may remain a valid operation capability observation for its captured evidence unit, but it is never treated as an overall goal pass/fail.

Tests must distinguish these two truths.

## R13-F3 — protected HMAC key material must not be handed to the root shim

Severity: High

Angle: Secret boundary / subprocess design

Round 11 requires keyed HMAC fingerprints for raw Git config/index/path-derived evidence, while the root-anchored shim is the process that can safely read those files after anchoring `.git`. Passing the stable Forge HMAC secret in shim argv/environment would expose protected key material to a child-process surface and possibly process inspection.

Required amendment:

- the root shim receives **no Forge secret/HMAC key**;
- after anchored no-follow reads, it may compute bounded domain-tagged **ephemeral unkeyed inner digests** of sensitive bytes/path sets and return those through its private structured IPC result;
- the parent Forge worker immediately wraps each inner digest with the protected domain-separated HMAC service;
- inner unkeyed digests are memory-only: never DB/log/API/Redis/audit/reliability evidence and never error text;
- raw config/index/path values likewise remain shim/parent memory only as strictly needed for structural checks;
- alternatively, a future OS-protected FD/key-service IPC can compute the HMAC without revealing key material, but that is not required for v1;
- keyed outer digest + key id are the only persisted sensitive-metadata fingerprints.

The HMAC construction must bind the evidence kind, project/run context or relevant contract domain so the same inner digest cannot be replayed across unrelated evidence types.

## R13-F4 — post-execution guard must be part of the operation execution-profile digest

Severity: High

Angle: Semantic pinning

The guard determines whether a provisional operation result becomes canonical. Its semantics are therefore part of the operation contract, not only runner plumbing.

Extend `GoalOperationExecutionProfileV1` with:

```text
postExecutionGuardContractVersion
postExecutionGuardDigest
```

The registry execution binding pins these values. Weakening/removing a required postcondition check changes the profile digest and requires explicit registry re-import before execution.

## R13-F5 — command audit is evidence, not a verdict

Severity: Medium

Angle: Operator/recovery semantics

The review should freeze this terminology:

- command audit may be written immediately after/around the command and can survive an incomplete child;
- command audit records what process ran and bounded output/exit evidence;
- it is never sufficient to infer functional pass/fail;
- only post-guard canonical child outcome is a verdict;
- recovery preserves orphan command audits without promoting them to proof.

This avoids a lower-tier implementer treating an audit row plus exit code as completion during recovery.

## Round 13 conclusion

The remaining blocker is ordering: post-command evidence validation must precede canonical child outcome finalization. The HMAC key/shim boundary and profile pinning should be amended at the same time. After that, restart a fresh full architecture review.