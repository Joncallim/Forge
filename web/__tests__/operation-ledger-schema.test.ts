import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('operation ledger migration', () => {
  it('persists immutable digests, policy, ordered events, and canonical outcome linkage', async () => {
    const sql = await fs.readFile(path.join(process.cwd(), 'db/migrations/0030_operation_runs.sql'), 'utf8')
    expect(sql).toContain('"definition_digest" text NOT NULL')
    expect(sql).toContain('"scope_fingerprint" text NOT NULL')
    expect(sql).toContain('"outcome_fingerprint" text')
    expect(sql).toContain('"policy_decision" jsonb NOT NULL')
    expect(sql).toContain('"execution_outcome_id" uuid')
    expect(sql).toContain('operation_runs_fingerprints_check')
    expect(sql).toContain('operation_run_events_phase_sequence_check')
    expect(sql).toContain('operation_run_events_order_guard')
    expect(sql).toContain("v_last_sequence = 1")
    expect(sql).toContain("v_last_status = 'passed'")
    expect(sql).toContain('outcome_fingerprint')
    expect(sql).toContain('operation_run_events_append_only')
  })
})
