# Issue #187 Architecture Review — Round 14 Final Fresh Pass

Architecture reviewed as one system:

- `docs/architecture/issue-187-verification-goal-run-policy.md`
- `docs/architecture/issue-187-normative-amendments-round-11.md`
- `docs/architecture/issue-187-normative-amendments-round-12.md`
- `docs/architecture/issue-187-normative-amendments-round-13.md`
- live Forge `main` contracts and schema referenced by the architecture
- Issue #187 and parent Epic #184 requirements/dependencies

Prior review files were used only as an audit trail. This pass restarted from the consolidated architecture and live code rather than asking whether old findings were patched.

## Review Verdict

Status: **No blockers found in the inspected architecture scope**

Confidence: **High for architecture completeness; implementation remains unproven.**

Reason: The current design now has closed contracts for executable goal definitions, explicit import activation, project and filesystem authority, operation eligibility and concrete execution profiles, a first-class goal-run subject, dual-subject outcome/evidence migration, PostgreSQL lease/ordinal fencing, root-anchored read-only execution, a closed supported Git/repository profile, conservative functional-failure classification, post-execution evidence guard before canonicalization, immutable evidence, sample-independent reliability, manual idempotency, recovery, DB-time scheduling with current binding heads, and downstream #188–#191 boundaries. The fresh pass did not identify another material decision that a lower-tier implementer would need to invent in order to implement the described v1 slices safely.

## Findings

No new blocking or high-severity architecture findings were found in this pass.

### Advisory A — repository-wide runtime documentation drift exists outside this PR

Severity: Low

Disposition: Advisory / separate cleanup

Angle: Documentation compatibility

`AGENTS.md` and some reader-facing runtime copy describe specialist execution more optimistically than the fail-closed boundaries documented in recent Forge project status and execution code. Issue #187 does not depend on specialist package execution: its v1 runner is a separate fixed read-only deterministic path with its own explicit authority/build gates.

Required handling:

- do not use optimistic specialist-execution documentation as an authority source while implementing #187;
- implementation must follow the live code/ADR boundaries and the explicit #187 gates;
- clean the broader documentation drift in a separate docs/status pass rather than widening this architecture PR.

### Advisory B — same-UID adversarial host race remains a stated residual, not a hidden guarantee

Severity: Advisory residual risk

Disposition: Accepted for this architecture scope

The architecture now explicitly states that a separately running malicious same-UID process deliberately racing `.git` after the last profile check is outside the portable v1 containment guarantee. Ordinary concurrent changes are detected and invalidate decisive evidence; project-root pathname rebinding is closed by the retained root lease/anchored launcher; hostile static repository configuration/helper surfaces are rejected. Stronger protection requires the OS-enforced confined execution boundary and is not silently claimed here.

This residual must stay visible in operator/security docs and cannot be weakened during implementation review.

## Orthogonal Pass Coverage

| Pass | Checked | New findings | Notes |
|---|---:|---:|---|
| Contract / #187 requirements | Yes | 0 | v2 executable goals, manual then scheduled proof, pass/fail/inconclusive, history, evidence, disabled behavior, no repair all mapped |
| Diff / architecture coherence | Yes | 0 | primary + normative amendments have no unresolved semantic contradiction found |
| Call-path / runtime flow | Yes | 0 | API/scheduler → admission → Redis → DB lease → root/Git profile → ordinal child → post-guard → terminalization traced |
| State / data / persistence | Yes | 0 | exact registry/policy FKs, dual subjects, run lifecycle, schedule heads/slots, immutable evidence, evidence units reviewed |
| Error handling / recovery | Yes | 0 | queue loss, DB uncertainty, lease loss, child uncertainty, command-audit orphan, quarantine, expiry all fail closed |
| Tests / CI / verification design | Yes | 0 | mutation/race/PostgreSQL/Redis/Git/root/E2E matrices specify evidence needed; actual implementation evidence not yet available |
| Security / permissions / secrets | Yes | 0 | owner/project authority, protected DB routines, keyed sensitive fingerprints, no child HMAC secret, trusted executables, Git profile reviewed |
| Git / filesystem containment | Yes | 0 | root TOCTOU, metadata layout, attrs/config, partial clone, replace refs, index flags, built-in commands, executable provenance covered; residual named |
| UX / API / operator experience | Yes | 0 | body-less run request, intent-bound idempotency, closed safe errors, bounded run/history reads, explicit unsupported states |
| Regression / compatibility | Yes | 0 | historical goal v1/task outcome/reliability semantics preserved through staged dual-subject migration |
| Reliability / evidence integrity | Yes | 0 | post-execution guard precedes canonical outcome; keyed verification inputs/evidence units; repeat/conflict semantics reviewed |
| Scheduler / scalability | Yes | 0 | current schedule head, immutable bindings/slots, DB-time anchors, no catch-up stampede, active/start budgets reviewed |
| Modularity / hardcoding | Yes | 0 | tunables DB-backed; code constants limited to versioned security/protocol allowlists; root/Git/HMAC modules reusable |
| Downstream #188–#191 | Yes | 0 | deterministic result immutable; verification/autonomy/Sentinel/reporting responsibilities remain separate |
| Evidence / release readiness | Yes | 0 | architecture defines gates but does not claim implementation/release readiness |

## Lower-tier implementation boundaries confirmed

An implementation agent should not need to decide any of these during coding:

- whether old goal schema v1 executes: **never**;
- whether to synthesize tasks: **never**;
- which operation versions are eligible: **exact code-owned allowlist + execution profile**;
- how repo config grants authority: **it cannot**;
- how project policy defaults: **disabled**;
- how a goal fails: **only pinned deterministic functional classifier**;
- whether generic nonzero process exit is functional: **never**;
- when a child verdict becomes canonical: **only after post-execution guard**;
- whether Redis ownership permits DB writes: **no**;
- whether stale workers may finalize: **no**;
- whether repeated same commit/state creates independent reliability samples: **no**;
- which schedule binding runs: **current protected head only**;
- whether unsupported Git metadata/config/index format is best-effort: **no, inconclusive/unsupported**;
- whether arbitrary repository tests/builds run in v1: **no**;
- whether failure repairs code or changes autonomy: **no**.

## Required Next Actions

1. Keep PR #331 draft while it is architecture-only.
2. Use the architecture's Slice A as the next implementation PR/stacked child after this architecture is accepted.
3. For every implementation slice, run the repository's full orthogonal review protocol plus the slice-specific Security/Adversarial review where it touches authority, filesystem, process execution, evidence, migrations or ACLs.
4. Do not enable manual goal execution until the Slice C root/Git/executable/evidence E2E and hosted migration/ACL proofs pass.
5. Do not enable scheduling until the later current-binding-head/multi-worker/outage/budget proofs pass.

## Remaining unchecked areas

These are intentionally not claimed by an architecture review:

- exact SQL/Drizzle migrations and protected-function implementation;
- exact root-shim process behavior on every supported macOS/Linux version;
- exact supported Git version matrix and malicious-fixture results;
- HMAC key provisioning/rotation integration in the deployed runtime;
- PostgreSQL/Redis race behavior under the implemented code;
- production performance and resource budgets under large repositories;
- actual Web CI / installer / legacy-repair / E2E evidence for implementation slices;
- OS-level protection against a malicious same-UID or privileged host actor.

## Final Statement

> No blockers were found in the inspected architecture scope. This does not prove absence of defects. The remaining uncertainty is implementation-, platform-, and release-evidence work listed above; those areas must be proven before any verification-goal execution capability is enabled.
