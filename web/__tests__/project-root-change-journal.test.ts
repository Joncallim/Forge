import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PROJECT_ROOT_CHANGE_JOURNAL_OUTCOMES,
  parseProjectRootChangeJournalEntry,
} from '@/lib/mcps/project-root-change-journal'

const migration = readFileSync(
  fileURLToPath(new URL('../db/migrations/0027_epic_172_s4_packet_context.sql', import.meta.url)),
  'utf8',
)
const schema = readFileSync(
  fileURLToPath(new URL('../db/schema.ts', import.meta.url)),
  'utf8',
)
const bootstrap = readFileSync(
  fileURLToPath(new URL('../scripts/bootstrap-epic-172-s4-roles.ts', import.meta.url)),
  'utf8',
)

const validEntry = () => ({
  generation: '1',
  operationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  outcome: 'root_update',
  rootBindingRevision: '2',
  grantDecisionRevision: '3',
  occurredAt: new Date('2026-07-27T00:00:00.000Z'),
})

describe('project root change journal contract', () => {
  it('shares the exact closed outcome tuple with the bounded parser', () => {
    expect(PROJECT_ROOT_CHANGE_JOURNAL_OUTCOMES).toEqual(['insert', 'root_update', 'archive'])
    expect(migration).toContain("outcome IN ('insert','root_update','archive')")
    expect(schema).toContain("in ('insert','root_update','archive')")
    expect(parseProjectRootChangeJournalEntry(validEntry())).toEqual(expect.objectContaining({
      generation: BigInt(1),
      outcome: 'root_update',
      rootBindingRevision: BigInt(2),
      grantDecisionRevision: BigInt(3),
    }))
  })

  it.each([
    'root-update', 'deleted_row', 'deleted-row', 'delete', 'unknown', null, 7,
  ])('rejects stale or unknown outcome %#', (outcome) => {
    expect(() => parseProjectRootChangeJournalEntry({ ...validEntry(), outcome })).toThrow(/outcome/i)
  })

  it.each([
    ['generation', '0'],
    ['generation', '-1'],
    ['generation', 1],
    ['rootBindingRevision', '0'],
    ['rootBindingRevision', '-1'],
    ['grantDecisionRevision', '0'],
    ['grantDecisionRevision', '-1'],
    ['operationId', 'not-a-uuid'],
    ['projectId', '00000000-0000-0000-0000-000000000000'],
    ['occurredAt', new Date('invalid')],
    ['unexpected', 'value'],
  ])('rejects malformed bounded field %s', (field, replacement) => {
    const entry = validEntry() as Record<string, unknown>
    entry[field] = replacement
    expect(() => parseProjectRootChangeJournalEntry(entry)).toThrow()
  })

  it('allows null only when a project has no applicable positive revision yet', () => {
    expect(parseProjectRootChangeJournalEntry({
      ...validEntry(), outcome: 'insert', rootBindingRevision: null, grantDecisionRevision: null,
    })).toEqual(expect.objectContaining({ rootBindingRevision: null, grantDecisionRevision: null }))
  })

  it('uses a protected gap-free counter and an append-only, path-free trigger journal', () => {
    const journalStart = migration.indexOf('CREATE TABLE public.project_root_change_journal (')
    const journalEnd = migration.indexOf('--> statement-breakpoint', journalStart)
    const journalTable = migration.slice(journalStart, journalEnd)
    expect(journalTable).toContain("outcome IN ('insert','root_update','archive')")
    expect(journalTable).not.toMatch(/local_path|root_ref|jsonb|reason|text\s+NOT NULL.*content/i)
    expect(migration).toContain('CREATE TABLE public.project_root_change_journal_counter')
    expect(migration).toContain('UPDATE public.project_root_change_journal_counter counter')
    expect(migration).toContain('RETURNING counter.last_generation INTO STRICT v_generation')
    expect(migration).not.toMatch(/project_root_change_journal[\s\S]{0,120}(?:bigserial|identity|nextval)/i)
    const appendStart = migration.indexOf('CREATE OR REPLACE FUNCTION forge.append_project_root_change_journal_v1()')
    const appendEnd = migration.indexOf('--> statement-breakpoint', appendStart)
    const appendFunction = migration.slice(appendStart, appendEnd)
    expect(appendFunction.match(/INSERT INTO public\.project_root_change_journal/g)).toHaveLength(1)
    expect(appendFunction).not.toMatch(/FOR UPDATE.*projects|projects.*FOR UPDATE/i)
    expect(migration).toContain("NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL")
    expect(migration).toContain("v_outcome := 'archive'")
    expect(migration).toContain("v_outcome := 'root_update'")
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.project_root_change_journal')
    expect(migration).toContain("RAISE EXCEPTION 'project root change journal is append-only'")
  })

  it('keeps the journal protected, owned, and absent from the premature unique-index cutover', () => {
    for (const objectName of ['project_root_change_journal', 'project_root_change_journal_counter']) {
      expect(bootstrap).toContain(`'${objectName}'`)
      expect(migration).toContain(`ALTER TABLE public.${objectName} OWNER TO forge_s4_routines_owner`)
    }
    for (const routine of [
      'append_project_root_change_journal_v1',
      'reject_project_root_change_journal_mutation_v1',
    ]) {
      expect(bootstrap).toContain(`'${routine}'`)
      expect(migration).toContain(`REVOKE ALL ON FUNCTION forge.${routine}() FROM PUBLIC`)
    }
    expect(migration).toContain('REVOKE ALL ON public.architect_plan_versions')
    expect(migration).toContain('public.project_root_change_journal FROM PUBLIC')
    expect(bootstrap).toContain('where acl.grantee <> table_row.relowner')
    expect(schema).toContain("export const projectRootChangeJournal = pgTable('project_root_change_journal'")
    expect(migration).not.toContain('CREATE UNIQUE INDEX projects_root_ref_idx')
    expect(schema).not.toContain("uniqueIndex('projects_root_ref_idx')")
  })
})
