# Issue #187 Normative Architecture Amendments — Round 11

Status: **Normative.** This document is part of the Issue #187 architecture. Where it is more restrictive than `issue-187-verification-goal-run-policy.md`, this document wins. It incorporates the findings from `issue-187-review-round-11.md` without rewriting historical review evidence.

## A1. GoalGitSafetyProfileV1 external attribute closure

Extend `GoalGitSafetyProfileV1` with an explicit external-attributes policy:

```ts
type GoalExternalAttributesPolicyV1 = {
  schemaVersion: 1
  repositoryInfoAttributes: 'must_be_absent_or_empty'
  globalAttributes: 'must_be_absent_or_empty'
  systemAttributes: 'must_be_absent_or_empty'
  committedAttributeSource: 'exact_head'
}
```

Before a project is accepted as `GoalRepositoryProfileV1.supported=true`:

1. the root-anchored profile check confirms `.git/info/attributes` is absent or a bounded empty real file;
2. under the trusted Git executable and safe environment, Forge resolves the effective global/system attribute paths using the supported Git `git var` contract or a reviewed equivalent;
3. the dedicated Forge HOME/XDG global attribute file must be absent or empty;
4. the Git-installation system attribute file must be absent or empty;
5. the paths and file contents never enter public evidence;
6. committed attributes are sourced from exact proven HEAD under the pinned attr-source contract;
7. any external attribute content produces `system_git_attributes_unsupported` or `global_git_attributes_unsupported`, not a best-effort proof.

The Git safety-profile digest covers this rule. Do not depend on undocumented environment variables to suppress the system attributes file.

## A2. Keyed fingerprints for sensitive repository metadata

Plain SHA-256 is not permitted for any persisted fingerprint derived from bytes that may contain credentials, repository-relative path names or other sensitive local metadata.

Introduce a reusable protected digest primitive:

```ts
type KeyedRepositoryDigestV1 = {
  schemaVersion: 1
  algorithm: 'hmac-sha256'
  digestKeyId: string
  digest: `hmac-sha256:${string}`
}
```

Requirements:

- distinct domain separation for Git config, index, metadata-set and any future sensitive repository evidence;
- at least 32-byte secret key material from Forge's protected secret-management path;
- reuse/refactor the existing repository-wide HMAC/canonicalization primitives where possible; do not invent a weaker bespoke scheme;
- store key id + digest only; no key/raw content;
- key rotation creates a new evidence/environment cohort and never rewrites history;
- missing protected digest key disables decisive verification-goal execution rather than downgrading to plain SHA;
- config/index/path-derived fingerprints inside `GoalRepositoryProfileV1`, `repository_snapshot_fingerprint`, goal evidence-unit fingerprints and downstream reliability use the keyed form or derive from already-keyed values;
- non-sensitive protocol values and Git object IDs may remain ordinary SHA-based fingerprints.

The protected fingerprint service runs entirely outside repository/model control. Tests seed credential-like config values and path sentinels and prove neither raw values nor plain recomputable digests cross DB/log/API/Redis boundaries.

## A3. Built-in-only Git subcommand contract

Extend `GoalOperationExecutionProfileV1`:

```ts
type GoalOperationExecutionProfileV1 = {
  // existing fields
  gitSubcommandKind: 'builtin'
  repositoryHooksExpected: 'none'
}
```

V1 rules:

- every Git subcommand used by an eligible operation or repository-profile preflight is a Git built-in for every Git version admitted by the exact `GoalGitSafetyProfileV1`;
- supported-version CI/source-contract evidence enumerates or otherwise proves this built-in property;
- no eligible profile may rely on an external `git-*` command, hook, filter process or helper executable;
- child `PATH` and `GIT_EXEC_PATH` are built from reviewed trusted locations, not inherited project/workspace paths;
- top-level Git is always the absolute `TrustedExecutableRegistry` identity;
- local `core.hooksPath` outside the supported profile is rejected/neutralized;
- hostile `.git/hooks/*`, `core.hooksPath` and project-controlled `git-<name>` sentinels must remain unexecuted in CI.

A future operation needing a non-built-in helper or hook requires a new risk/execution profile and explicit architecture/security review.

## A4. Locale and machine-readable output contract

Add to the safe Git environment profile:

```text
LC_ALL=C
LANG=C
```

or the exact reviewed platform-equivalent deterministic locale.

Parsers use machine-readable / null-delimited / fixed-field forms where available. No functional classifier may depend on localized error prose. Locale semantics are part of the Git-safety-profile digest.

## A5. Required functional-negative vertical slice for #187

Issue #187 is **not complete** merely because the runner can execute status/diff/branch reads. At least one goal-eligible deterministic operation must have a safe semantic negative result so the end-to-end release proof demonstrates all three outcomes: pass, functional fail, and inconclusive.

The initial required operation is:

```text
repository.default-branch.verify@1
capability: filesystem.project.read
risk: read_only
scope: trusted_project
inputs: none
approval required: false
independent verifier required: false
```

### Trusted inputs

- current branch is obtained only through the root-anchored trusted Git built-in command profile;
- expected branch is loaded from the authoritative `projects.default_branch` field by Forge, not from goal/request/model text;
- project default-branch value + project revision participate in the operation scope/policy fingerprint;
- project revision/default-branch change during the run is authority drift and yields inconclusive, never functional failure.

### Deterministic result

```ts
type DefaultBranchVerificationV1 =
  | { status: 'matches' }
  | { status: 'mismatch' }
```

The public proof does not need to persist both branch-name strings. Protected command audit may retain the bounded internal Git result according to existing audit policy.

Classifier:

- command/process/lease/deadline/root/Git-profile/evidence failure -> non-functional inconclusive class;
- successful deterministic read and exact current branch equals configured default -> pass;
- successful deterministic read and exact mismatch or detached HEAD -> child outcome-v2 `functional` fail with closed stop reason `configured_default_branch_mismatch`;
- no generic nonzero exit becomes functional.

### Binding/profile requirements

The operation receives a normal versioned OperationDefinition plus its own `GoalOperationExecutionProfileV1` containing:

- exact built-in command template digest;
- Git-safety/executable/launcher contract versions;
- deterministic verifier digest;
- functional classifier digest;
- `gitSubcommandKind='builtin'`;
- `repositoryHooksExpected='none'`.

It must be explicitly present in the goal eligibility allowlist and executable registry binding.

### Release acceptance

The #187 closure E2E fixture includes one repository-backed executable goal referencing this operation and proves:

1. configured default branch -> pass;
2. clean supported repository on another/detached branch -> functional fail;
3. process/profile/authority/evidence fault -> inconclusive;
4. repeated identical evidence unit cannot inflate independent #186 sample count.

Broader tests/build/application-behaviour operations remain outside v1 and require separately reviewed deterministic Operation Catalog entries.

## A6. Repository-profile HMAC key becomes execution environment input

Execution environment evidence adds:

```text
repositoryEvidenceDigestContractVersion
repositoryEvidenceDigestKeyId
```

The secret itself is never evidence. The key id and digest contract participate in the environment fingerprint so rotation requalifies evidence instead of silently combining incomparable HMACs.

## A7. Closed terminal codes added

Extend the closed goal admission/terminal code registry with at least:

```text
system_git_attributes_unsupported
global_git_attributes_unsupported
repository_evidence_digest_unavailable
configured_default_branch_mismatch
external_git_subcommand_unsupported
```

`configured_default_branch_mismatch` is the only new functional-negative code in this addendum. The other codes are non-functional and map to blocked/inconclusive according to their phase.

## A8. Round-11 implementation slice adjustment

Slice C in the primary architecture now explicitly includes:

- protected/keyed repository-evidence fingerprint service;
- external global/system attributes proof;
- built-in-only Git command contract;
- deterministic locale;
- `repository.default-branch.verify@1` + its execution profile/eligibility/classifier;
- pass/fail/inconclusive E2E fixture before manual release capability is enabled.

No implementation agent may omit the functional-negative operation and still claim #187 manual proof-run completion.
