# Issue #187 Architecture Review — Round 9

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Additional Git-state determinism blockers found. Amendment required.**

## R9-F1 — partial/promisor repositories can turn a read proof into network I/O

Severity: Blocker

Angle: Network / repository determinism

Git partial clones may lazily fetch missing objects from a promisor remote. A verification run must not unexpectedly perform network I/O or depend on remote availability merely because a local object is missing.

Required v1 amendment:

- safe Git environment always sets `GIT_NO_LAZY_FETCH=1` / equivalent `--no-lazy-fetch` contract;
- repository metadata preflight rejects partial/promisor configuration (`extensions.partialClone`, `remote.*.promisor`, or equivalent supported indicators) for decisive v1 proof rather than silently continuing with missing objects;
- any missing object under no-lazy-fetch is inconclusive `incomplete_object_store`;
- no fetch/credential/network fallback is attempted;
- partial-clone/promisor state participates in the repository-profile contract and tests.

## R9-F2 — assume-unchanged and skip-worktree can make ordinary clean checks unsound

Severity: Blocker

Angle: Worktree integrity

Git documents that `assume-unchanged` can omit checking changed worktree files, while `skip-worktree` intentionally treats absent files specially. `git status --porcelain` alone is therefore insufficient as the decisive cleanliness proof.

Required v1 amendment:

- preflight scans the index through fixed Git plumbing and fails closed if any tracked path has `assume-unchanged` or `skip-worktree` set;
- raw path names are reduced in memory to counts/booleans and never persisted/logged;
- `core.ignorestat` is forced false in the safe execution profile;
- sparse-checkout state/config is unsupported v1 and returns `sparse_checkout_unsupported`;
- hidden index flags are rechecked around decisive execution together with the index fingerprint.

## R9-F3 — split index adds mutable metadata outside the single index fingerprint

Severity: High

Angle: Metadata integrity

Split index uses `.git/index` plus `sharedindex.*`; the current snapshot text assumes one index fingerprint. Supporting split index without an explicit multi-file lease/fingerprint would make the metadata evidence incomplete.

Required v1 amendment:

- reject split-index repositories (`split_index_unsupported`) before decisive execution;
- do not auto-disable or rewrite the user's index;
- later support requires an explicit shared-index containment/fingerprint contract.

## R9-F4 — replace refs can change object semantics without changing HEAD OID

Severity: Blocker

Angle: Object identity

Git replacement refs are used by default by many commands and can substitute one object for another while the named object id remains unchanged.

Required amendment:

- every goal Git invocation sets `GIT_NO_REPLACE_OBJECTS=1` / `--no-replace-objects` as part of the pinned execution profile;
- `.git/info/grafts` is unsupported if present/non-empty (`grafts_unsupported`);
- replace/graft suppression is covered by mutation fixtures proving an unchanged HEAD cannot alter proof semantics.

## R9-F5 — attributes and local filter configuration can invoke external processes

Severity: Blocker

Angle: Repository-controlled code execution

Git attributes may select clean/smudge/process filters; filter commands are defined in config and can execute external processes. `$GIT_DIR/info/attributes`, global attributes, and local `filter.*` configuration are ambient inputs not yet fully closed by the current document.

Required amendment:

- safe Git environment uses a dedicated empty HOME/XDG context and disables system/global Git config exactly as a versioned profile;
- set `GIT_ATTR_SOURCE=HEAD` (or the reviewed equivalent) so committed attributes, not mutable worktree attributes, govern Git's attribute reads during proof;
- `.git/info/attributes` must be absent/empty in v1;
- local config structural validation rejects every `filter.*` command/process definition and other execution-bearing keys not explicitly allowed;
- `core.attributesFile` and `core.excludesFile` external paths are rejected;
- no filter/diff/helper process may start in adversarial fixtures;
- the execution profile pins this deny/allow contract and its digest.

## R9-F6 — global/user Git state must not leak into proof semantics

Severity: High

Angle: Environment comparability

A user's HOME/XDG config, attributes, credential helpers, aliases, pager, SSH, and other environment can change Git behavior even when the repository and Forge code are unchanged.

Required amendment:

The root shim constructs an allowlist environment from scratch. It does not inherit general process environment. The profile explicitly fixes or removes at least:

- HOME / XDG Git config roots (dedicated empty context);
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`;
- `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_INDEX_FILE` unset;
- `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`;
- prompt/askpass/pager/credential/network helper surfaces disabled;
- Node injection variables stripped before the Node root shim is started.

The exact safe-environment contract/version is part of `GoalOperationExecutionProfileV1` and the run environment fingerprint.

## R9-F7 — executable goal definitions must be tracked at the proven HEAD

Severity: Blocker

Angle: Source-of-truth / clean proof

An ignored or otherwise untracked `.forge/verification-goals/*.json` can be imported while ordinary Git clean status does not necessarily represent it as committed project state. A decisive proof tied to HEAD must not claim that such a goal belongs to that commit.

Required amendment:

- every executable v2 registry source file in the authoritative manifest must be tracked by Git at the exact proven HEAD;
- the root shim/plumbing verifies exact tracked membership without persisting file names;
- untracked/ignored executable goal definition -> inconclusive/admission code `goal_definition_untracked`;
- v1 definition-only imports may remain untracked because they authorize no execution.

## R9-F8 — repository metadata profile needs one explicit supported-v1 shape

Severity: High

Angle: Complexity / implementation safety

The v1 support boundary is now narrower and should be expressed positively, not as an ever-growing ad hoc denylist.

Supported decisive v1 repository profile:

- ordinary non-bare standalone worktree;
- direct real `.git` directory under the trusted root;
- no commondir / linked worktree / submodule gitdir indirection;
- no object alternates, partial/promisor clone, grafts;
- no split/sparse index, assume-unchanged, skip-worktree;
- no external local config includes or execution-bearing filter/helper config;
- empty/absent `.git/info/attributes`;
- all executable goal files tracked at exact HEAD;
- SHA-1 or SHA-256 object format as already designed.

Anything outside that closed profile is inconclusive with a stable unsupported reason code. Forge never rewrites the user's repository to make it fit.

## Round 9 conclusion

Material blockers remain until the primary design incorporates the closed supported Git profile, no-lazy-fetch/no-replace behavior, index-flag validation, ambient environment isolation, and tracked executable-goal requirement. After amendment, run a fresh full review again.