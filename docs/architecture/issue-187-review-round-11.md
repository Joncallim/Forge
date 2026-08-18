# Issue #187 Architecture Review — Round 11

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Four material gaps plus two hardening findings found. Amendment required before a no-blocker pass.**

## R11-F1 — system/global gitattributes remain ambient proof inputs

Severity: Blocker

Angle: Git attribute determinism

The consolidated design uses `GIT_ATTR_SOURCE=HEAD` and an empty Forge-owned HOME/XDG context. That does not by itself remove Git's global and system-wide attribute files: Git's attribute precedence still includes `$GIT_DIR/info/attributes`, global attributes and the installation-prefix system `gitattributes` file.

These attributes can change worktree/index interpretation and can select filter/diff semantics. The proof environment must not silently depend on host-wide attribute files.

Required v1 amendment:

- under the trusted Git executable/safe environment, resolve `git var GIT_ATTR_GLOBAL` and `git var GIT_ATTR_SYSTEM` (or an equivalent reviewed compile-time path resolver) before entering a project;
- global attributes must be absent/empty under the dedicated Forge HOME/XDG context;
- system attributes must be absent/empty for v1 decisive proof; otherwise goal execution is unavailable with `system_git_attributes_unsupported`;
- `$GIT_DIR/info/attributes` remains absent/empty as already required;
- committed repository `.gitattributes` are read from exact HEAD through the pinned attr-source contract;
- no raw external attribute paths/content enter public evidence;
- supported Git safety profile records the external-attribute policy and tests it.

Do not rely on undocumented environment variables to disable system attributes.

## R11-F2 — plain hashes of local Git config/index can leak low-entropy sensitive metadata

Severity: Blocker

Angle: Privacy / evidence fingerprints

Local `.git/config` can contain credential-bearing URLs or other secrets. The index and metadata structures contain repository-relative file names. Persisting a plain SHA-256 digest of the raw bytes may permit offline dictionary/guessing attacks and conflicts with the architecture's claim that sensitive local metadata does not leak through proof evidence.

Required amendment:

- introduce a distinct domain-separated **keyed repository-evidence fingerprint** contract, e.g. `hmac-sha256`, for any digest derived from raw config, index bytes, path/name sets or other potentially sensitive repository metadata;
- use a dedicated Forge secret key/key-id (or a generic protected digest-key mechanism) with a distinct domain; do not reuse an unrelated HMAC domain;
- persist only `digestKeyId` plus HMAC digest, never the key or raw data;
- key rotation creates a new proof/environment/evidence cohort and does not rewrite history;
- if the keyed-digest secret is unavailable, decisive goal execution is unavailable rather than falling back to plain SHA;
- safe non-sensitive values such as contract versions and Git object OIDs may continue to use ordinary canonical SHA fingerprints;
- tests prove raw credential-like config text and path sentinels do not appear in DB/log/API/Redis/evidence and that a DB-only observer cannot recompute the keyed digest without the key.

The repository already uses domain-separated HMAC evidence elsewhere; this should reuse/refactor the generic cryptographic primitive rather than introduce bespoke crypto.

## R11-F3 — #187 still needs one real functional-negative proof operation before closure

Severity: Blocker

Angle: Product contract / acceptance criteria

The current eligible status/diff/branch read operations can show successful deterministic reads, but under the new conservative failure classifier any process/evidence error becomes inconclusive. They therefore do not provide a meaningful functional `failed` path.

Issue #187 requires structured pass/fail/inconclusive proof evidence. The runner architecture is incomplete if it cannot produce a trustworthy functional failure at all.

Required v1 vertical slice:

Add and separately review one zero-input deterministic Operation Catalog proof whose negative result is semantic, not a process error. Recommended bounded operation:

```text
repository.default-branch.verify@1
capability: filesystem.project.read
risk: read_only
scope: trusted_project
inputs: none
```

Trusted inputs:

- current branch comes from the root-anchored fixed Git built-in read;
- expected branch comes from Forge's authoritative `projects.default_branch` snapshot/current project authority, never from goal/model/request text;
- operation scope/policy fingerprint binds the configured default branch and project revision.

Classifier:

- Git/process/lease/evidence/profile failure -> inconclusive (`infrastructure|authority|evidence`), never functional;
- successful deterministic branch read + exact current branch equals configured default -> pass;
- successful deterministic branch read + exact mismatch/detached branch -> `functional` fail with a closed reason code such as `configured_default_branch_mismatch`;
- no raw branch name needs to enter public reliability/goal evidence; command audit may retain protected internal output under existing policy.

This operation must have its own `GoalOperationExecutionProfileV1`, verifier digest and functional-failure-classifier digest, and must be represented by a sample executable goal fixture. #187 must not be marked complete until at least one goal proves pass, functional fail and inconclusive paths end-to-end.

Broader repository test/build proof remains out of v1 scope and requires new reviewed operations.

## R11-F4 — absolute `git` does not stop Git from dispatching external `git-*` subcommands

Severity: Blocker

Angle: Executable dispatch / forward safety

The trusted executable registry pins the top-level Git binary, but Git can resolve non-core `git-<command>` programs from its exec path/PATH. A future execution profile must not become arbitrary code execution merely because an operation names an external subcommand.

Required amendment:

- `GoalOperationExecutionProfileV1` explicitly declares a closed `gitSubcommandKind='builtin'` for v1;
- every eligible operation's command template uses a subcommand proven to be a Git built-in for every supported Git version in `GoalGitSafetyProfileV1`;
- startup/profile tests enumerate Git's built-in command set (or use an equivalent pinned source contract) and fail if an eligible profile references a non-built-in;
- `GIT_EXEC_PATH` and child `PATH` are constructed from reviewed trusted locations, never inherited from a project/workspace path;
- no eligible v1 profile may depend on external `git-*` helpers;
- mutation test replacing/adding a project-controlled `git-<subcommand>` proves it is never executed.

Current `status`, `diff`, `branch`, `rev-parse`, index/profile plumbing and the new default-branch verifier must all satisfy this built-in-only contract.

## R11-F5 — locale/output normalization should be a pinned execution input

Severity: High

Angle: Determinism

Even when raw prose is not used for failure classification, command output and error formatting may vary by locale and can affect protected audit/output fingerprints.

Required amendment:

- safe child environment fixes `LC_ALL=C` (and compatible `LANG=C`/platform equivalent) as part of the Git safety profile;
- parser contracts consume machine-readable/null-delimited forms wherever available rather than localized prose;
- functional classifiers never depend on localized error strings;
- locale contract participates in the Git safety profile digest.

## R11-F6 — hooks should be proven non-invoked for the exact v1 built-in command set

Severity: High

Angle: Repository-controlled code execution

Git documents many hook surfaces. The initial chosen built-in reads/verifier are not intended to invoke repository hooks, but the architecture should make this a tested property of the exact supported command profiles rather than an assumption.

Required amendment:

- execution profiles state `repositoryHooksExpected='none'` for v1;
- adversarial fixtures populate every plausible `.git/hooks/*` sentinel and configure `core.hooksPath` to a hostile location;
- local-config policy rejects/neutralizes external hooksPath as required by the supported profile;
- CI proves no hook sentinel runs for every goal-eligible v1 command on every supported Git version family;
- any future operation that legitimately invokes hooks is a new risk/execution profile and is not automatically goal-eligible.

## Round 11 conclusion

The architecture is close but not yet at a no-blocker verdict. Before closure it must eliminate external attribute ambiguity, protect sensitive repository fingerprints with keyed digests, guarantee built-in-only Git dispatch, and include one real semantic functional-failure proof operation so #187 genuinely demonstrates pass/fail/inconclusive evidence.