import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { computeCredentialDigest } from '@/lib/session-credential-digest'

const required = process.env.FORGE_S5_REQUIRE_POSTGRES_TEST === '1'
const destructive = process.env.FORGE_S5_POSTGRES_DESTRUCTIVE_TEST === '1'
const adminUrl = process.env.FORGE_S5_POSTGRES_ADMIN_TEST_URL?.trim()
const appUrl = process.env.FORGE_S5_POSTGRES_APP_TEST_URL?.trim()
const readerUrl = process.env.FORGE_S5_LOCAL_EVIDENCE_READER_DATABASE_URL?.trim()

function validatedTarget(): string | null {
  if (!adminUrl || !appUrl || !readerUrl) return null
  const targets = [adminUrl, appUrl, readerUrl].map((value) => new URL(value))
  if (targets.some((url) => !['postgres:', 'postgresql:'].includes(url.protocol))) return null
  const database = targets[0]!.pathname.slice(1)
  if (
    database === ''
    || !database.startsWith('forge_s5_')
    || targets.some((url) => (
      url.hostname !== targets[0]!.hostname
      || (url.port || '5432') !== (targets[0]!.port || '5432')
      || url.pathname !== targets[0]!.pathname
      || url.search !== ''
      || url.hash !== ''
    ))
    || decodeURIComponent(targets[1]!.username) !== 'forge_app_test'
    || decodeURIComponent(targets[2]!.username) !== 'forge_local_evidence_reader'
    || targets[2]!.password !== ''
  ) return null
  return database
}

const targetDatabase = validatedTarget()
if (required && (!destructive || !targetDatabase || !process.env.PGPASSWORD)) {
  throw new Error(
    'The mandatory S5 PostgreSQL route proof requires its explicit disposable database, fixed reader principal, destructive opt-in, and out-of-band reader password.',
  )
}

const run = targetDatabase && destructive ? describe : describe.skip
const SHA = `sha256:${'a'.repeat(64)}`
const FORBIDDEN_KEYS = new Set([
  'claimToken',
  'claim_token',
  'grantNonce',
  'grant_nonce',
  'effectiveGrant',
  'effective_grant',
])

function forbiddenPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenPaths(item, `${path}[${index}]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
    ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...forbiddenPaths(nested, `${path}.${key}`),
  ])
}

run('S5 real PostgreSQL HTTP authorization boundary', () => {
  const ids = {
    owner: randomUUID(),
    other: randomUUID(),
    ownerSession: randomUUID(),
    otherSession: randomUUID(),
    ownerProject: randomUUID(),
    otherProject: randomUUID(),
    ownerTask: randomUUID(),
    otherTask: randomUUID(),
    missingTask: randomUUID(),
    ownerPackage: randomUUID(),
    otherPackage: randomUUID(),
    ownerRun: randomUUID(),
    ownerEvidence: randomUUID(),
    ownerAudit: randomUUID(),
    ownerClaim: randomUUID(),
    ownerDecision: randomUUID(),
    ownerGrantNonce: randomUUID(),
    signerKey: randomUUID(),
    enablementReceipt: randomUUID(),
    readinessReceipt: randomUUID(),
    openingAuthorization: randomUUID(),
  }
  const ownerCredential = randomUUID()
  const otherCredential = randomUUID()
  const privateGrantSentinel = 'PRIVATE-EFFECTIVE-GRANT-SENTINEL'
  const priorEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    FORGE_LOCAL_RUN_EVIDENCE_READER_DATABASE_URL:
      process.env.FORGE_LOCAL_RUN_EVIDENCE_READER_DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
  }
  let admin: ReturnType<typeof postgres>
  let app: ReturnType<typeof postgres>

  beforeAll(async () => {
    process.env.DATABASE_URL = appUrl!
    process.env.FORGE_LOCAL_RUN_EVIDENCE_READER_DATABASE_URL = readerUrl!
    admin = postgres(adminUrl!, { max: 2, onnotice: () => {} })
    app = postgres(appUrl!, { max: 1, onnotice: () => {} })

    await admin.begin(async (tx) => {
      await tx`
        insert into users (id, display_name) values
          (${ids.owner}::uuid, 'S5 route owner'),
          (${ids.other}::uuid, 'S5 route other')
      `
      await tx`
        insert into projects (
          id, name, submitted_by, grant_decision_revision, root_binding_revision
        ) values
          (${ids.ownerProject}::uuid, 'S5 owner project', ${ids.owner}::uuid, 1, 1),
          (${ids.otherProject}::uuid, 'S5 other project', ${ids.other}::uuid, 1, 1)
      `
      await tx`
        insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values
          (${ids.ownerTask}::uuid, ${ids.ownerProject}::uuid, ${ids.owner}::uuid,
            'S5 owner task', 'authorized canonical prompt', 'approved'),
          (${ids.otherTask}::uuid, ${ids.otherProject}::uuid, ${ids.other}::uuid,
            'S5 other task', 'other canonical prompt', 'approved')
      `
      await tx`
        insert into sessions (
          id, user_id, credential_digest_v1, expires_at, credential_storage_version
        ) values
          (${ids.ownerSession}::uuid, ${ids.owner}::uuid,
            ${computeCredentialDigest(ownerCredential).digest}::bytea,
            clock_timestamp() + interval '1 hour', 2),
          (${ids.otherSession}::uuid, ${ids.other}::uuid,
            ${computeCredentialDigest(otherCredential).digest}::bytea,
            clock_timestamp() + interval '1 hour', 2)
      `
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status,
          required_capabilities, mcp_requirements
        ) values
          (${ids.ownerPackage}::uuid, ${ids.ownerTask}::uuid, 'backend',
            'Owner package', 'bounded owner package', 1, 'blocked',
            '{"filesystem.project.read":true}'::jsonb,
            '[{"name":"filesystem","capabilities":["filesystem.project.read"]}]'::jsonb),
          (${ids.otherPackage}::uuid, ${ids.otherTask}::uuid, 'backend',
            'Other package', 'bounded other package', 1, 'ready', '{}'::jsonb, '[]'::jsonb)
      `
      await tx`
        insert into agent_runs (
          id, task_id, work_package_id, agent_type, model_id_used, status
        ) values (
          ${ids.ownerRun}::uuid, ${ids.ownerTask}::uuid, ${ids.ownerPackage}::uuid,
          'backend', 's5-postgres-proof', 'completed'
        )
      `
      await tx`
        insert into filesystem_mcp_grant_approvals (
          id, project_id, task_id, work_package_id, decided_by, decision,
          capabilities, effective_grant, decision_scope, grant_decision_revision,
          root_binding_revision, grant_nonce, pointer_fingerprint
        ) values (
          ${ids.ownerDecision}::uuid, ${ids.ownerProject}::uuid, ${ids.ownerTask}::uuid,
          ${ids.ownerPackage}::uuid, ${ids.owner}::uuid, 'approved',
          '["filesystem.project.read"]'::jsonb,
          ${JSON.stringify({ hidden: privateGrantSentinel })}::text::jsonb,
          'package', 1, 1, ${ids.ownerGrantNonce}::uuid, ${SHA}
        )
      `
      await tx`
        update filesystem_mcp_current_decision_pointers
        set current_decision_id = ${ids.ownerDecision}::uuid,
            current_decision_task_id = ${ids.ownerTask}::uuid,
            current_decision_work_package_id = ${ids.ownerPackage}::uuid,
            current_decision_revision = 1,
            current_decision_fingerprint = ${SHA},
            pointer_fingerprint = ${SHA},
            pointer_version = 1
        where work_package_id = ${ids.ownerPackage}::uuid
      `
      await tx`
        insert into work_package_local_run_evidence (
          id, task_id, work_package_id, agent_run_id, claim_token,
          lease_expires_at, state, terminal, terminal_at
        ) values (
          ${ids.ownerEvidence}::uuid, ${ids.ownerTask}::uuid, ${ids.ownerPackage}::uuid,
          ${ids.ownerRun}::uuid, ${ids.ownerClaim}::uuid,
          clock_timestamp() + interval '1 hour', 'terminal',
          '{"status":"succeeded"}'::jsonb, clock_timestamp()
        )
      `
      await tx`
        insert into filesystem_mcp_runtime_audits (
          id, task_id, work_package_id, agent_run_id, operation, status,
          local_run_evidence_id, assembly, delivery, terminal, terminal_at,
          claim_token, grant_decision_nonce, authorization_snapshot
        ) values (
          ${ids.ownerAudit}::uuid, ${ids.ownerTask}::uuid, ${ids.ownerPackage}::uuid,
          ${ids.ownerRun}::uuid, 'context_packet', 'succeeded', ${ids.ownerEvidence}::uuid,
          ${JSON.stringify({
            state: 'assembled',
            rootRef: 'opaque-root',
            includedCount: 1,
            byteCount: 12,
            omittedCount: 0,
            redactionSummary: {},
          })}::text::jsonb,
          ${JSON.stringify({
            state: 'submitted',
            submittedAt: '2026-07-18T00:00:00.000Z',
          })}::text::jsonb,
          '{"status":"succeeded"}'::jsonb, '2026-07-18T00:00:00.000Z'::timestamptz,
          ${randomUUID()}::uuid, ${randomUUID()}::uuid,
          ${JSON.stringify({ hidden: privateGrantSentinel })}::text::jsonb
        )
      `
      await tx`
        insert into forge_release_signer_keys (
          id, generation, public_key_spki, github_app_id, ruleset_fingerprint,
          status, valid_from, valid_until
        ) values (
          ${ids.signerKey}::uuid, 1, decode('00', 'hex'), 's5-postgres-proof',
          ${'b'.repeat(64)}, 'staged', clock_timestamp() - interval '1 minute',
          clock_timestamp() + interval '1 hour'
        )
      `
      await tx`
        insert into forge_epic_172_release_evidence (
          id, evidence_kind, owner_issue, owner_slice, exact_builds,
          required_evidence, reviewed_sha, epoch, predecessor_receipt_ids,
          predecessor_set_digest, transition_identity_digest, signer_key_id,
          signer_generation, github_app_id, controller_run_id, controller_job_id,
          envelope_digest, detached_signature, nonce, issued_at, envelope
        ) values
        (
          ${ids.enablementReceipt}::uuid, 'ingress_and_issuance_enabled', 179, 's4',
          ${JSON.stringify([
            `issue_179_s4@${'a'.repeat(40)}`,
            `issue_180_s5@${'a'.repeat(40)}`,
            `issue_181_s6@${'a'.repeat(40)}`,
          ])}::text::jsonb,
          '[{"name":"postgres_fixture","measurementDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
          ${'a'.repeat(40)}, 2, '[]'::jsonb, ${'0'.repeat(64)}, ${'c'.repeat(64)},
          ${ids.signerKey}::uuid, 1, 's5-postgres-proof', 's5-postgres-proof',
          'enablement', ${'e'.repeat(64)}, decode(repeat('aa', 64), 'hex'),
          ${randomUUID()}::uuid, transaction_timestamp(), '{}'::jsonb
        ),
        (
          ${ids.readinessReceipt}::uuid, 's5_s6_release_ready', 181, 's6',
          ${JSON.stringify([
            `issue_179_s4@${'a'.repeat(40)}`,
            `issue_180_s5@${'a'.repeat(40)}`,
            `issue_181_s6@${'a'.repeat(40)}`,
          ])}::text::jsonb,
          '[{"name":"postgres_fixture","measurementDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
          ${'a'.repeat(40)}, 2, '[]'::jsonb, ${'1'.repeat(64)}, ${'d'.repeat(64)},
          ${ids.signerKey}::uuid, 1, 's5-postgres-proof', 's5-postgres-proof',
          'readiness', ${'f'.repeat(64)}, decode(repeat('bb', 64), 'hex'),
          ${randomUUID()}::uuid, transaction_timestamp(), '{}'::jsonb
        )
      `
      await tx`
        insert into forge_epic_172_transition_authorizations (
          id, target_node, transition_identity_digest, source_receipt_ids,
          source_receipt_set_digest, owner_issue, owner_slice, exact_builds,
          reviewed_sha, epoch, operation_id, operation, controller_login_id,
          controller_run_id, signer_key_id, signer_generation, envelope_digest,
          detached_signature, nonce, issued_at, expires_at, envelope
        ) values (
          ${ids.openingAuthorization}::uuid, 'ingress_and_issuance_enabled',
          ${'2'.repeat(64)},
          ${JSON.stringify([ids.enablementReceipt, ids.readinessReceipt])}::text::jsonb,
          ${'3'.repeat(64)}, 179, 's4',
          ${JSON.stringify([
            `issue_179_s4@${'a'.repeat(40)}`,
            `issue_180_s5@${'a'.repeat(40)}`,
            `issue_181_s6@${'a'.repeat(40)}`,
          ])}::text::jsonb,
          ${'a'.repeat(40)}, 2, 's5-postgres-proof', 'enable',
          's5-postgres-proof', 's5-postgres-proof', ${ids.signerKey}::uuid, 1,
          ${'4'.repeat(64)}, decode(repeat('cc', 64), 'hex'),
          ${randomUUID()}::uuid, transaction_timestamp() - interval '1 minute',
          transaction_timestamp() + interval '15 minutes', '{}'::jsonb
        )
      `
      await tx`
        update forge_epic_172_enablement_state
        set state = 'active', owner_operation_id = 's5-postgres-proof',
            exact_builds = ${JSON.stringify([
              `issue_179_s4@${'a'.repeat(40)}`,
              `issue_180_s5@${'a'.repeat(40)}`,
              `issue_181_s6@${'a'.repeat(40)}`,
            ])}::text::jsonb,
            reviewed_sha = ${'a'.repeat(40)}, epoch = 2,
            started_at = transaction_timestamp(), expires_at = null,
            enablement_receipt_id = ${ids.enablementReceipt}::uuid,
            final_readiness_receipt_id = ${ids.readinessReceipt}::uuid,
            opening_authorization_id = ${ids.openingAuthorization}::uuid,
            controller_login_id = 's5-postgres-proof',
            controller_run_id = 's5-postgres-proof',
            controller_token_digest = null, lease_generation = null,
            last_heartbeat_at = null, lease_expires_at = null,
            state_fingerprint = ${'9'.repeat(64)}, updated_at = clock_timestamp()
        where singleton_id = 'epic-172'
      `
    })
  })

  afterAll(async () => {
    try {
      const { closeDb } = await import('@/db')
      const { redis } = await import('@/lib/redis')
      await Promise.allSettled([
        redis.del(
          `session:v2:${computeCredentialDigest(ownerCredential).digest.toString('hex')}`,
          `session:v2:${computeCredentialDigest(otherCredential).digest.toString('hex')}`,
        ),
        closeDb(),
      ])
      redis.disconnect(false)
    } finally {
      await Promise.allSettled([
        admin?.end({ timeout: 5 }),
        app?.end({ timeout: 5 }),
      ])
      for (const [key, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('keeps every S5 HTTP surface owner-bound and recursively strips authority fields', async () => {
    const { NextRequest } = await import('next/server')
    const routes = [
      ['admission', () => import('@/app/api/mcps/admission/[taskId]/route')],
      ['freshness', () => import('@/app/api/mcps/freshness/[taskId]/route')],
      ['grant-state', () => import('@/app/api/mcps/grant-state/[taskId]/route')],
      ['local-evidence', () => import('@/app/api/mcps/local-evidence/[taskId]/route')],
      ['presentation', () => import('@/app/api/mcps/presentation/[taskId]/route')],
      ['recovery-state', () => import('@/app/api/mcps/recovery-state/[taskId]/route')],
      ['terminal-state', () => import('@/app/api/mcps/terminal-state/[taskId]/route')],
    ] as const
    const request = (credential: string, path: string) => new NextRequest(`http://forge.test${path}`, {
      headers: { cookie: `forge_session=${credential}` },
    })

    for (const [name, loadRoute] of routes) {
      const { GET } = await loadRoute()
      const path = `/api/mcps/${name}/${ids.ownerTask}`
      const owned = await GET(request(ownerCredential, path), {
        params: Promise.resolve({ taskId: ids.ownerTask }),
      })
      expect(owned.status, `${name} owner status`).toBe(200)
      const ownedBody = await owned.json()
      expect(forbiddenPaths(ownedBody), `${name} forbidden fields`).toEqual([])
      const serialized = JSON.stringify(ownedBody)
      expect(serialized).not.toContain(ids.ownerClaim)
      expect(serialized).not.toContain(ids.ownerGrantNonce)
      expect(serialized).not.toContain(privateGrantSentinel)

      const nonOwner = await GET(request(otherCredential, path), {
        params: Promise.resolve({ taskId: ids.ownerTask }),
      })
      const missing = await GET(request(ownerCredential, `/api/mcps/${name}/${ids.missingTask}`), {
        params: Promise.resolve({ taskId: ids.missingTask }),
      })
      expect(nonOwner.status, `${name} non-owner status`).toBe(404)
      expect(missing.status, `${name} missing status`).toBe(404)
      expect(await nonOwner.json(), `${name} cross-user indistinguishability`).toEqual(await missing.json())
    }

    const { POST } = await import('@/app/api/mcps/actions/[taskId]/route')
    const actionBody = {
      schemaVersion: 1,
      action: 'retry_local_execution',
      expectedFreshnessFingerprint: `sha256:${'0'.repeat(64)}`,
      localRunEvidenceId: ids.ownerEvidence,
      evidenceFingerprint: SHA,
    }
    const actionRequest = (credential: string, taskId: string) => new NextRequest(
      `http://forge.test/api/mcps/actions/${taskId}`,
      {
        method: 'POST',
        headers: {
          cookie: `forge_session=${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(actionBody),
      },
    )
    const ownedAction = await POST(actionRequest(ownerCredential, ids.ownerTask), {
      params: Promise.resolve({ taskId: ids.ownerTask }),
    })
    const ownedActionBody = await ownedAction.json()
    const ownedActionCategory = [
      typeof ownedActionBody.code === 'string' ? ownedActionBody.code : 'missing_code',
      typeof ownedActionBody.reason === 'string' ? ownedActionBody.reason : 'missing_reason',
    ].join(':')
    expect(ownedAction.status, `owner action category ${ownedActionCategory}`).toBe(409)
    expect(ownedActionBody).toMatchObject({ code: 'stale_state' })

    const nonOwnerAction = await POST(actionRequest(otherCredential, ids.ownerTask), {
      params: Promise.resolve({ taskId: ids.ownerTask }),
    })
    const missingAction = await POST(actionRequest(ownerCredential, ids.missingTask), {
      params: Promise.resolve({ taskId: ids.missingTask }),
    })
    expect(nonOwnerAction.status).toBe(404)
    expect(missingAction.status).toBe(404)
    expect(await nonOwnerAction.json()).toEqual(await missingAction.json())

    const localEvidence = await (await routes[3][1]()).GET(
      request(ownerCredential, `/api/mcps/local-evidence/${ids.ownerTask}`),
      { params: Promise.resolve({ taskId: ids.ownerTask }) },
    )
    expect(await localEvidence.json()).toMatchObject({
      localEvidenceAvailable: true,
      evidenceRecords: [{ id: ids.ownerEvidence }],
    })
    const terminalState = await (await routes[6][1]()).GET(
      request(ownerCredential, `/api/mcps/terminal-state/${ids.ownerTask}`),
      { params: Promise.resolve({ taskId: ids.ownerTask }) },
    )
    expect(await terminalState.json()).toMatchObject({
      terminalPackages: [{
        runtimeAuditId: ids.ownerAudit,
        workPackageId: ids.ownerPackage,
        state: 'terminal',
        deliveryOutcome: 'submitted',
        terminalOutcome: 'succeeded',
      }],
    })

    console.log('S5_POSTGRES_HTTP_AUTHORIZATION_OK')
  })

  it('keeps one real PostgreSQL observation across a committed ordinary and protected transition', async () => {
    const { readS5AuthoritativeTaskState } = await import('@/lib/mcps/s5-server-reader')
    let transitionCommitted = false
    const before = await readS5AuthoritativeTaskState(ids.ownerTask, ids.owner, async () => {
      await admin.begin(async (tx) => {
        await tx`
          update tasks set status = 'failed', updated_at = clock_timestamp()
          where id = ${ids.ownerTask}::uuid
        `
        await tx`
          update work_packages set status = 'failed', updated_at = clock_timestamp()
          where id = ${ids.ownerPackage}::uuid
        `
        await tx`
          update work_package_local_run_evidence
          set terminal = '{"status":"failed"}'::jsonb, terminal_at = clock_timestamp()
          where id = ${ids.ownerEvidence}::uuid
        `
        await tx`
          update filesystem_mcp_runtime_audits
          set status = 'failed', terminal = '{"status":"failed","failureCode":"preflight_failed"}'::jsonb,
              terminal_at = clock_timestamp()
          where id = ${ids.ownerAudit}::uuid
        `
      })
      transitionCommitted = true
    })
    expect(transitionCommitted).toBe(true)
    // The exporter and the least-privilege reader both retain the old state;
    // current terminal authority remains the blocked package, not its old audit.
    expect(before.taskStatus).toBe('approved')
    expect(before.packages).toMatchObject([{ workPackageId: ids.ownerPackage, status: 'blocked' }])
    expect(before.terminalPackages).toEqual([])

    const after = await readS5AuthoritativeTaskState(ids.ownerTask, ids.owner)
    expect(after.taskStatus).toBe('failed')
    expect(after.packages).toMatchObject([{ workPackageId: ids.ownerPackage, status: 'failed' }])
    expect(after.terminalPackages).toMatchObject([{
      runtimeAuditId: ids.ownerAudit, workPackageId: ids.ownerPackage,
      state: 'terminal', terminalOutcome: 'failed',
    }])
    expect(before.freshnessFingerprint).not.toBe(after.freshnessFingerprint)
  })
})
