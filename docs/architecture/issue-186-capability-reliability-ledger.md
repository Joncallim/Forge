# Issue #186 Architecture: Capability Reliability Ledger

Status: **Architecture accepted, implementation not started.**

| Field | Value |
|---|---|
| Issue | [#186 — Add capability reliability ledger](https://github.com/Joncallim/Forge/issues/186) |
| Parent Epic | [#184 — Continuous verification and earned autonomy](https://github.com/Joncallim/Forge/issues/184) |
| Roadmap phase | Phase 2 of `docs/continuous-verification-and-earned-autonomy-roadmap.md` |
| Depends on | [#185](https://github.com/Joncallim/Forge/issues/185) (landed — ADR 0010, `execution_outcomes`), [#201](https://github.com/Joncallim/Forge/issues/201) (landed — ADR 0011, `operation_runs`) |
| Consumed by | #188 (independent verification), #189 (autonomy policy), #190 (Sentinel), #191 (reporting) |
| Companion ADR | `docs/adr/0012-capability-reliability-ledger.md` |
| Implementation scope | Large — data model, ingest, deterministic aggregation, tests |
| Intended executor | Backend specialist, with QA and Documentation packages |

---

## 1. Plain-language summary

Forge already writes down **what happened** on every attempt: a canonical
"execution outcome" row that says whether work completed, was refused, was
blocked, or failed, and why (ADR 0010). It also records deterministic operation
runs (ADR 0011).

What Forge cannot answer today is the follow-up question: **"has this particular
kind of work, in this particular project, under this particular model and
policy, actually worked before — and was that checked by someone other than the
worker that did it?"**

This issue builds the record that answers it. We call it the **capability
reliability ledger**.

The important word is *comparable*. A pass rate is only meaningful if the things
being counted are alike. "The backend agent is 92% reliable" is a dangerous
number: it silently mixes a trivial README edit with a database migration, a
local 7-billion-parameter model with a frontier model, and a project with strict
review gates with one that has none. So the ledger never stores one score per
agent. It stores **individual attempts**, each tagged with a **cohort** — the
exact combination of project, capability, scope, runtime/model, and policy the
attempt ran under. Metrics are calculated per cohort, on demand, from those
stored attempts.

Three rules shape everything below:

1. **The ledger stores evidence, not opinions.** Every column is a UUID, a
   closed enum code, an integer count, a hash, or a timestamp. There is no
   free-text column anywhere in it — so a model's prose, a file path, or a
   secret cannot leak into it even by accident.
2. **A worker cannot mark its own homework as verified.** Whether an attempt
   counts as "independently verified" is decided by *who checked it*, recorded
   as a closed `verification_mode`. A worker's self-assessment is recorded as
   `self_reported` and is never counted toward a verified pass rate.
3. **Absence is never success.** A missing attempt, a missing outcome, a
   too-small sample, or evidence that has drifted since it was recorded all
   produce an explicit "cannot tell" state — never an optimistic number.

This issue does **not** grant anyone more permission. It builds the evidence
that #189 will later be allowed to reason about.

---

## 2. Objective

Record an append-only, evidence-backed history of comparable capability attempts,
and calculate transparent reliability metrics from it deterministically, without
letting the execution worker grade itself and without collapsing materially
different work into one number.

## 3. Non-goals

These are explicitly *not* in this slice. An implementer who finds themselves
building one of these has left scope and must stop.

- **Granting, holding, promoting, demoting, or revoking autonomy.** That is #189.
  Nothing in this slice may read the ledger to change what an agent is permitted
  to do.
- **An operator dashboard or HTTP API.** That is #191. This slice ships no route
  under `web/app/api`, no page, and no component.
- **A global agent/model/workforce score.** Structurally prevented: metrics are
  only ever returned per cohort.
- **Producing independent verification.** That is #188. This slice defines how an
  independent verification result would be recorded, and refuses to fabricate one
  in the meantime.
- **Backfilling historical attempts.** Consistent with ADR 0010, history before
  this table exists is unavailable evidence, not success.
- **Scheduled or background recomputation.** No Redis job, no cron, no worker
  loop. Metrics are computed when a caller asks.
- **Replacing `tasks`, `task_attempts`, `work_packages`, `agent_runs`,
  `artifacts`, `execution_outcomes`, `operation_runs`, or approval gates.** Those
  remain authoritative for their own state; the ledger only links to them.

---

## 4. Core invariants

Each invariant below has a proving test named in §12. An implementation that
cannot prove one of these has not met the contract.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | The ledger contains no free-text column. Every `text` column is a closed enum, a 64-hex fingerprint, or the bounded capability-key grammar. | `CHECK` constraints + schema-text test |
| I2 | One attempt row exists per `(execution_outcome_id, capability_key)`. Re-ingesting the same attempt changes nothing. | `UNIQUE` index + `ON CONFLICT DO NOTHING` |
| I3 | Attempt identity and its ingest-time snapshot are immutable. `UPDATE`/`DELETE` on `capability_attempts` is rejected by the database. | append-only trigger |
| I4 | Later evidence (verification, human decision, rollback, drift) is appended as adjudication rows, never written back into the attempt. | separate table + append-only trigger |
| I5 | Attempts whose cohort inputs differ are never counted together, and the difference is attributable to one of four component fingerprints. | `cohort_fingerprint` column + component columns |
| I6 | `verification_mode` decides what counts as verified. `self_reported` and `human_review` never contribute to the independently-verified rate. | pure metrics function |
| I7 | A critical failure is always reported, regardless of sample size, window, or aggregate rate. | metrics function returns `criticalFailureCount` unconditionally |
| I8 | If a linked `execution_outcomes` row changed after ingest, the cohort reports `evidence_drift` and suppresses all rates. | `outcome_digest` comparison at read |
| I9 | Below `minSamples`, the cohort reports `insufficient_evidence` with null rates. Never a rate derived from one or two attempts. | metrics function |
| I10 | Ledger write failure never fails a task, work package, agent run, or operation run. | best-effort ingest wrappers |
| I11 | Metrics are a pure function of `(attempts, adjudications, window, now)`. No clock, no database, no I/O. | unit test with fixed inputs |
| I12 | The ordinary application role holds `SELECT, INSERT` on ledger tables and nothing else — no `UPDATE`, no `DELETE`. | CI closed-ACL inventory gate |

---

## 5. Domain contracts

All types live in `web/lib/reliability/contracts.ts` (importable by both `web/app`
and `web/worker`, no database imports).

### 5.1 Ledger contract version

```ts
export const RELIABILITY_LEDGER_CONTRACT_VERSION = 1 as const
```

Bump this when the *meaning* of any cohort input or metric changes. Because the
version is a cohort input (§5.4), bumping it starts fresh cohorts rather than
silently redefining historical numbers. Never edit historical rows to match a
new version.

### 5.2 Capability key

A capability key names *what kind of work was attempted*. It is namespaced so
model-executed work packages and deterministic operations can never share a
cohort.

```text
workpackage:<role>/<capability>       e.g. workpackage:backend/api-implementation
operation:<operation-id>@<version>    e.g. operation:repository.status.read@1
```

- `<role>` is `work_packages.assigned_role`, lowercased and slug-normalized.
- `<capability>` is a member of `CAPABILITY_TAXONOMY`
  (`web/worker/capability-classification.ts`). Reuse that taxonomy; do not
  invent a second one.
- `<operation-id>@<version>` is the exact catalog identity from ADR 0011. A new
  operation version is a new capability key by construction.

```ts
export const CAPABILITY_KEY_PATTERN =
  /^(?:workpackage:[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}|operation:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+@[1-9][0-9]{0,3})$/
export const CAPABILITY_KEY_MAX_LENGTH = 120
```

The same regex is enforced as a PostgreSQL `CHECK`. The pattern is the contract;
the application must not be the only thing holding the line.

### 5.3 Fan-out, multiplicity, and the unclassified escape hatch

One work package usually requires several capabilities. Autonomy decisions in
#189 are per capability, so an attempt must be attributable to each capability it
exercised.

**Rule:** one attempt row per `(execution_outcome_id, capability_key)`. All rows
produced from one outcome share an `attempt_group_id` and carry
`capability_multiplicity = <number of capability rows in the group>`.

This gives two honest views without double-counting:

- Per-capability view (used by #189): count rows.
- Per-attempt view (used by #191): collapse on `attempt_group_id`, or divide by
  `capability_multiplicity`.

`ReliabilitySummary` reports both `sampleCount` (rows) and `uniqueAttemptCount`
(distinct groups), so a reader can never mistake one failed package covering
five capabilities for five independent failures.

Bounds and failure modes:

```ts
export const MAX_CAPABILITY_FAN_OUT = 12
export type CapabilityClassificationState = 'classified' | 'missing' | 'overflow'
```

- `missing` — the Architect produced no usable capability classification.
- `overflow` — more than `MAX_CAPABILITY_FAN_OUT` capabilities were declared.

In both cases write exactly one row with capability key
`workpackage:<role>/unclassified` and the matching `classification_state`.
`unclassified` is reserved: it is a member of no specific capability cohort and
is excluded from every capability metric, but it **is** counted and reported in
`ReliabilitySummary.excluded` so the measurement gap is visible rather than
silently absent. Never guess a capability to fill the gap.

### 5.4 Cohort fingerprints

```ts
export function reliabilityFingerprint(domain: string, value: unknown): string
```

Implement with the same construction as `operationFingerprint`
(`web/lib/operations/contracts.ts`): domain-separated SHA-256 over
`canonicalJson`. Reuse `canonicalJson` and `isPlainRecord` from that module
rather than writing a second canonicalizer.

Four component fingerprints, then the cohort fingerprint over all of them:

**Scope** — `reliabilityFingerprint('scope', …)` over:

```ts
{
  contractVersion: 1,
  projectId: string,
  rootRef: string | null,                  // opaque project identity, never a path
  rootBindingRevision: string,             // bigint as canonical decimal string
  grantDecisionRevision: string,           // bigint as canonical decimal string
  repositoryWriteIntent: boolean,
  capabilities: string[],                  // sorted, de-duplicated
  mcpRequirementKeys: string[],            // sorted, de-duplicated
}
```

Never include `projects.local_path`, any repository-relative path, any file
name, or any excerpt. ADR 0008/0009 forbid persisting those, and `root_ref` is
the approved opaque substitute. Re-ordering or repeating capabilities must not
change the fingerprint (sorted + de-duplicated).

**Runtime** — `reliabilityFingerprint('runtime', …)` over one of:

```ts
{ kind: 'model', providerType, modelId, providerIsLocal, providerConfigUpdatedAt, acpExecutionMode }
{ kind: 'deterministic_adapter', adapterKind }
```

Model fields come from the snapshot columns that already exist on `agent_runs`
(`provider_type_used`, `model_id_used`, `provider_is_local_used`,
`provider_config_updated_at_used`, `acp_execution_mode`). Do not re-read live
provider config: the snapshot is what actually ran.

**Policy** — `reliabilityFingerprint('policy', …)` over:

```ts
{
  contractVersion: 1,
  policyVersion: RELIABILITY_POLICY_VERSION,   // code constant, bumped on meaning change
  harnessId: string | null,
  harnessUpdatedAt: string | null,             // ISO 8601, or null
  reviewRequirement: 'none' | 'qa_only' | 'reviewer_only' | 'both',
  repositoryWritesEnabled: boolean,
}
```

**Cohort** — `reliabilityFingerprint('cohort', { contractVersion, projectId, capabilityKey, scopeFingerprint, runtimeFingerprint, policyFingerprint })`.

Storing the components alongside the cohort makes drift *attributable*: when a
cohort changes, a reader can say "the model changed" rather than only "something
changed". That attribution is what makes requalification in #189 explainable.

**Requalification is implicit and automatic.** A material change to the model,
harness, policy, project root binding, or capability set produces a different
`cohort_fingerprint`, so the new attempts land in a new cohort with a fresh
sample count. No migration, flag, or manual reset is involved — and old evidence
is never destroyed, only no longer counted toward the new cohort.

### 5.5 Verification mode

```ts
export const VERIFICATION_MODES = [
  'none',                   // verification was not required
  'self_reported',          // the worker asserted its own success — never counted as verified
  'human_review',           // a human decided an approval gate
  'deterministic_adapter',  // machine-checked output (ADR 0011 operations)
  'independent_agent',      // a separate verifier agent run — produced by #188
] as const
```

`independent_agent` is defined now and **rejected at ingest in v1** with a
`reliability_verification_mode_unavailable` error, because no producer exists yet
(#188). Defining it early keeps the storage contract stable; rejecting it keeps
the ledger honest. When #188 lands it removes that guard in one place.

`verification_status` mirrors ADR 0010 exactly:
`'not_required' | 'pending' | 'passed' | 'failed' | 'inconclusive'`.

### 5.6 Severity

```ts
export type SeverityClass = 'normal' | 'critical'
```

An attempt is `critical` when any of these hold at ingest:

- `stop_reason_code` is `security_blocked` or `policy_blocked`;
- the attempt had `repositoryWriteIntent` and its validation commands failed
  (`validation_command_failed > 0`);
- the linked operation run terminated `blocked` on a policy or preflight phase.

A later `rollback_recorded` adjudication also makes the attempt critical for
metric purposes; the stored attempt row is not rewritten (I3/I4), the metrics
function derives it. Critical counts are reported unconditionally (I7).

### 5.7 Summary contract

```ts
export type ReliabilityWindow = {
  maxAttempts: number    // most recent N rows in the cohort
  maxAgeMs: number       // ignore rows older than this
  minSamples: number     // below this, no rates are produced
}

export const DEFAULT_RELIABILITY_WINDOW: ReliabilityWindow = {
  maxAttempts: 50,
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
  minSamples: 5,
}

export type ReliabilityState = 'ready' | 'insufficient_evidence' | 'evidence_drift'

export type ReliabilitySummary = {
  schemaVersion: 1
  cohortFingerprint: string
  capabilityKey: string
  state: ReliabilityState
  sampleCount: number
  uniqueAttemptCount: number
  // Every rate is null unless state === 'ready'.
  rates: {
    firstAttemptSuccess: number | null
    independentlyVerifiedPass: number | null
    humanAccepted: number | null
    unverifiedCompletion: number | null
    repairRetry: number | null
    humanRejection: number | null
    rollback: number | null
    policyBlock: number | null
  }
  consecutiveVerifiedPasses: number
  // Always populated, whatever the state.
  criticalFailureCount: number
  lastCriticalAt: string | null
  evidence: {
    newestObservedAt: string | null
    oldestObservedAt: string | null
    freshnessMs: number | null
    driftedAttemptCount: number
  }
  excluded: Array<{ reason: 'outside_window' | 'unclassified' | 'drifted'; count: number }>
}
```

Rate definitions — each is `numerator / denominator`, and a denominator of zero
yields `null`, never `0` and never `1`:

| Rate | Numerator | Denominator |
|---|---|---|
| `firstAttemptSuccess` | `attempt_number = 1` and `result = 'completed'` | `attempt_number = 1` |
| `independentlyVerifiedPass` | latest verification adjudication has mode ∈ {`deterministic_adapter`, `independent_agent`} and result `passed` | attempts with `verifier_required = true` |
| `humanAccepted` | latest human decision is `accepted` | attempts with at least one human decision |
| `unverifiedCompletion` | `result = 'completed'` with no independent verification | `result = 'completed'` |
| `repairRetry` | `attempt_number > 1` | all in-window rows |
| `humanRejection` | latest human decision is `rejected` | attempts with at least one human decision |
| `rollback` | has a `rollback_recorded` adjudication | all in-window rows |
| `policyBlock` | `result = 'blocked'` | all in-window rows |

`unverifiedCompletion` exists on purpose. Until #188 lands, Forge's honest answer
for most cohorts is "completed, but nobody independent checked it" — and that
number should be visible instead of being quietly folded into a pass rate.

`consecutiveVerifiedPasses` counts backwards from the newest in-window row and
stops at the first row that is not an independently verified pass. It is `0`
under `insufficient_evidence` or `evidence_drift`.

---

## 6. Persistence

Migration `0031_capability_reliability_ledger.sql`. Follow the exact style of
`0030_operation_runs.sql`: inline `CONSTRAINT` clauses, `--> statement-breakpoint`
separators, guard functions with `SET search_path = pg_catalog, public`, and
`REVOKE ALL ON FUNCTION … FROM PUBLIC` immediately after every `CREATE FUNCTION`.

### 6.1 `capability_attempts`

Immutable evidence, one row per `(execution_outcome_id, capability_key)`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `attempt_group_id` | `uuid NOT NULL` | shared by all rows from one outcome |
| `project_id` | `uuid NOT NULL` → `projects` `ON DELETE restrict` | |
| `task_id` | `uuid NOT NULL` → `tasks` `ON DELETE restrict` | |
| `work_package_id` | `uuid` → `work_packages` `ON DELETE set null` | null for pre-package admission blocks |
| `agent_run_id` | `uuid` → `agent_runs` `ON DELETE set null` | |
| `task_attempt_id` | `uuid` → `task_attempts` `ON DELETE set null` | |
| `execution_outcome_id` | `uuid NOT NULL` → `execution_outcomes` `ON DELETE restrict` | the ADR 0010 anchor |
| `operation_run_id` | `uuid` → `operation_runs` `ON DELETE set null` | set for ADR 0011 attempts |
| `contract_version` | `integer NOT NULL DEFAULT 1` | `CHECK = 1` |
| `capability_key` | `text NOT NULL` | `CHECK` regex + `length(…) <= 120` |
| `classification_state` | `text NOT NULL` | `CHECK IN ('classified','missing','overflow')` |
| `capability_multiplicity` | `integer NOT NULL` | `CHECK BETWEEN 1 AND 12` |
| `cohort_fingerprint` | `text NOT NULL` | `CHECK ~ '^[0-9a-f]{64}$'` |
| `scope_fingerprint` | `text NOT NULL` | same |
| `runtime_fingerprint` | `text NOT NULL` | same |
| `policy_fingerprint` | `text NOT NULL` | same |
| `outcome_digest` | `text NOT NULL` | fingerprint of the normalized outcome at ingest |
| `transport_status` | `text NOT NULL` | `CHECK IN ('ok','error')` |
| `result` | `text NOT NULL` | same closed set as `execution_outcomes.result` |
| `stop_reason_code` | `text` | `NULL` or the ADR 0010 closed taxonomy |
| `retryable` | `boolean NOT NULL` | |
| `attempt_number` | `integer NOT NULL DEFAULT 1` | `CHECK >= 1`; from `agent_runs.attempt_number`, coalesced to `1` when null or absent |
| `severity_class` | `text NOT NULL` | `CHECK IN ('normal','critical')` |
| `verifier_required` | `boolean NOT NULL` | mirrored from the outcome |
| `verification_mode` | `text NOT NULL` | `CHECK IN (…)`; `independent_agent` allowed by the column, refused by the application in v1 |
| `verification_status` | `text NOT NULL` | ADR 0010 closed set |
| `acceptance_criteria_total` | `integer NOT NULL DEFAULT 0` | `CHECK >= 0` |
| `validation_command_total` | `integer NOT NULL DEFAULT 0` | `CHECK >= 0` |
| `validation_command_failed` | `integer NOT NULL DEFAULT 0` | `CHECK >= 0 AND <= validation_command_total` |
| `evidence_refs` | `jsonb NOT NULL DEFAULT '[]'` | UUIDs only; `CHECK jsonb_typeof = 'array'` |
| `observed_at` | `timestamptz NOT NULL` | outcome time — the window axis |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | ingest time |

Consistency `CHECK`s that must be in the migration, not only in TypeScript:

```sql
CONSTRAINT "capability_attempts_verifier_consistency_check" CHECK (
  (verifier_required AND verification_status IN ('pending','passed','failed','inconclusive'))
  OR (NOT verifier_required AND verification_status = 'not_required')
),
CONSTRAINT "capability_attempts_verification_mode_check" CHECK (
  (verification_mode = 'none') = (NOT verifier_required)
),
CONSTRAINT "capability_attempts_unclassified_check" CHECK (
  (classification_state = 'classified') OR capability_key LIKE 'workpackage:%/unclassified'
),
CONSTRAINT "capability_attempts_operation_runtime_check" CHECK (
  operation_run_id IS NULL OR verification_mode IN ('none','deterministic_adapter')
)
```

Indexes:

```sql
CREATE UNIQUE INDEX "capability_attempts_outcome_capability_idx"
  ON "capability_attempts" ("execution_outcome_id", "capability_key");
CREATE INDEX "capability_attempts_cohort_observed_at_idx"
  ON "capability_attempts" ("cohort_fingerprint", "observed_at" DESC);
CREATE INDEX "capability_attempts_project_capability_idx"
  ON "capability_attempts" ("project_id", "capability_key");
CREATE INDEX "capability_attempts_attempt_group_idx"
  ON "capability_attempts" ("attempt_group_id");
CREATE INDEX "capability_attempts_execution_outcome_idx"
  ON "capability_attempts" ("execution_outcome_id");
```

The cohort index is the one that matters for read latency: every metrics query is
`WHERE cohort_fingerprint = $1 ORDER BY observed_at DESC LIMIT $2`.

Append-only guard (mirrors `forge_guard_operation_run_history_v1`):

```sql
CREATE FUNCTION "forge_reject_capability_attempt_mutation_v1"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'capability attempts are append-only';
END;
$$;
REVOKE ALL ON FUNCTION public.forge_reject_capability_attempt_mutation_v1() FROM PUBLIC;
CREATE TRIGGER "capability_attempts_append_only"
BEFORE UPDATE OR DELETE ON "capability_attempts"
FOR EACH ROW EXECUTE FUNCTION "forge_reject_capability_attempt_mutation_v1"();
```

### 6.2 `capability_attempt_adjudications`

Append-only evidence that arrives *after* the attempt: verification results,
human decisions, rollbacks, overrides, and detected drift.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `capability_attempt_id` | `uuid NOT NULL` → `capability_attempts` `ON DELETE restrict` | |
| `sequence` | `integer NOT NULL` | `CHECK >= 0`; unique per attempt, gapless |
| `kind` | `text NOT NULL` | `CHECK IN ('verification_recorded','human_decision','rollback_recorded','override_recorded','evidence_drift_detected')` |
| `verification_mode` | `text` | null unless `kind = 'verification_recorded'` |
| `verification_result` | `text` | `CHECK NULL OR IN ('passed','failed','inconclusive')` |
| `human_decision` | `text` | `CHECK NULL OR IN ('accepted','rejected','cancelled')` |
| `decided_by` | `uuid` → `users` `ON DELETE set null` | set only for human decisions |
| `approval_gate_id` | `uuid` → `approval_gates` `ON DELETE set null` | provenance for human decisions |
| `observed_outcome_digest` | `text` | 64-hex; set only for `evidence_drift_detected` |
| `evidence_refs` | `jsonb NOT NULL DEFAULT '[]'` | UUIDs only |
| `observed_at` | `timestamptz NOT NULL` | |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |

Shape `CHECK`s, so a malformed adjudication cannot be stored:

```sql
CONSTRAINT "capability_attempt_adjudications_kind_shape_check" CHECK (
  (kind = 'verification_recorded'
     AND verification_mode IS NOT NULL AND verification_result IS NOT NULL
     AND human_decision IS NULL AND observed_outcome_digest IS NULL)
  OR (kind = 'human_decision'
     AND human_decision IS NOT NULL
     AND verification_mode IS NULL AND verification_result IS NULL
     AND observed_outcome_digest IS NULL)
  OR (kind IN ('rollback_recorded','override_recorded')
     AND verification_mode IS NULL AND verification_result IS NULL
     AND observed_outcome_digest IS NULL)
  OR (kind = 'evidence_drift_detected'
     AND observed_outcome_digest IS NOT NULL
     AND verification_mode IS NULL AND verification_result IS NULL
     AND human_decision IS NULL)
)
```

Ordering guard — a `BEFORE INSERT` trigger requiring
`NEW.sequence = COALESCE(MAX(sequence), -1) + 1` for that attempt, taking
`FOR UPDATE` on the parent attempt row exactly as
`forge_guard_operation_event_insert_v1` does. Plus a second trigger rejecting all
`UPDATE`/`DELETE` (`capability_attempt_adjudications_append_only`).

Indexes: `UNIQUE (capability_attempt_id, sequence)`, and
`(capability_attempt_id, observed_at)`.

### 6.3 No materialized summary in v1

Issue #186 permits an optional materialized summary. **This architecture
deliberately omits it.**

Rationale: a cache that can disagree with its source is a whole class of bug —
staleness, partial rebuild, and "the number on the screen is not the number in
the evidence". The cohort index makes the on-demand computation a bounded index
scan of at most `maxAttempts` rows plus their adjudications. Metrics are a pure
function (I11), so materializing later is purely additive.

Revisit when a real measurement shows a cohort read exceeding ~50 ms at p95, or
when #191 needs cross-cohort listings that would fan out to many cohort queries.
Record that measurement in the ADR before adding the table.

### 6.4 Schema and privileges

Add both tables to `web/db/schema.ts` in the `operationRuns` neighbourhood, with
`InferSelectModel`/`InferInsertModel` type exports matching the file's existing
convention, and every `CHECK` mirrored in the Drizzle definition (the repository
keeps SQL and Drizzle constraint parity; `0030` does this for all of its checks).

The ordinary application role must get `SELECT, INSERT` and nothing else — no
`UPDATE` (attempts are immutable) and no `DELETE`. See §10 for the exact CI
inventory edit.

---

## 7. Ingest

New module `web/worker/reliability/ledger.ts`. It is the only writer.

### 7.1 Posture: best-effort, never blocking

Every ingest call is wrapped exactly like
`upsertExecutionOutcomeBestEffort` in `web/worker/work-package-handoff.ts`: catch,
log through the existing task-log path, continue. A reliability write failing must
never fail a task, package, run, or operation (I10). The ledger is an
interpretation layer; the lifecycle tables are the truth.

### 7.2 Feature flag

```
FORGE_CAPABILITY_RELIABILITY_LEDGER   # default on; set to 0/false/off to disable ingest
```

Use `defaultOnFeatureFlagEnabled` from `web/worker/feature-flags.ts`. Default-on
is correct here because the slice is additive and write-only — nothing reads the
ledger to make a decision in v1. Reads must tolerate a gap in history caused by a
disabled window: a gap is missing evidence, never success.

### 7.3 Call sites

Ingest hangs off the boundaries that already write canonical outcomes. Do not
create new execution boundaries.

**(a) `web/worker/work-package-handoff.ts` — three existing sites.**

| Existing site | Attempt shape |
|---|---|
| admission block (`attemptKey: work-package:<id>:admission`) | `result: 'blocked'`, `verifier_required: false`, `verification_mode: 'none'` |
| completion (`attemptKey: work-package:<id>:run:<runId>`) | `result: 'completed'`, `verifier_required` from `reviewRequirement`, `verification_mode: 'human_review'` when required |
| failure (same attempt key) | mapped from `executionFailureOutcome(...)` |

Note on completion: today `verifier_required = reviewRequirement !== 'none'` and
the only available verifier is a human approval gate, so `verification_mode` is
`human_review` with `verification_status: 'pending'`. It is **not**
`independent_agent`, and it never counts toward `independentlyVerifiedPass`. That
is the honest state of Forge until #188.

`upsertExecutionOutcome` must return the stored row id so ingest can link
`execution_outcome_id`. Change its signature to
`Promise<{ id: string } | null>` (`.returning({ id: executionOutcomes.id })`) and
have the best-effort wrapper return `null` on failure. This is additive; existing
callers ignore the value.

**(b) `web/worker/operations/ledger.ts` — after `finalize()` commits.**

`finalize()` already returns `{ executionOutcomeId }`. Call ingest **after** the
transaction commits, best-effort. Do not put ledger writes inside that
transaction: ADR 0011 pins its exact transactional contract (outcome + outcome
event + terminalization commit together), and widening it would invalidate the
proofs behind that ADR.

Operation attempts use `verification_mode: 'deterministic_adapter'` when the run
verified, `'none'` when the run was blocked before execution, and
`operation_run_id` set.

### 7.4 Ingest algorithm

```
recordCapabilityAttempts(input):
  1. If the feature flag is off -> return.
  2. Resolve capability keys:
       work package -> required capabilities from the Architect classification,
                       normalized and de-duplicated; empty -> 'missing';
                       more than MAX_CAPABILITY_FAN_OUT -> 'overflow'
       operation    -> exactly one key: operation:<id>@<version>
  3. Read the cohort inputs from already-loaded rows where possible
     (project, work package, agent run snapshot, harness). One extra read is
     acceptable; a fan-out of reads per capability is not.
  4. Compute scope/runtime/policy/cohort fingerprints and the outcome digest.
  5. Reject 'independent_agent' verification mode (no producer in v1).
  6. Build one row per capability key with a shared attempt_group_id and
     capability_multiplicity = keys.length.
  7. Insert all rows in one statement with
     ON CONFLICT ("execution_outcome_id","capability_key") DO NOTHING.
  8. Never update, never delete, never retry into a mutation.
```

Step 7 gives idempotency (I2) for free: a recovered worker that re-runs the
boundary writes nothing new. Because `execution_outcomes` is itself an upsert
keyed by `(task_id, attempt_key)`, a recovered attempt reuses the same outcome
row and therefore the same conflict target.

### 7.5 Adjudication producers in v1

| Producer | Where | Writes |
|---|---|---|
| Human review decision | `web/worker/review-gates.ts` → `decideReviewGate` | `human_decision` (`accepted` for `completed`, `rejected` for `needs_rework`) with `decided_by` and `approval_gate_id`; plus `verification_recorded` with mode `human_review` and result `passed`/`failed` |
| Drift detection | the cohort reader (§8) | `evidence_drift_detected` with the currently observed digest |
| Rollback | **no producer in v1** | contract only |
| Override | **no producer in v1** | contract only |

Rollback and override are storage contracts waiting for #189/#190. Do **not**
invent a producer, and do **not** synthesize a rollback from a `needs_rework`
decision — rework is not rollback, and conflating them would corrupt the very
metric #189 depends on.

Resolving the attempt from a gate decision: the gate carries
`work_package_id` and `source_agent_run_id`; the attempt rows are found via
`execution_outcomes` on `(task_id, attempt_key = 'work-package:<id>:run:<runId>')`.
Write one adjudication per attempt row in the group, each with its own
`sequence`. If no attempt row exists (ledger disabled, or the outcome predates
this table), skip silently — a missing attempt is missing evidence, not an error
to escalate.

---

## 8. Read path

New module `web/lib/reliability/metrics.ts` (pure) and
`web/worker/reliability/reader.ts` (database access).

```ts
// pure, no I/O, no clock
export function computeReliability(input: {
  attempts: CapabilityAttemptRecord[]
  adjudications: CapabilityAdjudicationRecord[]
  window: ReliabilityWindow
  now: Date
}): ReliabilitySummary
```

```ts
// database access only; performs no arithmetic
export async function readCohortReliability(input: {
  cohortFingerprint: string
  window?: ReliabilityWindow
  now?: Date
}): Promise<ReliabilitySummary>
```

The reader:

1. Selects at most `window.maxAttempts` rows for the cohort, newest first.
2. Selects their adjudications.
3. Joins the linked `execution_outcomes` rows and recomputes each
   `outcome_digest`. Any mismatch appends an `evidence_drift_detected`
   adjudication (best-effort) and marks the attempt drifted.
4. Calls `computeReliability`.

Drift semantics (I8): if **any** in-window attempt drifted, `state` is
`evidence_drift`, every rate is `null`, and `criticalFailureCount` is still
reported. Forge must not average numbers whose underlying evidence changed
beneath them.

Keeping arithmetic in a pure function is what makes "metrics can be recomputed
deterministically from stored attempts" a testable claim rather than a promise.

---

## 9. Operator surface (bounded)

No dashboard, no HTTP route. One read-only CLI script, matching the existing
`protocol:inspect-*` convention:

```
npm run protocol:inspect-capability-reliability -- --project <uuid> [--capability <key>] [--json]
```

`web/scripts/inspect-capability-reliability.ts` lists the project's cohorts with
their capability key, state, sample counts, critical count, and freshness. It
performs no writes and takes no action. Human-facing output must stay
layman-readable per `AGENTS.md`: say "not enough evidence yet (3 of 5 attempts)"
rather than printing a bare enum.

This is the minimum needed for a human to see the evidence exists. Everything
richer belongs to #191.

---

## 10. CI and migration gates

Adding a migration and public tables trips four pinned gates plus the closed-ACL
inventory. All were last moved by commits `a2cc23c`, `c64d06b`, `6115707`, and
`5f06947`; read those diffs before starting.

Current state: 31 migrations, newest journal entry `0030_operation_runs` with
`when = 1785993600000`. After `0031`, the count is **32** and the max
`created_at` literal becomes the new migration's journal timestamp.

**Files that must be updated in the same commit as the migration:**

1. `web/db/migrations/0031_capability_reliability_ledger.sql` — new.
2. `web/db/migrations/meta/_journal.json` — new `idx: 31` entry (generated by
   `npm run db:generate`; do not hand-edit the timestamp afterwards).
3. `web/scripts/ci/sql/migration-0027-expansion-assertions.sql` — `<> 31` → `<> 32`
   (both count assertions) and the `max(created_at)` literal.
4. `web/__tests__/local-projection-overlimit-archive.test.ts` — the same three
   literals, asserted as substrings of that SQL file.
5. `scripts/ci/prove-installer-managed-migrations.sh` — count and max literal.
6. `web/scripts/ci/prove-installer-legacy-migration-repair.sh` — same.
7. `.github/workflows/web-ci.yml` — the closed application-ACL inventory:
   - add `capability_attempts` and `capability_attempt_adjudications` to the
     `operation_ledger_tables` array (they belong to the same ledger family);
   - add `GRANT SELECT, INSERT ON TABLE public.capability_attempts,
     public.capability_attempt_adjudications TO forge_app_test;`
   - extend the per-privilege expectation expression so both new tables expect
     exactly `SELECT` and `INSERT` — no `UPDATE`, no `DELETE` (I12). Getting this
     wrong fails the gate loudly, which is the intended behaviour.
   - also extend the `REVOKE ALL ON TABLE …` line near line 271 that seeds the
     ledger-family baseline.

`web/scripts/repair-epic-172-legacy-release.ts` was already made tolerant of
ledgers of 29 rows or more (`a2cc23c`) and should need no change. Verify rather
than assume.

**Do not** renumber, edit, or reuse an existing migration. **Do not** relax a
pinned assertion to a range to avoid updating it — those pins are the gate.

---

## 11. Rollout, compatibility, and recovery

- **Additive only.** No existing column, constraint, or contract changes, with one
  exception: `upsertExecutionOutcome` gains a return value (§7.3).
- **No backfill.** Cohorts start empty. A cohort with no rows is
  `insufficient_evidence`, never a pass.
- **Disable path.** Set `FORGE_CAPABILITY_RELIABILITY_LEDGER=0`. Ingest stops;
  existing rows remain readable; no lifecycle behaviour changes.
- **Rollback.** Because nothing reads the ledger to make a decision in v1,
  reverting the application code is safe on its own. Leave the tables in place;
  dropping them would destroy audit evidence. If they must go, that is a
  separate reviewed migration.
- **Partial ingest.** A crash between the outcome write and the attempt write
  leaves an outcome with no attempt. This is expected and safe: the next boundary
  does not retroactively invent one, and the reader treats it as missing
  evidence. Do not add a reconciliation sweep in this slice.
- **Mixed versions.** During a rolling restart, some workers write attempts and
  some do not. Both are correct; the sample count is simply lower.

---

## 12. Required tests

Every invariant in §4 needs a named proving test. Suggested files, following the
repository's existing naming:

**`web/__tests__/capability-reliability-contracts.test.ts`**
- capability-key grammar accepts valid work-package and operation keys, rejects
  paths, spaces, uppercase, over-length, and missing namespace (I1);
- cohort fingerprint is stable under capability re-ordering and duplication (I5);
- cohort fingerprint changes when model, harness, policy version, root binding
  revision, or contract version changes — one test per input, asserting *which*
  component fingerprint moved (I5);
- scope fingerprint inputs contain no path-like value: seed a unique path
  sentinel into project `local_path` and assert it appears in no fingerprint
  input and no stored column (I1).

**`web/__tests__/capability-reliability-metrics.test.ts`**
- identical inputs produce byte-identical summaries across repeated calls, and
  the function reads no clock (I11);
- below `minSamples` → `insufficient_evidence`, all rates null (I9);
- a cohort of 20 successes plus one `security_blocked` attempt still reports
  `criticalFailureCount: 1` and a non-null `lastCriticalAt` (I7);
- `self_reported` and `human_review` verification never raise
  `independentlyVerifiedPass`; a cohort of 10 human-approved completions reports
  `independentlyVerifiedPass: null` (denominator behaviour) and
  `unverifiedCompletion: 1` (I6);
- `consecutiveVerifiedPasses` resets at the first non-verified row;
- zero denominators return `null`, never `0` or `1`;
- one drifted attempt suppresses all rates and sets `state: 'evidence_drift'`
  while critical counts survive (I8);
- multiplicity: one failed package covering 5 capabilities yields
  `sampleCount: 5`, `uniqueAttemptCount: 1`.

**`web/__tests__/capability-reliability-ledger.test.ts`** (mocked database)
- re-running the same boundary twice writes rows once (I2);
- `independent_agent` mode is rejected at ingest (§5.5);
- a ledger write failure does not propagate to the caller (I10);
- flag off → no writes;
- missing classification writes exactly one `unclassified` row with
  `classification_state: 'missing'`; 13 capabilities writes one `overflow` row.

**`web/__tests__/capability-reliability-schema.test.ts`** (text assertions on the
migration, mirroring `operation-ledger-schema.test.ts`)
- asserts the append-only triggers, the ordering guard, the `CHECK` names, and
  the `REVOKE ALL ON FUNCTION` lines exist;
- asserts every `text` column in the new tables appears in a `CHECK` — the
  machine-checkable form of "no free-text column" (I1).

**`web/__tests__/capability-reliability-ledger.postgres.test.ts`** (gated proof,
modelled exactly on `operation-ledger.postgres.test.ts`)
- gate: `FORGE_RELIABILITY_LEDGER_REQUIRE_POSTGRES_TEST=1` plus `DATABASE_URL`
  and `FORGE_RELIABILITY_LEDGER_POSTGRES_ADMIN_TEST_URL`; the mandatory suite may
  not skip, and missing variables must throw rather than silently pass;
- `UPDATE` and `DELETE` on `capability_attempts` are rejected by the trigger (I3);
- adjudication sequence gaps and out-of-order inserts are rejected;
- adjudication `UPDATE`/`DELETE` are rejected (I4);
- the duplicate-ingest unique index holds under concurrent inserts (I2);
- each shape `CHECK` rejects its malformed row.

**Existing suites to extend**
- `web/__tests__/work-package-handoff-db.test.ts` — assert attempt ingest at all
  three outcome boundaries, with the expected verification mode per boundary;
- `web/__tests__/local-projection-overlimit-archive.test.ts` — the pinned
  migration literals (§10).

Also run: `npm run lint`, `npm run test:unit:zero-skip`, and `npx tsc --noEmit`.

---

## 13. Work packages

Sequential unless noted. Each package must land with its own tests passing.

| WP | Role | Deliverable | Files |
|---|---|---|---|
| WP-1 | Backend | Contracts, grammar, fingerprints, summary types. No database, no I/O. | `web/lib/reliability/contracts.ts` + contracts test |
| WP-2 | Backend | Migration 0031, Drizzle definitions, triggers, and all CI gate updates from §10. | `web/db/migrations/0031_*.sql`, `web/db/schema.ts`, the six gate files, schema test |
| WP-3 | Backend | Ingest module, feature flag, `upsertExecutionOutcome` return value, wiring at the three handoff boundaries. | `web/worker/reliability/ledger.ts`, `web/worker/execution-outcomes.ts`, `web/worker/work-package-handoff.ts` |
| WP-4 | Backend | Operation-run ingest after `finalize()`. Depends on WP-3. | `web/worker/operations/ledger.ts` |
| WP-5 | Backend | Adjudications: human review decisions from `decideReviewGate`. | `web/worker/reliability/ledger.ts`, `web/worker/review-gates.ts` |
| WP-6 | Backend | Pure metrics function and cohort reader with drift detection. Can run in parallel with WP-3/4/5 once WP-1 lands. | `web/lib/reliability/metrics.ts`, `web/worker/reliability/reader.ts` |
| WP-7 | Backend/DevOps | Read-only inspection script and its `package.json` entry. | `web/scripts/inspect-capability-reliability.ts` |
| WP-8 | QA | The full §12 matrix, including the gated PostgreSQL proof. | `web/__tests__/capability-reliability-*.test.ts` |
| WP-9 | Documentation | ADR 0012 finalized with any decisions changed during implementation; roadmap Phase 2 marked delivered. | `docs/adr/0012-*.md`, `docs/continuous-verification-and-earned-autonomy-roadmap.md` |

Review requirement: **both** (QA and Reviewer). This slice touches durable
evidence, database privileges, and an append-only audit boundary, so
Security/Adversarial review applies per `AGENTS.md` — specifically the ACL
change in §10 and the no-free-text invariant.

---

## 14. Acceptance criteria mapping

| Issue #186 acceptance criterion | Satisfied by | Proving test |
|---|---|---|
| Two attempts with materially different capability scopes are not silently combined | §5.4 cohort fingerprint | cohort separation tests |
| Runtime/model or policy-version changes are visible and can trigger requalification | §5.4 runtime/policy fingerprints stored as columns | per-input fingerprint-change tests |
| Every ledger entry links to a canonical outcome and verification/evidence state | §6.1 `execution_outcome_id NOT NULL` + verification columns | schema + postgres proof |
| Reprocessing an attempt is idempotent | §7.4 unique index + `DO NOTHING` | ledger + postgres tests |
| Metrics can be recomputed deterministically from stored attempts | §8 pure function; no materialized cache | determinism test |
| A critical failure remains visible regardless of the aggregate pass percentage | §5.6, I7 | critical-visibility test |
| Human rejection, rollback, and override events affect the reliability view | §6.2 adjudications + §5.7 rates | metrics tests (rollback/override contract-only in v1) |
| Missing independent verification is not counted as a verified pass | §5.5, I6 | verification-mode tests |
| Tests cover cohorting, rolling windows, critical failures, idempotency, and historical data | §12 | the full matrix |

Two criteria are only **partially** satisfiable in this slice, and the PR must
say so plainly rather than claim otherwise:

- *"rollback … events affect the reliability view"* — the storage contract, the
  metric, and the tests exist, but no producer emits `rollback_recorded` until
  #189/#190. The metric is exercised by fixture data only.
- *"historical data"* — covered as "attempts recorded before this table exists
  are readable as missing evidence", not as backfilled rows.

---

## 15. Implementation stop conditions

Stop and escalate to the Architect rather than improvising if any of these occur:

1. A cohort input needed for a fingerprint is unavailable at an ingest boundary
   (for example, an agent run with no provider snapshot). Do not substitute a
   default, a placeholder, or a live re-read — the fingerprint would become a
   lie. Skip the ingest and report the gap.
2. Making a metric work appears to require mutating a stored attempt.
3. A capability appears that is not in `CAPABILITY_TAXONOMY`. Do not extend the
   taxonomy in this slice; use `unclassified`.
4. An ingest boundary would need to move inside an existing transaction, or the
   ADR 0011 finalize transaction would need to widen.
5. The closed-ACL gate seems to require `UPDATE` or `DELETE` for the application
   role on a ledger table.
6. A path, file name, prompt, model transcript, error string, or any other
   free text appears to be needed in a ledger column.
7. Storing an `independent_agent` verification looks necessary before #188 has
   landed.
8. The pinned migration gates in §10 cannot be satisfied without weakening an
   assertion.

---

## 16. Considered and deferred

**Exportable per-attempt "receipt envelopes."** A community comment on #186
([#186 comment](https://github.com/Joncallim/Forge/issues/186#issuecomment-4965458169),
from a non-maintainer) proposed making each attempt an exportable receipt —
agent identity, capability, scope, runtime, verifier identity, evidence hashes,
override state, decay semantics — so external registries or marketplaces could
consume Forge's evidence.

Deferred, deliberately. The attempt row defined in §6.1 already carries almost
that exact field set, so an export projection remains cheap to add later. What is
*not* free is the surface it implies: a stable public schema, agent identity that
survives outside Forge, signing, and revocation across a trust boundary — none of
which #186 needs and all of which would widen the security review. A decision to
publish reliability evidence outside Forge is a product decision for Jonathan,
not an implementation detail of the ledger. Recorded here so the option stays
open and the reasoning is not lost.

**Materialized reliability summaries.** See §6.3 — omitted until a measurement
justifies the staleness risk.

**A `capability_cohorts` dimension table.** Rejected for v1: the fingerprint
columns are self-describing, and a normalized dimension table would need its own
immutability rules for no read benefit at this scale.
