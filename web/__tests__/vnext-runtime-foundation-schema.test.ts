import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reasonCodes } from '@/lib/runtime/v1'

const migration = readFileSync(fileURLToPath(new URL('../db/migrations/0034_vnext_phase0_a1_runtime_foundation.sql', import.meta.url)), 'utf8')
const reconciler = readFileSync(fileURLToPath(new URL('../../scripts/reconcile-forge-app-privileges.sql', import.meta.url)), 'utf8')
const bootstrap = readFileSync(fileURLToPath(new URL('../scripts/bootstrap-vnext-runtime-owner.ts', import.meta.url)), 'utf8')
const migrator = readFileSync(fileURLToPath(new URL('../db/migrate.ts', import.meta.url)), 'utf8')
const migrationWrapper = readFileSync(fileURLToPath(new URL('../scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh', import.meta.url)), 'utf8')
const journal = JSON.parse(readFileSync(fileURLToPath(new URL('../db/migrations/meta/_journal.json', import.meta.url)), 'utf8')) as { entries: Array<{ idx: number; tag: string }> }

describe('VNext Phase 0 A1 protected persistence foundation', () => {
  it('uses the bounded non-login protected-owner handoff rather than application DML', () => {
    expect(migration).toContain('SET ROLE forge_runtime_routines_owner;')
    expect(migration).not.toContain('forge_s4_routines_owner')
    expect(migration).toContain('REVOKE ALL ON TABLE public.missions,public.executions,public.task_mission_bindings,public.runtime_transition_audits FROM PUBLIC,forge;')
    expect(migration).toContain("NOT pg_catalog.pg_has_role(session_user,'forge_runtime_api','member') OR current_user<>'forge_runtime_routines_owner'")
    expect(migration).toContain("NOT pg_catalog.pg_has_role(session_user,'forge_runtime_api','member') THEN RAISE EXCEPTION 'VNext mission creation requires the dedicated authenticated server boundary'")
    expect(migration).toContain('TO forge_runtime_api;')
    expect(migration).toContain('SET search_path=pg_catalog AS')
    expect(bootstrap).toContain("const OWNER = 'forge_runtime_routines_owner'")
  })

  it('makes the canonical state transition ledger append-only and atomic in its routines', () => {
    expect(migration).toContain('CONSTRAINT runtime_transition_audits_unique_revision UNIQUE(entity_kind,entity_id,resulting_revision)')
    expect(migration).toContain("TG_OP IN ('UPDATE','DELETE') AND TG_TABLE_NAME='runtime_transition_audits'")
    const transition = migration.slice(migration.indexOf('CREATE FUNCTION forge.transition_vnext_execution_v1'))
    expect(transition.indexOf('UPDATE public.executions')).toBeLessThan(transition.indexOf('INSERT INTO public.runtime_transition_audits'))
    expect(transition).toContain("RAISE EXCEPTION 'VNext execution revision conflict'")
    expect(transition).toContain("RAISE EXCEPTION 'VNext execution terminal state is absorbing'")
  })

  it('enforces the closed reason registry and strict persisted binding shapes', () => {
    expect(migration).toContain('vnext_reason_code_valid_v1')
    expect(migration).toContain('vnext_resource_bindings_valid_v1')
    expect(migration).toContain('vnext_compatibility_pins_valid_v1')
    expect(migration).toContain('p_task_id IS NOT NULL AND NOT EXISTS')
    expect(migration).toContain("jsonb_typeof(item->'resource'->'id') IS DISTINCT FROM 'string'")
    expect(migration).toContain('jsonb_array_length(p_bindings) <= 32')
    expect(migration).toContain('IS NOT TRUE')
    expect(migration).toContain("'generic_zero_capability_v1'")
    expect(migration).toContain("p_bindings = '[]'::jsonb")
    for (const type of ['operator', 'system', 'mission', 'execution', 'agent_run', 'trigger', 'adapter', 'verifier', 'service']) {
      expect(migration).toContain(`'${type}'`)
    }
  })

  it('contains every accepted SPEC-0007 v1 reason in both the TS and SQL boundaries', () => {
    const specification = readFileSync(fileURLToPath(new URL('../../docs/specs/SPEC-0007.md', import.meta.url)), 'utf8')
    const codeBlock = specification.match(/### R7: Initial reason codes[\s\S]*?```\n([\s\S]*?)```/)
    expect(codeBlock?.[1]).toBeTruthy()
    const requiredCodes = codeBlock![1].split('\n').map((line) => line.trim()).filter(Boolean)
    expect(reasonCodes).toEqual(expect.arrayContaining(requiredCodes))
    for (const code of requiredCodes) expect(migration).toContain(`'${code}'`)
  })

  it('keeps A1 at the journal migration tip so a generated installer cannot silently skip it', () => {
    expect(journal.entries.at(-1)).toMatchObject({ idx: 34, tag: '0034_vnext_phase0_a1_runtime_foundation' })
    expect(migration).toContain('CREATE TABLE public.missions')
  })

  it('keeps ordinary latest migration and repair on the documented bounded handoff', () => {
    expect(migrator).toContain('pendingProtectedMigrations')
    expect(migrator).toContain('protectedMigrationRecoveryPlan')
    expect(migrator).toContain('protectedMigrationCleanupState')
    expect(migrator).not.toContain('RUNTIME_FOUNDATION_MIGRATION_AT')
    expect(bootstrap).toContain('recordProtectedMigrationHandoff')
    expect(bootstrap).toContain('recordProtectedMigrationCleanup')
    expect(migrationWrapper).toContain('cleanup\ntrap - EXIT\nnpx tsx db/migrate.ts')
    expect(bootstrap).toContain("process.env.FORGE_DATABASE_ADMIN_URL?.trim() || getRequiredEnv('DATABASE_URL')")
    expect(bootstrap).toContain("const API = 'forge_runtime_api'")
    expect(bootstrap).toContain('from pg_catalog.pg_authid where rolname = ${OWNER}')
    expect(bootstrap).toContain('from pg_catalog.pg_authid where rolname = ${API}')
  })

  it('never invokes the protected 0034 migration before its historical ownership prerequisites', () => {
    for (const command of [
      'protocol:bootstrap-epic-172-release-roles',
      'migrate-through-0025.ts',
      'protocol:bootstrap-epic-172-s3-release-owner',
      'migrate-through-0026.ts',
      'protocol:bootstrap-epic-172-s4-roles',
      'migrate-through-0027.ts',
      'apply-epic-172-s5-recovery-migration.sh',
      'apply-verification-goal-registry-migration.sh',
    ]) expect(migrationWrapper).toContain(command)
    expect(migrationWrapper.indexOf('migrate-through-0027.ts')).toBeLessThan(migrationWrapper.lastIndexOf('bootstrap-vnext-runtime-owner.ts'))
    expect(migrationWrapper.indexOf('migrate-through-0034.ts')).toBeLessThan(migrationWrapper.indexOf('npx tsx db/migrate.ts'))
  })

  it('has no Task copy/backfill or prompt/title audit column in A1', () => {
    expect(migration).not.toMatch(/insert\s+into\s+task_mission_bindings[\s\S]*select/i)
    expect(migration).not.toMatch(/\b(prompt|title|local_path)\b/i)
    expect(migration).toContain('task_mission_bindings')
  })

  it('keeps protected table inventory and app privileges explicit', () => {
    for (const table of ['missions', 'executions', 'task_mission_bindings', 'runtime_transition_audits']) {
      expect(reconciler).toContain(`('${table}', 'forge_runtime_routines_owner')`)
      expect(reconciler).toContain(`public.${table}`)
    }
    expect(reconciler).toContain("routine.proowner = 'forge_runtime_routines_owner'::pg_catalog.regrole")
    expect(reconciler).toContain('forge.create_vnext_mission_v1')
    expect(reconciler).toContain('forge.transition_vnext_execution_v1')
    expect(reconciler).toContain("GRANT SELECT (id, submitted_by) ON TABLE public.tasks TO forge_runtime_routines_owner;")
    expect(bootstrap).toContain('grant select (id, submitted_by) on table public.tasks')
  })

  it('makes Task current execution pointers forward-only and non-terminal', () => {
    expect(migration).toContain('executions_mission_sequence_unique UNIQUE (mission_id,execution_sequence)')
    expect(migration).toContain("v_next_lifecycle='terminal' OR v_next_sequence<=v_current_sequence")
    expect(migration).toContain("VNext task pointer requires a newer non-terminal Execution")
    expect(migration).toContain("VNext current execution pointer requires a non-terminal successor")
  })
})
