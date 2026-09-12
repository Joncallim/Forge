import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(fileURLToPath(new URL('../db/migrations/0034_vnext_phase0_a1_runtime_foundation.sql', import.meta.url)), 'utf8')
const reconciler = readFileSync(fileURLToPath(new URL('../../scripts/reconcile-forge-app-privileges.sql', import.meta.url)), 'utf8')

describe('VNext Phase 0 A1 protected persistence foundation', () => {
  it('uses the bounded non-login protected-owner handoff rather than application DML', () => {
    expect(migration).toContain('SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();')
    expect(migration).toContain('SET ROLE forge_s4_routines_owner;')
    expect(migration).toContain('SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();')
    expect(migration).toContain("REVOKE ALL ON TABLE missions, executions, task_mission_bindings, runtime_transition_audits FROM PUBLIC, forge;")
    expect(migration).toContain("IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner'")
  })

  it('makes the canonical state transition ledger append-only and atomic in its routines', () => {
    expect(migration).toContain('CONSTRAINT runtime_transition_audits_unique_revision UNIQUE (entity_kind, entity_id, resulting_revision)')
    expect(migration).toContain("IF TG_OP IN ('UPDATE', 'DELETE') AND TG_TABLE_NAME = 'runtime_transition_audits'")
    const transition = migration.slice(migration.indexOf('CREATE FUNCTION forge.transition_vnext_execution_v1'))
    expect(transition.indexOf('UPDATE executions')).toBeLessThan(transition.indexOf('INSERT INTO runtime_transition_audits'))
    expect(transition).toContain("RAISE EXCEPTION 'VNext execution revision conflict'")
    expect(transition).toContain("RAISE EXCEPTION 'VNext execution terminal state is absorbing'")
  })

  it('has no Task copy/backfill or prompt/title audit column in A1', () => {
    expect(migration).not.toMatch(/insert\s+into\s+task_mission_bindings[\s\S]*select/i)
    expect(migration).not.toMatch(/\b(prompt|title|local_path)\b/i)
    expect(migration).toContain('task_mission_bindings')
  })

  it('keeps protected table inventory and app privileges explicit', () => {
    for (const table of ['missions', 'executions', 'task_mission_bindings', 'runtime_transition_audits']) {
      expect(reconciler).toContain(`('${table}', 'forge_s4_routines_owner')`)
      expect(reconciler).toContain(`public.${table}`)
    }
    expect(reconciler).toContain('forge.create_vnext_mission_v1')
    expect(reconciler).toContain('forge.transition_vnext_execution_v1')
  })
})
