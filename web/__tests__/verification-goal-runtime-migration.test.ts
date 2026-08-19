import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('verification goal runtime routines migration', () => {
  it('grants exactly the current routine signatures the runner actually calls', async () => {
    const migration = await readFile(
      path.join(process.cwd(), 'db/migrations/0036_verification_goal_runtime_routines.sql'),
      'utf8',
    )

    // The child finalizer moved to a 9-argument signature; its GRANT must
    // match the definition or PostgreSQL matches nothing and execution fails.
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.forge_finalize_verification_goal_child_operation_v1(\n'
      + '  uuid, uuid, uuid, text, text, text, boolean, text, text\n'
      + ') TO forge;',
    )
    expect(migration).not.toContain('boolean, text\n) TO forge')

    // The schedule slot claimer takes six arguments; the stale seven-argument
    // GRANT from the first draft would match nothing.
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.forge_claim_verification_goal_schedule_slot_v1(\n'
      + '  uuid, bigint, jsonb, text, timestamptz, text\n'
      + ') TO forge;',
    )

    // The child-begin routine keeps the reviewed twelve-argument signature
    // from migration 0035.
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.forge_begin_verification_goal_child_operation_v1(\n'
      + '  p_run_id uuid,\n'
      + '  p_ordinal integer,\n'
      + '  p_operation_id text,\n'
      + '  p_operation_version integer,\n'
      + '  p_capability text,\n'
      + '  p_idempotency_key text,\n'
      + '  p_definition_digest text,\n'
      + '  p_scope_fingerprint text,\n'
      + '  p_request_fingerprint text,\n'
      + '  p_inputs_fingerprint text,\n'
      + '  p_reason_fingerprint text,\n'
      + '  p_policy_decision jsonb\n'
      + ')',
    )
  })

  it('keeps lease fencing, evidence guards, and event sequencing exact', async () => {
    const migration = await readFile(
      path.join(process.cwd(), 'db/migrations/0036_verification_goal_runtime_routines.sql'),
      'utf8',
    )

    // A lease claim may only ever pick up a still-unexpired queued row.
    expect(migration).toContain(
      "AND status = 'queued'\n"
      + "    AND admission_expiry > pg_catalog.clock_timestamp();",
    )

    // Child finalization must carry the exact claim token of the live lease.
    expect(migration).toContain('OR v_run.lease_token <> p_lease_token')

    // A run can only be canonicalized as passed when both repository and
    // environment evidence exist and belong to the run.
    expect(migration).toContain(
      "'verification goal passed terminalization requires repository and environment evidence'",
    )

    // The begun child event links the operation-run row.
    expect(migration).toContain("'child_begun', 'ok', v_new_id")
  })

  it('keeps the reconcile script signatures aligned with the migration', async () => {
    const reconciler = await readFile(
      path.join(process.cwd(), '../scripts/reconcile-forge-app-privileges.sql'),
      'utf8',
    )

    expect(reconciler).toContain(
      'REVOKE ALL ON FUNCTION public.forge_finalize_verification_goal_child_operation_v1(\n'
      + '  uuid,uuid,uuid,text,text,text,boolean,text,text\n'
      + ') FROM PUBLIC, forge;',
    )
    expect(reconciler).toContain(
      'GRANT EXECUTE ON FUNCTION public.forge_finalize_verification_goal_child_operation_v1(\n'
      + '  uuid,uuid,uuid,text,text,text,boolean,text,text\n'
      + ') TO forge;',
    )
    expect(reconciler).toContain(
      'REVOKE ALL ON FUNCTION public.forge_claim_verification_goal_schedule_slot_v1(\n'
      + '  uuid,bigint,jsonb,text,timestamptz,text\n'
      + ') FROM PUBLIC, forge;',
    )
    expect(reconciler).toContain(
      'GRANT EXECUTE ON FUNCTION public.forge_claim_verification_goal_schedule_slot_v1(\n'
      + '  uuid,bigint,jsonb,text,timestamptz,text\n'
      + ') TO forge;',
    )

    // The verification inventory entries use the regprocedure spelling with
    // `timestamp with time zone`, and carry the current arities.
    expect(reconciler).toContain(
      "'forge_finalize_verification_goal_child_operation_v1(uuid,uuid,uuid,text,text,text,boolean,text,text)'",
    )
    expect(reconciler).toContain(
      "'forge_claim_verification_goal_schedule_slot_v1(uuid,bigint,jsonb,text,timestamp with time zone,text)'",
    )
  })
})
