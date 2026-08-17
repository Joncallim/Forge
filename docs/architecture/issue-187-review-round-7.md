# Issue #187 Architecture Review — Round 7

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **One execution-substrate blocker plus aggregate-history findings found. Amendment required.**

## R7-F1 — `(path, dev, ino)` is not a sufficient execution root boundary

Severity: Blocker

Angle: Filesystem TOCTOU / execution containment

The current `assertProjectLocalPathForExecutionBinding` opens the project directory safely, captures `(path, dev, ino)`, then closes the handle. PR #328/ADR 0013 deliberately accepted that for non-executable registry-definition reads, but recorded that a later execution boundary must not treat the identity token as a continuously held execution handle.

The consolidated architecture still ultimately allows Git to receive a pathname `cwd`. Re-attesting `(dev, ino)` before `execFile` leaves a check-to-process-start race: the pathname can be rebound after the check and before the child changes directory.

Required amendment:

Introduce a reusable **TrustedProjectRootLease** and **TrustedRootCommandLauncher** for all post-claim goal Git commands.

### Root lease

```ts
type TrustedProjectRootLease = {
  readonly path: string
  readonly dev: bigint
  readonly ino: bigint
  readonly handle: opaque-live-directory-handle
  close(): Promise<void>
}
```

- acquire with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` after current workspace/project overlap checks;
- keep the directory handle open for the entire goal worker lease;
- open handle prevents inode reuse after unlink while the lease is live;
- never serialize/expose the handle;
- close in `finally` on success/fence/recovery handoff.

### Root-anchored launcher

Do not use raw Node `cwd: projectPath` for goal-eligible subprocesses.

Provide a small code-owned launcher boundary whose OS implementation:

1. opens the supplied project pathname `O_DIRECTORY|O_NOFOLLOW`;
2. `fstat`s it and requires exact `(dev,ino)` equal the still-live root lease;
3. changes directory using the opened directory descriptor (`fchdir` or platform-equivalent handle-based primitive), so later pathname replacement cannot redirect the child;
4. executes only the already validated fixed executable/argv/env; no shell;
5. reports fixed structured exit/timeout state.

The launcher implementation language is not part of model/repository input. It is a versioned Forge runtime component. On a platform where the handle-anchored primitive cannot be provided/proven, verification-goal execution is unavailable/fails closed.

A path rebind before launcher open fails identity. A rebind after launcher open does not affect the descriptor-anchored cwd. Retaining the parent root handle prevents same-inode reuse while the run is active.

### Scope

All post-claim goal Git commands use this launcher:

- repository object format/HEAD;
- strict clean status;
- submodule/gitlink preflight;
- eligible Operation Catalog Git adapters.

The pre-admission live registry attestation remains non-executable and may continue using the reviewed registry importer identity/re-attestation boundary. After run claim, registry/runtime filesystem work must also revalidate against the live root lease.

## R7-F2 — trusted root launcher version/digest must be part of environment evidence

Severity: High

Angle: Comparability / supply chain

Required amendment:

Execution environment v1 includes:

```text
rootLauncherContractVersion
rootLauncherBuildDigest / trusted binary identity
```

The release/installer proof pins/validates the launcher artifact. `unavailable_local` or missing/unverified launcher means goal execution is unavailable, not silently downgraded to path-based cwd.

## R7-F3 — current root-binding helper must be refactored rather than duplicated

Severity: High

Angle: Modularity

Evolve `assertProjectLocalPathForExecutionBinding` into/alongside an acquisition API that can retain the FileHandle rather than adding a second independent set of workspace/path overlap and dev/inode checks.

One trusted root-binding implementation should serve:

- current task context where compatibility permits;
- verification-goal root lease;
- future confined execution work.

Existing task behavior need not switch in the same #187 slice if that changes its contract, but the underlying canonicalization/binding primitives must not fork.

## R7-F4 — project running-capacity claim race needs explicit serialization

Severity: High

Angle: Concurrency

Two workers can claim different queued runs concurrently unless the running-capacity check is serialized.

Required amendment:

Goal run claim follows canonical project-first lock order and locks the current verification policy head/revision (or a dedicated project run-capacity row) before counting live running leases and transitioning its target row queued->running. Thus two claims cannot both observe one remaining slot.

`max_concurrent_runs` counts `status='running' AND lease_expires_at > DB transaction time`. Expired running rows are active/unresolved but not current compute slots; recovery converts them to recovery_required.

## R7-F5 — evidence instability must affect goal aggregate history, not only reliability

Severity: Blocker

Angle: History / #190/#189 trust

The same evidence unit (same project/goal binding/operation set/strict commit/policy/environment) can be observed multiple times. If one run decisively passes and another decisively fails, treating the latest pass as a normal green resolution would hide nondeterminism or an incomplete environment fingerprint.

Required amendment:

Goal-history reader derives an evidence-unit fingerprint at the **goal-run** level analogous to child reliability evidence. For the current cohort:

- if one goal evidence unit has both decisive pass and decisive fail observations, expose `currentEvidenceState='unstable'`;
- unstable evidence cannot close a failure episode for trust/Sentinel/autonomy purposes merely because the latest run passed;
- `lastGreen` may still report the most recent pass as historical observation, but current status carries the instability guard;
- #190/#189/#191 consume validated aggregate evidence state, not only latest run result;
- raw consecutive run counts may still be reported, but promotion/regression trust is suppressed while unstable.

This complements, not replaces, child reliability-v2 evidence-unit instability.

## R7-F6 — goal evidence-unit fingerprint must be specified

Severity: High

Angle: History comparability

Required amendment:

```text
goal_evidence_unit_fingerprint = H(
  project id,
  goal snapshot/definition digest,
  registry execution binding digest,
  strict repository object format/OID,
  resolved policy fingerprint,
  execution environment fingerprint
)
```

This is stored/derived for completed decisive runs and used to detect R7-F5 conflicts. It is not the same as `goal_evidence_set_digest`: evidence-set digest identifies one concrete run's linked rows; evidence-unit fingerprint identifies materially equivalent proof conditions across runs.

## R7-F7 — protected child begin must not rely on filesystem facts inside PostgreSQL

Severity: Medium

Angle: Boundary clarity

The protected DB routine can enforce lease, ordinal, prior child state and stored binding. It cannot independently prove live registry/repository filesystem state.

Required amendment:

Separate the checks explicitly:

1. application trusted runner performs live root/registry/repository attestation using root lease;
2. immediately calls protected child-begin with run lease + ordinal;
3. DB routine enforces all DB-state/ordinal invariants;
4. root-anchored launcher independently reopens/checks exact root identity before process start;
5. post-command runner re-attests live registry/repository before trusting result.

This makes the unavoidable filesystem/DB split explicit and closes the pathname race at the actual command-start boundary.

## R7-F8 — strict repository identity preflight should itself use root-anchored command launcher

Severity: Blocker

Angle: Consistency

After a run is claimed, object-format, HEAD, strict status and gitlink commands are execution-relevant evidence and must use the same trusted root launcher, not raw `execFile(cwd:path)`.

## Round 7 conclusion

Round 7 found a substantive root-execution TOCTOU blocker and an aggregate evidence-instability gap. Both must be incorporated before another no-blocker pass.
