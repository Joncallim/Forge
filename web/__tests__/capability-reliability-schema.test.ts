import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('capability reliability ledger migration', () => {
  it('persists immutable attempts, append-only adjudications, and the closed enum/fingerprint contract', async () => {
    const sql = await fs.readFile(
      path.join(process.cwd(), 'db/migrations/0031_capability_reliability_ledger.sql'),
      'utf8',
    )

    // Structural identity.
    expect(sql).toContain('"execution_outcome_id" uuid NOT NULL')
    expect(sql).toContain('"attempt_group_id" uuid NOT NULL')
    expect(sql).toContain('capability_attempts_outcome_capability_idx')

    // Append-only guards.
    expect(sql).toContain('forge_reject_capability_attempt_mutation_v1')
    expect(sql).toContain('capability_attempts_append_only')
    expect(sql).toContain('forge_reject_capability_adjudication_mutation_v1')
    expect(sql).toContain('capability_attempt_adjudications_append_only')
    expect(sql).toContain('forge_guard_capability_adjudication_insert_v1')
    expect(sql).toContain('capability_attempt_adjudications_order_guard')
    expect(sql).toContain('gapless sequence order')

    // Every REVOKE ALL follows its guard function, matching the 0030 convention.
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.forge_reject_capability_attempt_mutation_v1() FROM PUBLIC')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.forge_guard_capability_adjudication_insert_v1() FROM PUBLIC')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.forge_reject_capability_adjudication_mutation_v1() FROM PUBLIC')

    // No free-text column: every text column in both tables is closed by a
    // CHECK. This asserts each of them exists (I1).
    expect(sql).toContain('capability_attempts_capability_key_check')
    expect(sql).toContain('capability_attempts_classification_state_check')
    expect(sql).toContain('capability_attempts_cohort_fingerprint_check')
    expect(sql).toContain('capability_attempts_scope_fingerprint_check')
    expect(sql).toContain('capability_attempts_runtime_fingerprint_check')
    expect(sql).toContain('capability_attempts_policy_fingerprint_check')
    expect(sql).toContain('capability_attempts_outcome_digest_check')
    expect(sql).toContain('capability_attempts_transport_status_check')
    expect(sql).toContain('capability_attempts_result_check')
    expect(sql).toContain('capability_attempts_stop_reason_code_check')
    expect(sql).toContain('capability_attempts_severity_class_check')
    expect(sql).toContain('capability_attempts_verification_mode_value_check')
    expect(sql).toContain('capability_attempts_verification_status_check')
    expect(sql).toContain('capability_attempt_adjudications_kind_check')
    expect(sql).toContain('capability_attempt_adjudications_verification_mode_check')
    expect(sql).toContain('capability_attempt_adjudications_verification_result_check')
    expect(sql).toContain('capability_attempt_adjudications_human_decision_check')
    expect(sql).toContain('capability_attempt_adjudications_observed_outcome_digest_check')

    // Verification-mode / verifier-required consistency (I6 storage half).
    expect(sql).toContain('capability_attempts_verifier_consistency_check')
    expect(sql).toContain('capability_attempts_verification_mode_check')
    expect(sql).toContain('capability_attempts_unclassified_check')
    expect(sql).toContain('capability_attempts_operation_runtime_check')

    // Shape closure per adjudication kind.
    expect(sql).toContain('capability_attempt_adjudications_kind_shape_check')

    // Evidence refs are UUID-only, enforced at the database boundary on both
    // tables (I1): a bounded array whose every element matches the ADR 0010
    // UUID grammar, so paths, transcripts, and credentials cannot enter the
    // append-only ledger even by mistake.
    const uuidElement = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89a-bA-B][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
    for (const constraint of [
      'capability_attempts_evidence_refs_check',
      'capability_attempt_adjudications_evidence_refs_check',
    ]) {
      expect(sql).toContain(constraint)
    }
    expect(sql).toContain(`^\\[\\]$|^\\["${uuidElement}"(, "${uuidElement}")*\\]$`)
    expect(sql).toContain('pg_catalog.jsonb_array_length("evidence_refs") <= 128')

    // The element-wise validation must stay inline. A helper routine would
    // have to be PUBLIC-executable (CHECK runs as the inserting role), which
    // puts it in every role's effective privilege set and breaks the closed
    // routine allowlists proved elsewhere in CI.
    expect(sql).not.toContain('CREATE FUNCTION "forge_is_uuid_evidence_refs_v1"')

    // The drizzle schema must declare the same boundary: if it ever drifts
    // back to a bare jsonb_typeof array check, `npm run db:generate` would
    // silently emit a migration that reverts the UUID-only guarantee.
    const schemaSource = await fs.readFile(path.join(process.cwd(), 'db/schema.ts'), 'utf8')
    for (const constraint of [
      'capability_attempts_evidence_refs_check',
      'capability_attempt_adjudications_evidence_refs_check',
    ]) {
      expect(schemaSource).toContain(constraint)
    }
    expect(schemaSource).not.toContain("check('capability_attempts_evidence_refs_check', sql`jsonb_typeof(${t.evidenceRefs}) = 'array'`)")
    expect(schemaSource).not.toContain("check('capability_attempt_adjudications_evidence_refs_check', sql`jsonb_typeof(${t.evidenceRefs}) = 'array'`)")
    expect(schemaSource).not.toContain('forge_is_uuid_evidence_refs_v1')
  })

  it('grants only SELECT/INSERT to the ordinary application role in the CI ACL gate', async () => {
    const yml = await fs.readFile(path.join(process.cwd(), '../.github/workflows/web-ci.yml'), 'utf8')
    expect(yml).toContain('capability_attempts')
    expect(yml).toContain('capability_attempt_adjudications')
    expect(yml).toMatch(/GRANT SELECT, INSERT ON TABLE public\.capability_attempts,\s*\n\s*public\.capability_attempt_adjudications TO forge_app_test/)
  })
})
