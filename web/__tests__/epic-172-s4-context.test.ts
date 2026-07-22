import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { McpWorkPackageAdmission } from '@/lib/mcps/admission'
import {
  ARCHITECT_PLAN_HEADER,
  architectPlanEntryReference,
  architectReplanReferenceForEntry,
  materializeArchitectPlanEntries,
  parseArchitectPlanEntryReference,
  verifyArchitectPlanEntry,
} from '@/lib/mcps/architect-plan-entries'
import { serializeExecutableMcpPrompt } from '@/lib/mcps/bounded-executable-prompt'
import { projectExecutableMcpInstructions } from '@/lib/mcps/executable-instruction-projection'
import {
  packetCandidateGuard,
  packetTerminalTupleIsValid,
  parsePacketAuthorizationSnapshot,
  parsePacketRedactionSummary,
  parseTerminalPacketAssembly,
  type PacketAuthorizationSnapshot,
} from '@/lib/mcps/packet-issuance-v2'
import {
  localEffectCandidateGuard,
  parseLocalEffectRecoveryMarker,
  parseRepositoryChangeReview,
} from '@/lib/mcps/local-run-evidence-v2'
import {
  LOCAL_EFFECT_RECOVERY_ACTIONS,
  MCP_ADMISSION_OPERATOR_RECOVERY_SUITE_ID,
  PACKET_ISSUANCE_RECOVERY_ACTIONS,
} from '@/lib/mcps/recovery-actions-v2'
import { computeCredentialDigest } from '@/lib/session-credential-digest'
import { sanitizePromptPayload } from '@/lib/mcps/leakage-drain'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000003'
const RUN_ID = '00000000-0000-4000-8000-000000000004'
const AUDIT_ID = '00000000-0000-4000-8000-000000000005'
const APPROVAL_ID = '00000000-0000-4000-8000-000000000006'
const NONCE = '00000000-0000-4000-8000-000000000007'
const SHA = `sha256:${'a'.repeat(64)}`
const webCiWorkflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/web-ci.yml', import.meta.url)),
  'utf8',
)
const s4RoleBootstrap = readFileSync(
  fileURLToPath(new URL('../scripts/bootstrap-epic-172-s4-roles.ts', import.meta.url)),
  'utf8',
)
const s4Migration = readFileSync(
  fileURLToPath(new URL('../db/migrations/0027_epic_172_s4_packet_context.sql', import.meta.url)),
  'utf8',
)
const sessionReconciliation = readFileSync(
  fileURLToPath(new URL('../scripts/reconcile-session-credentials.ts', import.meta.url)),
  'utf8',
)

function decision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    mcpId: 'filesystem',
    agent: 'backend',
    requirement: 'required',
    requestedCapabilities: ['filesystem.project.read'],
    normalizedCapabilities: ['filesystem.project.read'],
    capabilityClasses: [{
      capability: 'filesystem.project.read',
      class: 'bounded_read_only',
      deliveryKind: 'bounded_context_packet',
    }],
    mode: 'bounded_context_approved',
    status: 'allowed',
    reason: 'allowed',
    evidenceRefs: [],
    ...overrides,
  }
}

function admission(overrides: Partial<McpWorkPackageAdmission> = {}): McpWorkPackageAdmission {
  return {
    schemaVersion: 2,
    evaluations: [{
      decision: decision(),
      source: {
        requirementKey: 'filesystem-context',
        decisionId: 'decision-1',
        sourceRequirementIndex: 0,
        assignment: { type: 'role', targetId: 'backend' },
        fallback: { action: 'block', message: '' },
        promptOverlayPresent: true,
      },
      health: {
        mcpId: 'filesystem', enabled: true, installState: 'installed',
        status: 'healthy', error: null, observedAt: null,
      },
    }],
    subtaskDecisions: [{
      subtaskId: 'subtask-1', agent: 'backend', requirementKey: 'filesystem-context',
      mcpId: 'filesystem', capability: 'filesystem.project.read',
      class: 'bounded_read_only', deliveryKind: 'bounded_context_packet',
      status: 'allowed', reason: 'allowed',
    }],
    referencedHealth: [],
    aggregate: { status: 'allowed', blocked: [], warnings: [], blockedReason: null, retryable: false },
    ...overrides,
  } as McpWorkPackageAdmission
}

describe('Epic 172 S4 PostgreSQL CI contract', () => {
  it('bootstraps S4 before migration and makes all dedicated PostgreSQL fixtures mandatory', () => {
    const bootstrapIndex = webCiWorkflow.indexOf('name: Bootstrap migration-0027 S4 protocol ownership')
    const migrateIndex = webCiWorkflow.indexOf('name: Apply migrations as the disposable migration owner')
    expect(bootstrapIndex).toBeGreaterThan(-1)
    expect(migrateIndex).toBeGreaterThan(bootstrapIndex)
    expect(webCiWorkflow).toContain('npm run protocol:bootstrap-epic-172-s4-roles')
    expect(webCiWorkflow).toContain("FORGE_S4_REQUIRE_POSTGRES_TEST: '1'")
    for (const variable of [
      'FORGE_S4_POSTGRES_TEST_DATABASE_URL',
      'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
      'FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL',
      'FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL',
      'FORGE_PACKET_ISSUER_DATABASE_URL',
      'FORGE_EPIC_172_TEST_APP_DATABASE_URL',
    ]) {
      expect(webCiWorkflow).toContain(`${variable}:`)
    }
  })

  it('keeps every S4-owned table outside the ordinary application grant loop', () => {
    for (const table of [
      'architect_plan_versions',
      'architect_plan_entries',
      'architect_plan_execution_references',
      'architect_plan_history_reads',
      'work_package_local_run_evidence',
      'filesystem_mcp_decision_nonce_claims',
    ]) {
      expect(webCiWorkflow.match(new RegExp(`'public\\.${table}'`, 'g'))).toHaveLength(1)
      expect(webCiWorkflow.match(new RegExp(`'${table}'`, 'g'))).toHaveLength(1)
    }
  })

  it('uses only the Step 0 enablement authority for protected S4 paths', () => {
    expect(s4Migration).not.toContain('CREATE TABLE public.epic_172_s4_protocol_state')
    expect(s4Migration).not.toContain('FROM public.epic_172_s4_protocol_state')
    expect(s4Migration).toContain('FROM forge.read_epic_172_enablement_state_v1() state')
    expect(s4Migration).not.toContain("'issue_179_s4@' || state.reviewed_sha")
    expect(s4Migration).toContain('pg_catalog.count(DISTINCT build.value) = 3')
    expect(s4Migration).toContain("'^issue_179_s4@[^@[:space:]]+$'")
    expect(s4Migration).toContain("'^issue_180_s5@[^@[:space:]]+$'")
    expect(s4Migration).toContain("'^issue_181_s6@[^@[:space:]]+$'")
  })

  it('keeps the ordinary-app Architect trigger on an S4-owned security-definer bridge', () => {
    const definitions = s4Migration.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) ?? []
    const predicate = definitions.find((definition) => definition.startsWith(
      'CREATE OR REPLACE FUNCTION forge.s4_protected_paths_enabled_v1()',
    ))
    const guard = definitions.find((definition) => definition.startsWith(
      'CREATE OR REPLACE FUNCTION forge.guard_architect_plan_public_artifact_v1()',
    ))

    expect(predicate).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/)
    expect(guard).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, forge/)
    for (const routine of [
      's4_protected_paths_enabled_v1',
      'guard_architect_plan_public_artifact_v1',
    ]) {
      expect(s4Migration).toContain(`REVOKE ALL ON FUNCTION forge.${routine}() FROM PUBLIC;`)
      expect(s4Migration).toContain(
        `ALTER FUNCTION forge.${routine}() OWNER TO forge_s4_routines_owner;`,
      )
    }

    const predicateCallers = definitions.filter((definition) => (
      definition.includes('forge.s4_protected_paths_enabled_v1()')
      && !definition.startsWith('CREATE OR REPLACE FUNCTION forge.s4_protected_paths_enabled_v1()')
    ))
    expect(predicateCallers.map((definition) => definition.match(
      /CREATE OR REPLACE FUNCTION forge\.([a-z0-9_]+)/,
    )?.[1])).toEqual([
      'append_mcp_operator_review_version_v1',
      'guard_architect_plan_public_artifact_v1',
      'read_architect_plan_history_v1',
      'read_mcp_operator_review_history_v1',
      'list_approved_package_plan_registrations_v1',
      'resolve_architect_plan_entry_v1',
      's4_runtime_mode_v1',
      'read_s4_runtime_mode_for_application_v1',
      'create_local_run_evidence_v1',
      'insert_packet_authorization_snapshot_v2',
      'claim_packet_lifecycle_v2',
      'claim_work_package_lifecycle_v2',
      'lock_live_packet_lifecycle_v2',
      'lock_live_local_lifecycle_v2',
      'list_pending_s4_completion_handoffs_v1',
      'claim_pending_s4_completion_handoffs_v1',
      'finalize_s4_max_attempts_v1',
      'recover_stale_local_lifecycle_v2',
      'recover_stale_packet_lifecycle_v2',
      'cas_packet_reapproval_v2',
      'apply_local_effect_recovery_action_v2',
      'apply_packet_issuance_recovery_action_v2',
      'insert_architect_plan_version_v1',
      'bind_architect_plan_entry_v1',
      'bind_architect_replan_entry_v1',
      'register_package_plan_entries_v1',
      'bind_architect_plan_entry_v2',
      'bind_architect_replan_context_v2',
    ])
    for (const caller of predicateCallers) expect(caller).toContain('SECURITY DEFINER')
  })

  it('exposes only atomic S4 lifecycle entry points to the packet issuer', () => {
    for (const helper of [
      'create_local_run_evidence_v1(uuid,uuid,integer)',
      'insert_packet_authorization_snapshot_v2(uuid,uuid,uuid,uuid,uuid,integer,text[])',
      'claim_local_lifecycle_v2(uuid,uuid,integer)',
      'claim_packet_lifecycle_v2(uuid,uuid,uuid,uuid,integer,integer,text[])',
      'lock_live_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint)',
      'lock_live_local_lifecycle_v2(uuid,uuid,bigint)',
      'recover_stale_local_lifecycle_v2(uuid)',
      'recover_stale_packet_lifecycle_v2(uuid)',
    ]) {
      expect(s4Migration).toContain(`REVOKE ALL ON FUNCTION forge.${helper} FROM PUBLIC;`)
      expect(s4Migration).not.toContain(
        `GRANT EXECUTE ON FUNCTION forge.${helper} TO forge_packet_issuer;`,
      )
    }
    for (const entryPoint of [
      'claim_work_package_lifecycle_v2(text,uuid,uuid,timestamptz,uuid,text,uuid,integer,uuid,text,timestamptz,text,text,integer,uuid,uuid,uuid,integer,integer,text[])',
      'heartbeat_local_lifecycle_v2(uuid,uuid,bigint,integer)',
      'heartbeat_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint,integer,integer)',
      'recover_linked_s4_lifecycle_v2(uuid)',
    ]) {
      expect(s4Migration).toContain(
        `GRANT EXECUTE ON FUNCTION forge.${entryPoint} TO forge_packet_issuer;`,
      )
    }
    expect(s4Migration).toContain('evidence.lease_expires_at > v_now')
    expect(s4Migration).toContain('audit.lease_expires_at > v_now')
    expect(s4Migration).not.toContain('Date.now()')
  })

  it('keeps the Architect replan arm purpose-discriminated and one-reader-only', () => {
    expect(s4Migration).toContain("purpose IN ('package_specialist', 'architect_replan')")
    expect(s4Migration).toContain("purpose = 'architect_replan'")
    expect(s4Migration).toContain("entry.entry_id = 'plan_body:000000'")
    expect(s4Migration).toContain('AND NOT entry.projection_eligible')
    expect(s4Migration).toContain('CREATE OR REPLACE FUNCTION forge.bind_architect_replan_entry_v1(')
    expect(s4Migration).toContain(
      'GRANT EXECUTE ON FUNCTION forge.bind_architect_replan_entry_v1(uuid,uuid) TO forge_architect_plan_writer;',
    )
    expect(s4Migration).not.toContain(
      'forge.bind_architect_replan_entry_v1(uuid,uuid,uuid,bigint,text,text,text)',
    )
    const binder = (s4Migration.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) ?? [])
      .find((definition) => definition.startsWith(
        'CREATE OR REPLACE FUNCTION forge.bind_architect_replan_entry_v1(',
      ))
    expect(binder).toContain('p_task_id uuid,\n  p_agent_run_id uuid')
    expect(binder).not.toMatch(/p_(?:plan_artifact_id|plan_version|entry_id|content_digest|digest_key_id)/)
    expect(binder).toContain('ORDER BY entry.plan_version DESC')
    expect(binder).toContain('FOR KEY SHARE OF entry, version, artifact, source_run')
    expect(s4Migration.match(/CREATE OR REPLACE FUNCTION forge\.resolve_architect_plan_entry_v1/g))
      .toHaveLength(1)
  })

  it('opens and closes one migration-session-bound S4 schema authority fence', () => {
    expect(s4Migration.indexOf('SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();'))
      .toBeLessThan(s4Migration.indexOf('DO $$'))
    expect(s4Migration.trimEnd()).toMatch(
      /SELECT public\.forge_finalize_epic_172_s4_owner_bootstrap_v1\(\);$/,
    )
    expect(s4RoleBootstrap).toContain('security definer')
    expect(s4RoleBootstrap).toContain('if session_user <> ${migrationLiteral}')
    expect(s4RoleBootstrap).toContain("'grant usage, create on schema forge to %I'")
    // The migration login keeps schema USAGE for the application reader but
    // loses its temporary CREATE authority at finalization.
    expect(s4RoleBootstrap).toContain("'revoke create on schema forge from %I'")
    expect(s4RoleBootstrap).not.toContain("'revoke usage, create on schema forge from %I'")
    expect(s4RoleBootstrap).toContain(
      "'revoke execute on function public.forge_begin_epic_172_s4_owner_bootstrap_v1() from %I'",
    )
    expect(s4RoleBootstrap).toContain(
      "'revoke execute on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() from %I'",
    )
    expect(s4RoleBootstrap).toContain("has_schema_privilege('${OWNER}', 'forge', 'create')")
    expect(s4RoleBootstrap).toContain('protectedMembershipEdges !== 0')
    expect(s4RoleBootstrap).toContain('An S4 protected principal has a pre-existing role membership edge')
    expect(s4RoleBootstrap).toContain(
      'The temporary migration-to-owner edge is not the exclusive S4 membership edge',
    )
    expect(s4RoleBootstrap).toContain('A finalized S4 protected principal retains a membership edge')
    expect(s4RoleBootstrap).toContain("'${OWNER}'::regrole")
    for (const role of [
      'forge_architect_plan_writer',
      'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader',
      'forge_packet_issuer',
    ]) {
      expect(s4RoleBootstrap).toContain(`'${role}'::regrole`)
    }
    const beginHelper = s4RoleBootstrap.slice(
      s4RoleBootstrap.indexOf('create or replace function public.forge_begin_epic_172_s4_owner_bootstrap_v1()'),
      s4RoleBootstrap.indexOf('create or replace function public.forge_finalize_epic_172_s4_owner_bootstrap_v1()'),
    )
    expect(beginHelper.indexOf("'grant ${OWNER} to %I with admin false, inherit false, set true'"))
      .toBeLessThan(beginHelper.indexOf(
        'The temporary migration-to-owner edge is not the exclusive S4 membership edge',
      ))
  })

  it('keeps session cutover additive until exact Redis expiry and key drain are proven', () => {
    expect(s4Migration).toContain("pg_catalog.convert_to('forge:web-session:v1', 'UTF8')")
    expect(s4Migration).toContain("|| pg_catalog.decode('00', 'hex')")
    expect(s4Migration).toContain('credential_storage_version integer NOT NULL DEFAULT 0')
    expect(s4Migration).toContain('legacy_redis_purge_pending_at timestamptz')
    expect(s4Migration).toContain('session_credential_reconciliation')
    expect(s4Migration).toContain("state IN ('expansion','draining','strict')")
    expect(s4Migration).toContain('sessions_credential_cutover_guard_v1')
    expect(s4Migration).not.toContain("last_seen_at + interval '7 days'")
    expect(s4Migration).not.toContain('ALTER COLUMN credential_digest_v1 SET NOT NULL')
    expect(s4Migration).not.toContain('ALTER COLUMN expires_at SET NOT NULL')
    expect(s4Migration).toContain('Session credential expired before history delivery')
    expect(sessionReconciliation).toContain("redis.call('PEXPIRETIME', KEYS[1])")
    expect(sessionReconciliation).toContain("redis.scan(cursor, 'MATCH', 'session:*'")
    expect(sessionReconciliation).toContain("if (!key.startsWith('session:v2:'))")
    expect(sessionReconciliation).not.toContain('Date.now()')
    expect(sessionReconciliation).toContain(
      'PostgreSQL did not preserve the exact Redis PEXPIRETIME value',
    )
    expect(sessionReconciliation).toContain('legacy_redis_purge_pending_at = pg_catalog.clock_timestamp()')
    expect(sessionReconciliation).toContain('await redis.del(legacyKey)')
    expect(sessionReconciliation.indexOf('await redis.del(legacyKey)')).toBeLessThan(
      sessionReconciliation.indexOf('credential_storage_version = 2'),
    )
    expect(sessionReconciliation).toContain('Strict session cutover zero-scan failed')
    expect(sessionReconciliation).toContain('Strict session cutover Redis zero-scan failed')
    expect(sessionReconciliation).toContain('alter column credential_digest_v1 set not null')
    expect(sessionReconciliation).toContain('alter column expires_at set not null')
  })
})

describe('Epic 172 S4 protected Architect plan history', () => {
  it('uses the exact domain-separated raw-cookie digest vector', () => {
    expect(computeCredentialDigest('00000000-0000-4000-8000-000000000000').digest.toString('hex'))
      .toBe('a4a6fe7265a6d2ec096cb0d31bb6b79d91a3d9a36537827009cb01f22e1f58e4')
    expect(() => computeCredentialDigest('00000000-0000-4000-8000-00000000000A'))
      .toThrow(/lowercase UUIDv4/)
  })

  it('normalizes prompt and secret aliases before draining them', () => {
    expect(sanitizePromptPayload({
      plan_body: 'raw plan',
      fullPlan: 'raw plan',
      architect_plan: 'raw plan',
      private_key: 'raw key',
      message: 'architect_plan: raw plan',
    })).toEqual({})
  })

  it('materializes deterministic NFC HMAC envelopes and text-free executable references', () => {
    const key = randomBytes(32)
    const first = materializeArchitectPlanEntries({
      digestKey: key,
      digestKeyId: 'plan-key-1',
      taskId: TASK_ID,
      planArtifactId: ARTIFACT_ID,
      planVersion: '1',
      entries: [{
        entryId: 'requirement:filesystem-context',
        entryKind: 'requirement',
        agent: 'backend',
        requirementKey: 'filesystem-context',
        bindingFingerprint: SHA,
        content: 'Use Cafe\u0301 read context.',
        projectionEligible: true,
      }],
    })
    const second = materializeArchitectPlanEntries({
      digestKey: key,
      digestKeyId: 'plan-key-1',
      taskId: TASK_ID,
      planArtifactId: ARTIFACT_ID,
      planVersion: '1',
      entries: [{
        entryId: 'requirement:filesystem-context',
        entryKind: 'requirement',
        agent: 'backend',
        requirementKey: 'filesystem-context',
        bindingFingerprint: SHA,
        content: 'Use Caf\u00e9 read context.',
        projectionEligible: true,
      }],
    })
    expect(first).toEqual(second)
    expect(verifyArchitectPlanEntry({ digestKey: key, entry: first.entries[0] })).toBe(true)
    expect(verifyArchitectPlanEntry({ digestKey: randomBytes(32), entry: first.entries[0] })).toBe(false)

    const reference = architectPlanEntryReference(first.entries[0])
    expect(JSON.stringify(reference)).not.toContain('Caf')
    expect(parseArchitectPlanEntryReference(reference)).toEqual(reference)
    expect(parseArchitectPlanEntryReference({ ...reference, content: 'leak' })).toBeNull()
    expect(ARCHITECT_PLAN_HEADER).not.toContain('Use Caf')
  })

  it('retains ambiguous legacy text but never makes it projection eligible', () => {
    expect(() => materializeArchitectPlanEntries({
      digestKey: randomBytes(32), digestKeyId: 'plan-key-1', taskId: TASK_ID,
      planArtifactId: ARTIFACT_ID, planVersion: '1',
      entries: [{
        entryId: 'legacy_full_plan:000001', entryKind: 'legacy_full_plan',
        agent: null, requirementKey: null, bindingFingerprint: null,
        content: 'Retained legacy plan', projectionEligible: true,
      }],
    })).toThrow(/never executable/)
  })

  it('keeps non-projection plan-body replan references distinct from executable references', () => {
    const protectedPlan = materializeArchitectPlanEntries({
      digestKey: randomBytes(32), digestKeyId: 'plan-key-1', taskId: TASK_ID,
      planArtifactId: ARTIFACT_ID, planVersion: '1',
      entries: [{
        entryId: 'plan_body:000000', entryKind: 'plan_body', agent: null,
        requirementKey: null, bindingFingerprint: null, content: 'Protected previous plan.',
        projectionEligible: false,
      }],
    })
    const planBody = protectedPlan.entries[0]
    expect(() => architectPlanEntryReference(planBody)).toThrow(/ineligible Architect history/i)
    const replanReference = architectReplanReferenceForEntry(planBody)
    expect(replanReference).toEqual(expect.objectContaining({
      entryId: 'plan_body:000000',
      contentDigest: planBody.contentDigest,
    }))
    expect(JSON.stringify(replanReference)).not.toContain('Protected previous plan.')
  })
})

describe('Epic 172 S4 executable projection and serialization', () => {
  it('includes only wholly admitted task-bound fragments in structured JSON', () => {
    const projection = projectExecutableMcpInstructions({
      admission: admission(),
      requirementSources: new Map([['filesystem-context', {
        key: 'filesystem-context', agent: 'backend', content: 'Read only the bounded project packet.',
      }]]),
      subtaskSources: new Map([['subtask-1', {
        key: 'subtask-1', agent: 'backend', content: 'Inspect the bounded inputs.',
      }]]),
    })
    expect(projection.requirementInstructions).toHaveLength(1)
    expect(projection.subtasks).toHaveLength(1)
    const serialized = serializeExecutableMcpPrompt({ digestKey: randomBytes(32), projection })
    expect(serialized.byteCount).toBe(Buffer.byteLength(serialized.json))
    expect(serialized.digest).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
    expect(JSON.parse(serialized.json).forgePolicy).toContain('Forge issued no live MCP handle.')
  })

  it('never echoes a rejected source and omits a subtask unless every binding is eligible', () => {
    const blocked = admission()
    blocked.evaluations[0].decision = decision({ status: 'blocked', mode: 'blocked' }) as never
    blocked.subtaskDecisions[0].status = 'blocked'
    const secret = 'DO-NOT-ECHO-REJECTED-CONTENT'
    const projection = projectExecutableMcpInstructions({
      admission: blocked,
      requirementSources: new Map([['filesystem-context', { key: 'filesystem-context', agent: 'backend', content: secret }]]),
      subtaskSources: new Map([['subtask-1', { key: 'subtask-1', agent: 'backend', content: secret }]]),
    })
    expect(projection.requirementInstructions).toEqual([])
    expect(projection.subtasks).toEqual([])
    expect(JSON.stringify(projection)).not.toContain(secret)
    expect(projection.staticBoundaryWarnings).toHaveLength(1)
  })
})

describe('Epic 172 S4 packet evidence', () => {
  const packageAuthorization: PacketAuthorizationSnapshot = {
    schemaVersion: 2,
    source: 'package_allow_once', grantMode: 'allow_once',
    grantApprovalId: APPROVAL_ID, grantDecisionNonce: NONCE,
    grantDecisionRevision: '12', rootBindingRevision: '5',
    approvedCapabilities: ['filesystem.project.list', 'filesystem.project.read'],
    requiredCapabilities: ['filesystem.project.read'],
    decidedByUserId: USER_ID, decidedAt: '2026-07-17T00:00:00.000Z', coverageFingerprint: SHA,
  }

  it('accepts only the two exact authorization arms and rejects mirror-like cross products', () => {
    expect(parsePacketAuthorizationSnapshot(packageAuthorization)).toEqual(packageAuthorization)
    expect(parsePacketAuthorizationSnapshot({
      ...packageAuthorization,
      source: 'project_always_allow', grantMode: 'always_allow',
    })).toBeNull()
    expect(parsePacketAuthorizationSnapshot({ ...packageAuthorization, extra: true })).toBeNull()
    expect(parsePacketAuthorizationSnapshot({
      ...packageAuthorization,
      approvedCapabilities: ['filesystem.project.read', 'filesystem.project.list'],
    })).toBeNull()
  })

  it('bounds assembly metadata and rejects arbitrary redaction keys', () => {
    expect(parsePacketRedactionSummary({ jwt: 1, database_urls: 2 })).toEqual({ jwt: 1, database_urls: 2 })
    expect(parsePacketRedactionSummary({ 'selected/path': 1 })).toBeNull()
    expect(parseTerminalPacketAssembly({
      state: 'assembled', rootRef: 'opaque_root_1', includedCount: 50,
      byteCount: 160 * 1024, omittedCount: 0, redactionSummary: { jwt: 1 },
    })).not.toBeNull()
    expect(parseTerminalPacketAssembly({
      state: 'assembly_unconfirmed', failureStage: 'assembly', assemblyAttemptId: RUN_ID,
      rootRef: '/repo/private',
    })).toBeNull()
  })

  it('enforces terminal assembly and delivery compatibility', () => {
    expect(packetTerminalTupleIsValid({
      assembly: { state: 'assembled', rootRef: 'opaque', includedCount: 1, byteCount: 10, omittedCount: 0, redactionSummary: {} },
      delivery: { state: 'submitted', submittedAt: '2026-07-17T00:00:00.000Z' },
      terminal: { status: 'succeeded' },
    })).toBe(true)
    expect(packetTerminalTupleIsValid({
      assembly: { state: 'assembly_unconfirmed', failureStage: 'assembly', assemblyAttemptId: RUN_ID },
      delivery: { state: 'submission_uncertain' },
      terminal: { status: 'failed', failureCode: 'submission_uncertain' },
    })).toBe(false)
  })

  it('treats malformed known recovery markers as an absolute candidate hold', () => {
    expect(packetCandidateGuard({})).toEqual({ blocked: false })
    expect(packetCandidateGuard({ packet_issuance: { schemaVersion: 2, secret: 'must-not-pass' } }))
      .toEqual({ blocked: true, kind: 'invalid_packet_marker' })
    expect(packetCandidateGuard({ packet_integrity_hold: {
      schemaVersion: 2, kind: 'packet_integrity_hold', priorAgentRunId: RUN_ID,
      priorRuntimeAuditId: AUDIT_ID, reason: 'audit_artifact_mismatch', autoRetryable: false,
      markerFingerprint: SHA,
    } })).toEqual({ blocked: true, kind: 'packet_integrity_hold' })
  })
})

describe('Epic 172 S4 generic local recovery evidence', () => {
  it('keeps the seven operator actions and stable suite identity closed', () => {
    expect([...LOCAL_EFFECT_RECOVERY_ACTIONS, ...PACKET_ISSUANCE_RECOVERY_ACTIONS]).toEqual([
      'review_local_changes', 'acknowledge_possible_local_invocation',
      'retry_local_execution', 'decline_local_retry',
      'acknowledge_possible_submission', 'retry_execution', 'decline_packet_recovery',
    ])
    expect(MCP_ADMISSION_OPERATOR_RECOVERY_SUITE_ID).toBe('mcp-admission.operator-recovery')
  })

  it('rejects free-form local recovery fields and blocks malformed known markers', () => {
    const marker = {
      schemaVersion: 1,
      kind: 'local_effect_recovery',
      source: 'local-run-evidence',
      priorAgentRunId: RUN_ID,
      localRunEvidenceId: AUDIT_ID,
      evidenceFingerprint: SHA,
      taskDisposition: 'operator_hold',
      autoRetryable: false,
      reason: 'local_execution_interrupted',
      disposition: 'retry_local_execution',
      reviewState: 'not_applicable',
    }
    expect(parseLocalEffectRecoveryMarker(marker)).toEqual(marker)
    expect(parseLocalEffectRecoveryMarker({ ...marker, path: '/private/repo' })).toBeNull()
    expect(localEffectCandidateGuard({ local_effect_recovery: { schemaVersion: 1 } }))
      .toEqual({ blocked: true, kind: 'invalid_local_effect_marker' })
  })

  it('requires exact repository-review fingerprints and actor/time pairs', () => {
    expect(parseRepositoryChangeReview({
      state: 'review_required', baselineFingerprint: SHA, changeResult: 'changed',
      changeFingerprint: SHA, reviewedAt: null, reviewedByUserId: null,
    })).not.toBeNull()
    expect(parseRepositoryChangeReview({
      state: 'reviewed', baselineFingerprint: SHA, changeResult: 'changed',
      changeFingerprint: SHA, reviewedAt: null, reviewedByUserId: USER_ID,
    })).toBeNull()
  })
})
