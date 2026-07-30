import { createHash, randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  bindArchitectReplanContext,
  executableReferenceForEntry,
  recordArchitectPlanVersion,
  resolveArchitectReplanEntry,
  resolveArchitectPlanEntry,
} from '@/lib/mcps/s4-protocol-store'
import { ARCHITECT_PLAN_HEADER, architectReplanReferenceForEntry } from '@/lib/mcps/architect-plan-entries'
import { computeCredentialDigest } from '@/lib/session-credential-digest'
import {
  appendArchitectClarificationAnswer,
  appendArchitectClarificationAnswers,
  readArchitectPlanHistory,
} from '@/lib/mcps/history-reader'
import { hashPassword } from '@/lib/password'
import { closeDb } from '@/db'
import {
  LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX,
  legacyLeakageRowFingerprint,
  runLegacyLeakageScrub,
  sanitizeLegacyLeakageRow,
  type LegacyLeakageScrubCheckpoint,
  type LegacyLeakageScrubRedis,
  type LegacyLeakageScrubRow,
  type RedisScanEvidence,
} from '@/lib/mcps/legacy-leakage-scrub'
import { createLegacyLeakagePostgresAdapter } from '@/scripts/scrub-legacy-leakage'

const {
  mockRedisDel,
  mockRedisEval,
  mockRedisExpire,
  mockRedisIncr,
  mockRedisSet,
} = vi.hoisted(() => ({
  mockRedisDel: vi.fn(),
  mockRedisEval: vi.fn(),
  mockRedisExpire: vi.fn(),
  mockRedisIncr: vi.fn(),
  mockRedisSet: vi.fn(),
}))

vi.mock('@/lib/redis', () => ({
  redis: {
    del: mockRedisDel,
    eval: mockRedisEval,
    expire: mockRedisExpire,
    incr: mockRedisIncr,
    set: mockRedisSet,
  },
}))

const adminUrl = process.env.FORGE_S4_POSTGRES_TEST_DATABASE_URL?.trim()
const issuerUrl = process.env.FORGE_PACKET_ISSUER_DATABASE_URL?.trim()
const writerUrl = process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL?.trim()
const resolverUrl = process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL?.trim()
const historyReaderUrl = process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL?.trim()
const appUrl = process.env.FORGE_EPIC_172_TEST_APP_DATABASE_URL?.trim()
const enabled = Boolean(adminUrl && issuerUrl && writerUrl && resolverUrl && historyReaderUrl && appUrl)
const requirePostgresFixture = process.env.FORGE_S4_REQUIRE_POSTGRES_TEST === '1'
const SHA = `sha256:${'a'.repeat(64)}`

if (requirePostgresFixture && !enabled) {
  throw new Error(
    'FORGE_S4_REQUIRE_POSTGRES_TEST=1 requires the S4 administrator, ordinary app, packet issuer, Architect plan writer, Architect plan resolver, and Architect history reader PostgreSQL URLs; the explicit contract suite may not skip.',
  )
}

describe.skipIf(!enabled)('Epic 172 S4 PostgreSQL boundaries', () => {
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    task: randomUUID(),
    package: randomUUID(),
    architectRun: randomUUID(),
    replanRun: randomUUID(),
    firstRun: randomUUID(),
    secondRun: randomUUID(),
    firstClaimRun: randomUUID(),
    secondClaimRun: randomUUID(),
    firstEvidence: randomUUID(),
    secondEvidence: randomUUID(),
    firstLocalClaim: randomUUID(),
    secondLocalClaim: randomUUID(),
    decision: randomUUID(),
    nonce: randomUUID(),
    signerKey: randomUUID(),
    enablementReceipt: randomUUID(),
    readinessReceipt: randomUUID(),
    legacyArchitectRun: randomUUID(),
    clarificationQuestion: randomUUID(),
    clarificationAnswer: randomUUID(),
    secondArchitectRun: randomUUID(),
    thirdArchitectRun: randomUUID(),
    secondClarificationQuestion: randomUUID(),
    secondClarificationAnswer: randomUUID(),
  }
  const key = randomBytes(32)
  const sessionCredential = randomUUID()
  let admin: ReturnType<typeof postgres>
  let app: ReturnType<typeof postgres>
  let issuer: ReturnType<typeof postgres>
  const previousDatabaseUrl = process.env.DATABASE_URL

  beforeAll(async () => {
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = writerUrl!
    process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL = resolverUrl!
    process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = historyReaderUrl!
    process.env.DATABASE_URL = appUrl!
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    app = postgres(appUrl!, { max: 1, onnotice: () => {} })
    issuer = postgres(issuerUrl!, { max: 2, onnotice: () => {} })

    await admin.begin(async (tx) => {
      await tx`insert into users (id, display_name) values (${ids.user}::uuid, 'S4 PostgreSQL test')`
      await tx`
        insert into projects (
          id, name, submitted_by, grant_decision_revision, root_binding_revision
        ) values (${ids.project}::uuid, 'S4 PostgreSQL test', ${ids.user}::uuid, 1, 1)
      `
      await tx`
        insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, 'S4 test', 'protected', 'running')
      `
      await tx`
        insert into sessions (
          id, user_id, credential_digest_v1, expires_at, credential_storage_version
        )
        values (
          ${randomUUID()}::uuid, ${ids.user}::uuid,
          ${computeCredentialDigest(sessionCredential).digest}::bytea,
          clock_timestamp() + interval '7 days', 2
        )
      `
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (
          ${ids.package}::uuid, ${ids.task}::uuid, 'backend', 'S4 test package', 'bounded', 1, 'ready'
        )
      `
      await tx`
        insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
        values
          (${ids.architectRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'completed'),
          (${ids.replanRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'running'),
          (${ids.firstRun}::uuid, ${ids.task}::uuid, ${ids.package}::uuid, 'backend', 'test', 'running'),
          (${ids.secondRun}::uuid, ${ids.task}::uuid, ${ids.package}::uuid, 'backend', 'test', 'running')
          ,(${ids.secondArchitectRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'completed')
          ,(${ids.thirdArchitectRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'completed')
      `
      await tx`
        insert into filesystem_mcp_grant_approvals (
          id, project_id, task_id, work_package_id, decided_by, decision,
          capabilities, effective_grant, decision_scope, grant_decision_revision,
          root_binding_revision, grant_nonce, pointer_fingerprint
        ) values (
          ${ids.decision}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${ids.package}::uuid,
          ${ids.user}::uuid, 'approved',
          '["filesystem.project.read"]'::jsonb, '{}'::jsonb, 'package', 1, 1,
          ${ids.nonce}::uuid, ${SHA}
        )
      `
      await tx`
        update filesystem_mcp_current_decision_pointers
        set current_decision_id = ${ids.decision}::uuid,
            current_decision_task_id = ${ids.task}::uuid,
            current_decision_work_package_id = ${ids.package}::uuid,
            current_decision_revision = 1,
            current_decision_fingerprint = ${SHA},
            pointer_fingerprint = ${SHA},
            pointer_version = 1
        where work_package_id = ${ids.package}::uuid
      `
      await tx`
        insert into forge_release_signer_keys (
          id, generation, public_key_spki, github_app_id, ruleset_fingerprint,
          status, valid_from, valid_until
        ) values (
          ${ids.signerKey}::uuid, 1, decode('00', 'hex'), 's4-postgres-test',
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
          ${ids.signerKey}::uuid, 1, 's4-postgres-test', 's4-postgres-test', 'enablement',
          ${'e'.repeat(64)}, decode(repeat('aa', 64), 'hex'), ${randomUUID()}::uuid,
          transaction_timestamp(), '{}'::jsonb
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
          ${ids.signerKey}::uuid, 1, 's4-postgres-test', 's4-postgres-test', 'readiness',
          ${'f'.repeat(64)}, decode(repeat('bb', 64), 'hex'), ${randomUUID()}::uuid,
          transaction_timestamp(), '{}'::jsonb
        )
      `
      await tx`
        update forge_epic_172_enablement_state
        set state = 'active', owner_operation_id = 's4-postgres-test',
            exact_builds = ${JSON.stringify([
              `issue_179_s4@${'a'.repeat(40)}`,
              `issue_180_s5@${'a'.repeat(40)}`,
              `issue_181_s6@${'a'.repeat(40)}`,
            ])}::text::jsonb,
            reviewed_sha = ${'a'.repeat(40)}, epoch = 2,
            enablement_receipt_id = ${ids.enablementReceipt}::uuid,
            final_readiness_receipt_id = ${ids.readinessReceipt}::uuid,
            state_fingerprint = ${'9'.repeat(64)}, updated_at = clock_timestamp()
        where singleton_id = 'epic-172'
      `
    })
  })

  afterAll(async () => {
    if (admin) {
      await admin`
        update forge_epic_172_enablement_state
        set state = 'disabled', owner_operation_id = null, exact_builds = null,
            reviewed_sha = null, epoch = null, started_at = null, expires_at = null,
            enablement_receipt_id = null, final_readiness_receipt_id = null,
            opening_authorization_id = null, controller_login_id = null,
            controller_run_id = null, controller_token_digest = null,
            lease_generation = null, last_heartbeat_at = null, lease_expires_at = null,
            state_fingerprint = 'b0789177e07f4a9307f3397a938999b6fcc8c835a97e03d2770f83e4978c2585',
            updated_at = clock_timestamp()
        where singleton_id = 'epic-172'
      `
    }
    await closeDb()
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
    await Promise.all([admin?.end({ timeout: 5 }), app?.end({ timeout: 5 }), issuer?.end({ timeout: 5 })])
  })

  it('permits only legacy adr_text planning while Step 0 is disabled', async () => {
    await admin`
      update forge_epic_172_enablement_state
      set state = 'disabled', owner_operation_id = null, exact_builds = null,
          reviewed_sha = null, epoch = null, started_at = null, expires_at = null,
          enablement_receipt_id = null, final_readiness_receipt_id = null,
          opening_authorization_id = null, controller_login_id = null,
          controller_run_id = null, controller_token_digest = null,
          lease_generation = null, last_heartbeat_at = null, lease_expires_at = null,
          state_fingerprint = 'b0789177e07f4a9307f3397a938999b6fcc8c835a97e03d2770f83e4978c2585'
      where singleton_id = 'epic-172'
    `
    try {
      await admin`
        insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
        values (${ids.legacyArchitectRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'completed')
      `
      await expect(app`
        insert into artifacts (agent_run_id, artifact_type, content, metadata)
        values (
          ${ids.legacyArchitectRun}::uuid, 'adr_text', 'Legacy Architect plan body',
          '{"storageMode":"legacy"}'::jsonb
        )
      `).resolves.toBeDefined()
      await expect(recordArchitectPlanVersion({
        agentRunId: ids.architectRun,
        digestKey: key,
        digestKeyId: 's4-test-key',
        planVersion: '1',
        taskId: ids.task,
        entries: [{
          agent: null, bindingFingerprint: null, content: 'Must remain blocked',
          entryId: 'plan_body:000000', entryKind: 'plan_body',
          projectionEligible: false, requirementKey: null,
        }],
      })).rejects.toMatchObject({ code: 'invalid_evidence' })
    } finally {
      await admin`
        update forge_epic_172_enablement_state
        set state = 'active', owner_operation_id = 's4-postgres-test',
            exact_builds = ${JSON.stringify([
              `issue_179_s4@${'a'.repeat(40)}`,
              `issue_180_s5@${'a'.repeat(40)}`,
              `issue_181_s6@${'a'.repeat(40)}`,
            ])}::text::jsonb,
            reviewed_sha = ${'a'.repeat(40)}, epoch = 2,
            enablement_receipt_id = ${ids.enablementReceipt}::uuid,
            final_readiness_receipt_id = ${ids.readinessReceipt}::uuid,
            state_fingerprint = ${'9'.repeat(64)}
        where singleton_id = 'epic-172'
      `
    }
    await expect(app`
      insert into artifacts (agent_run_id, artifact_type, content, metadata)
      values (
        ${ids.legacyArchitectRun}::uuid, 'adr_text', 'Unprotected active Architect plan body',
        '{"storageMode":"legacy"}'::jsonb
      )
    `).rejects.toMatchObject({ code: '42501' })
  })

  it('protects task-bound Architect source and burns each execution reference once', async () => {
    const recorded = await recordArchitectPlanVersion({
      agentRunId: ids.architectRun,
      digestKey: key,
      digestKeyId: 's4-test-key',
      planVersion: '1',
      taskId: ids.task,
      entries: [{
        agent: null,
        bindingFingerprint: null,
        content: 'Prior protected Architect plan body.',
        entryId: 'plan_body:000000',
        entryKind: 'plan_body',
        projectionEligible: false,
        requirementKey: null,
      }, {
        agent: null,
        bindingFingerprint: null,
        content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }),
        entryId: 'requirement:plan-policy',
        entryKind: 'requirement',
        projectionEligible: false,
        requirementKey: 'plan-policy',
      }, {
        agent: 'backend',
        bindingFingerprint: SHA,
        content: JSON.stringify({
          capabilityBindings: [{
            capability: 'filesystem.project.read',
            requirementKey: 'filesystem-context',
          }],
          schemaVersion: 1,
        }),
        entryId: 'subtask:000001:backend',
        entryKind: 'subtask',
        projectionEligible: true,
        requirementKey: 'filesystem-context',
      }, {
        agent: 'backend',
        bindingFingerprint: SHA,
        content: JSON.stringify({
          agent: 'backend', requirementKey: 'filesystem-context', schemaVersion: 1,
        }),
        entryId: 'routing:filesystem-context:backend',
        entryKind: 'routing',
        projectionEligible: false,
        requirementKey: 'filesystem-context',
      }, {
        agent: null,
        bindingFingerprint: null,
        content: JSON.stringify({
          schemaVersion: 1,
          questionId: ids.clarificationQuestion,
          question: 'Which branch?',
          suggestions: ['main'],
        }),
        entryId: `clarification_question:${ids.clarificationQuestion}`,
        entryKind: 'clarification_question',
        projectionEligible: false,
        requirementKey: null,
      }],
    })
    await admin`
      insert into task_questions (
        id, task_id, question_entry_id, source_plan_artifact_id,
        source_plan_version, status
      ) values (
        ${ids.clarificationQuestion}::uuid, ${ids.task}::uuid,
        ${`clarification_question:${ids.clarificationQuestion}`},
        ${recorded.artifactId}::uuid, 1, 'open'
      )
    `
    await expect(appendArchitectClarificationAnswer({
      answer: 'main',
      answerId: ids.clarificationAnswer,
      digestKey: key,
      digestKeyId: 's4-test-key',
      questionId: ids.clarificationQuestion,
      sessionCredential,
      sourcePlanArtifactId: recorded.artifactId,
      sourcePlanVersion: '1',
      taskId: ids.task,
    })).resolves.toEqual({ answerId: ids.clarificationAnswer, allAnswered: true })
    await expect(admin`
      insert into architect_plan_execution_references (
        purpose, task_id, work_package_id, agent_run_id, plan_artifact_id,
        plan_version, entry_id, source_kind, architect_plan_entry_id,
        clarification_answer_id, agent, content_digest, digest_key_id
      ) values (
        'architect_replan', ${ids.task}::uuid, null, ${ids.replanRun}::uuid,
        ${recorded.artifactId}::uuid, 1, 'plan_body:000000',
        'architect_plan_entry', null, null, 'architect',
        ${`hmac-sha256:${'a'.repeat(64)}`}, 's4-test-key'
      )
    `).rejects.toMatchObject({ code: '23514', constraint_name: 'architect_plan_execution_references_source_kind_chk' })
    await expect(admin`
      insert into architect_plan_execution_references (
        purpose, task_id, work_package_id, agent_run_id, plan_artifact_id,
        plan_version, entry_id, source_kind, architect_plan_entry_id,
        clarification_answer_id, agent, content_digest, digest_key_id
      ) values (
        'architect_replan', ${ids.task}::uuid, null, ${ids.replanRun}::uuid,
        ${recorded.artifactId}::uuid, 1, 'plan_body:missing',
        'architect_plan_entry', 'plan_body:missing', null, 'architect',
        ${`hmac-sha256:${'a'.repeat(64)}`}, 's4-test-key'
      )
    `).rejects.toMatchObject({ code: '23503' })
    await expect(admin`
      insert into architect_plan_execution_references (
        purpose, task_id, work_package_id, agent_run_id, plan_artifact_id,
        plan_version, entry_id, source_kind, architect_plan_entry_id,
        clarification_answer_id, agent, content_digest, digest_key_id
      ) values (
        'architect_replan', ${ids.task}::uuid, null, ${ids.replanRun}::uuid,
        ${randomUUID()}::uuid, 1,
        ${`clarification_answer:${ids.clarificationAnswer}`},
        'clarification_answer', null, ${ids.clarificationAnswer}::uuid,
        'architect', ${`hmac-sha256:${'a'.repeat(64)}`}, 's4-test-key'
      )
    `).rejects.toMatchObject({ code: '23503' })
    const [artifact] = await admin<{ content: string; metadata: Record<string, unknown> }[]>`
      select content, metadata from artifacts where id = ${recorded.artifactId}::uuid
    `
    expect(artifact).toEqual({
      content: 'Architect plan available in protected history',
      metadata: { schemaVersion: 1, stage: 'architect_plan', historyAvailable: true },
    })
    const firstHistory = await readArchitectPlanHistory({
      planVersion: '1', sessionCredential, taskId: ids.task,
    })
    expect(firstHistory).toEqual(expect.arrayContaining([expect.objectContaining({
      entryId: 'subtask:000001:backend',
      content: expect.stringContaining('filesystem.project.read'),
    })]))
    expect(firstHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: `clarification_question:${ids.clarificationQuestion}` }),
      expect.objectContaining({ entryId: `clarification_answer:${ids.clarificationAnswer}` }),
    ]))
    const [historyAudit] = await admin<{ reads: number; returnedEntryCount: number; entrySetDigest: string }[]>`
      select count(*)::integer as reads,
        max(returned_entry_count)::integer as "returnedEntryCount",
        max(entry_set_digest) as "entrySetDigest"
      from architect_plan_history_reads
      where task_id = ${ids.task}::uuid and user_id = ${ids.user}::uuid
    `
    expect(historyAudit.reads).toBe(1)
    expect(historyAudit.returnedEntryCount).toBe(firstHistory.length)
    expect(historyAudit.entrySetDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const canonicalQuestion = (questionId: string) => ({
      schemaVersion: 1,
      questionId,
      question: 'Which branch?',
      suggestions: ['main'],
    })
    const malformedQuestions: Array<{
      name: string
      payload: (questionId: string) => Record<string, unknown>
    }> = [
      { name: 'missing schemaVersion', payload: (questionId) => ({ questionId, question: 'Which branch?', suggestions: ['main'] }) },
      { name: 'missing questionId', payload: () => ({ schemaVersion: 1, question: 'Which branch?', suggestions: ['main'] }) },
      { name: 'missing question', payload: (questionId) => ({ schemaVersion: 1, questionId, suggestions: ['main'] }) },
      { name: 'missing suggestions', payload: (questionId) => ({ schemaVersion: 1, questionId, question: 'Which branch?' }) },
      { name: 'string schemaVersion', payload: (questionId) => ({ ...canonicalQuestion(questionId), schemaVersion: '1' }) },
      { name: 'wrong numeric schemaVersion', payload: (questionId) => ({ ...canonicalQuestion(questionId), schemaVersion: 2 }) },
      { name: 'non-string questionId', payload: (questionId) => ({ ...canonicalQuestion(questionId), questionId: 7 }) },
      { name: 'mismatched questionId', payload: (questionId) => ({ ...canonicalQuestion(questionId), questionId: randomUUID() }) },
      { name: 'non-string question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: 7 }) },
      { name: 'empty question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: '' }) },
      { name: 'untrimmed question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: ' Which branch? ' }) },
      { name: 'tab-only question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: '\t' }) },
      { name: 'newline-only question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: '\n' }) },
      { name: 'tab-padded question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: '\tWhich branch?\t' }) },
      { name: 'CRLF-padded question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: '\r\nWhich branch?\r\n' }) },
      { name: 'NBSP-padded question', payload: (questionId) => ({ ...canonicalQuestion(questionId), question: '\u00a0Which branch?\u00a0' }) },
      { name: 'non-array suggestions', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: 'main' }) },
      { name: 'non-string suggestion', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: [7] }) },
      { name: 'empty suggestion', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: [''] }) },
      { name: 'untrimmed suggestion', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: [' main '] }) },
      { name: 'tab-padded suggestion', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: ['\tmain\t'] }) },
      { name: 'newline-padded suggestion', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: ['\nmain\n'] }) },
      { name: 'BOM-padded suggestion', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: ['\uFEFFmain\uFEFF'] }) },
      { name: 'duplicate suggestions', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: ['main', 'main'] }) },
      { name: 'too many suggestions', payload: (questionId) => ({ ...canonicalQuestion(questionId), suggestions: ['one', 'two', 'three', 'four', 'five'] }) },
      { name: 'extra key', payload: (questionId) => ({ ...canonicalQuestion(questionId), extra: true }) },
    ]
    for (const { name, payload } of malformedQuestions) {
      const taskId = randomUUID(); const runId = randomUUID(); const questionId = randomUUID()
      await admin`insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (${taskId}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, ${`Malformed: ${name}`}, 'protected', 'running')`
      await admin`insert into agent_runs (id, task_id, agent_type, model_id_used, status)
        values (${runId}::uuid, ${taskId}::uuid, 'architect', 'test', 'completed')`
      const source = await recordArchitectPlanVersion({ agentRunId: runId, digestKey: key, digestKeyId: 's4-test-key', planVersion: '1', taskId,
        entries: [{ agent: null, bindingFingerprint: null, content: 'body', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null },
          { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' },
          { agent: null, bindingFingerprint: null, content: JSON.stringify(payload(questionId)), entryId: `clarification_question:${questionId}`, entryKind: 'clarification_question', projectionEligible: false, requirementKey: null }] })
      await admin`insert into task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status)
        values (${questionId}::uuid, ${taskId}::uuid, ${`clarification_question:${questionId}`}, ${source.artifactId}::uuid, 1, 'open')`
      await expect(readArchitectPlanHistory({ planVersion: '1', sessionCredential, taskId })).rejects.toMatchObject({ code: 'invalid_evidence' })
      const [audit] = await admin<{ count: number }[]>`select count(*)::integer as count from architect_plan_history_reads where task_id = ${taskId}::uuid`
      expect(audit.count).toBe(0)
    }

    // The open-only projection arm must not hide malformed question content once
    // the authoritative append routine has advanced the opaque row to answered.
    for (const { name, suggestions } of [
      { name: 'non-string suggestion', suggestions: [7] },
      { name: 'tab-padded suggestion', suggestions: ['\tmain\t'] },
      { name: 'newline-padded suggestion', suggestions: ['\nmain\n'] },
    ]) {
      const answeredMalformedTask = randomUUID()
      const answeredMalformedRun = randomUUID()
      const answeredMalformedQuestion = randomUUID()
      const answeredMalformedAnswer = randomUUID()
      await admin`insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (${answeredMalformedTask}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, ${`Answered malformed: ${name}`}, 'protected', 'running')`
      await admin`insert into agent_runs (id, task_id, agent_type, model_id_used, status)
        values (${answeredMalformedRun}::uuid, ${answeredMalformedTask}::uuid, 'architect', 'test', 'completed')`
      const answeredMalformedSource = await recordArchitectPlanVersion({
        agentRunId: answeredMalformedRun,
        digestKey: key,
        digestKeyId: 's4-test-key',
        planVersion: '1',
        taskId: answeredMalformedTask,
        entries: [{ agent: null, bindingFingerprint: null, content: 'body', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null },
          { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' },
          { agent: null, bindingFingerprint: null, content: JSON.stringify({ ...canonicalQuestion(answeredMalformedQuestion), suggestions }), entryId: `clarification_question:${answeredMalformedQuestion}`, entryKind: 'clarification_question', projectionEligible: false, requirementKey: null }],
      })
      await admin`insert into task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status)
        values (${answeredMalformedQuestion}::uuid, ${answeredMalformedTask}::uuid,
          ${`clarification_question:${answeredMalformedQuestion}`}, ${answeredMalformedSource.artifactId}::uuid, 1, 'open')`
      await appendArchitectClarificationAnswer({
        answer: 'main',
        answerId: answeredMalformedAnswer,
        digestKey: key,
        digestKeyId: 's4-test-key',
        questionId: answeredMalformedQuestion,
        sessionCredential,
        sourcePlanArtifactId: answeredMalformedSource.artifactId,
        sourcePlanVersion: '1',
        taskId: answeredMalformedTask,
      })
      const [answeredMalformedProjection] = await admin<{
        answerReferenceId: string | null
        status: string
      }[]>`select status, answer_reference_id::text as "answerReferenceId"
        from task_questions where task_id = ${answeredMalformedTask}::uuid and id = ${answeredMalformedQuestion}::uuid`
      const [answeredMalformedLedger] = await admin<{ count: number }[]>`
        select count(*)::integer as count from architect_clarification_answers
        where task_id = ${answeredMalformedTask}::uuid and id = ${answeredMalformedAnswer}::uuid
      `
      expect(answeredMalformedProjection).toEqual({ answerReferenceId: answeredMalformedAnswer, status: 'answered' })
      expect(answeredMalformedLedger.count).toBe(1)
      await expect(readArchitectPlanHistory({
        planVersion: '1', sessionCredential, taskId: answeredMalformedTask,
      })).rejects.toMatchObject({ code: 'invalid_evidence' })
      const [answeredMalformedAudit] = await admin<{ count: number }[]>`
        select count(*)::integer as count from architect_plan_history_reads
        where task_id = ${answeredMalformedTask}::uuid
      `
      expect(answeredMalformedAudit.count).toBe(0)
    }

    const runStatefulHistoryProof = async () => {
    const second = await recordArchitectPlanVersion({
      agentRunId: ids.secondArchitectRun, digestKey: key, digestKeyId: 's4-test-key',
      planVersion: '2', taskId: ids.task,
      entries: [{ agent: null, bindingFingerprint: null, content: 'Second protected plan.',
        entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null }, {
        agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }),
        entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' }, {
        agent: null, bindingFingerprint: null, entryId: `clarification_question:${ids.secondClarificationQuestion}`,
        entryKind: 'clarification_question', projectionEligible: false, requirementKey: null,
        content: JSON.stringify({ schemaVersion: 1, questionId: ids.secondClarificationQuestion,
          question: 'Which environment?', suggestions: ['staging'] }) }],
    })
    const duplicateTask = randomUUID(); const duplicateRun1 = randomUUID(); const duplicateRun2 = randomUUID(); const duplicateQuestion = randomUUID()
    await admin`insert into tasks (id, project_id, submitted_by, title, prompt, status) values (${duplicateTask}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, 'Duplicate', 'protected', 'running')`
    await admin`insert into agent_runs (id, task_id, agent_type, model_id_used, status) values
      (${duplicateRun1}::uuid, ${duplicateTask}::uuid, 'architect', 'test', 'completed'), (${duplicateRun2}::uuid, ${duplicateTask}::uuid, 'architect', 'test', 'completed')`
    const duplicateV1 = await recordArchitectPlanVersion({ agentRunId: duplicateRun1, digestKey: key, digestKeyId: 's4-test-key', planVersion: '1', taskId: duplicateTask, entries: [
      { agent: null, bindingFingerprint: null, content: 'body', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null },
      { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' },
      { agent: null, bindingFingerprint: null, content: JSON.stringify({ schemaVersion: 1, questionId: duplicateQuestion, question: 'Q?', suggestions: [] }), entryId: `clarification_question:${duplicateQuestion}`, entryKind: 'clarification_question', projectionEligible: false, requirementKey: null }] })
    await admin`insert into task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status) values (${duplicateQuestion}::uuid, ${duplicateTask}::uuid, ${`clarification_question:${duplicateQuestion}`}, ${duplicateV1.artifactId}::uuid, 1, 'open')`
    const duplicateWriter = postgres(writerUrl!, { max: 1, onnotice: () => {} })
    try {
      const artifactId = randomUUID(); const digest = `hmac-sha256:${'c'.repeat(64)}`
      await duplicateWriter`select forge.insert_architect_plan_version_v1(
        ${duplicateRun2}::uuid, ${artifactId}::uuid, 2::bigint, 's4-test-key', ${digest}, ${digest},
        ${['plan_body:000000', 'requirement:plan-policy', `clarification_question:${duplicateQuestion}`]}::text[],
        ${['plan_body', 'requirement', 'subtask']}::text[],
        ${[null, null, null]}::text[], ${[null, 'plan-policy', null]}::text[], ${[null, null, null]}::text[],
        ${['body', JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), '{"schemaVersion":1}']}::text[],
        ${[digest, digest, digest]}::text[], ${['false', 'false', 'false']}::text[]
      )`
    } finally { await duplicateWriter.end({ timeout: 5 }) }
    const [duplicateIdentity] = await admin<{ count: number }[]>`
      select count(*)::integer as count from architect_plan_entries
      where task_id = ${duplicateTask}::uuid and entry_id = ${`clarification_question:${duplicateQuestion}`}
        and plan_version in (1, 2)
    `
    expect(duplicateIdentity.count).toBe(2)
    const [auditBeforeDuplicate] = await admin<{ count: number }[]>`select count(*)::integer as count from architect_plan_history_reads where task_id = ${duplicateTask}::uuid`
    await expect(readArchitectPlanHistory({ planVersion: '2', sessionCredential, taskId: duplicateTask })).rejects.toMatchObject({ code: 'invalid_evidence' })
    const [auditAfterDuplicate] = await admin<{ count: number }[]>`select count(*)::integer as count from architect_plan_history_reads where task_id = ${duplicateTask}::uuid`
    expect(auditAfterDuplicate.count).toBe(auditBeforeDuplicate.count)
    await admin`
      insert into task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status)
      values (${ids.secondClarificationQuestion}::uuid, ${ids.task}::uuid,
        ${`clarification_question:${ids.secondClarificationQuestion}`}, ${second.artifactId}::uuid, 2, 'open')
    `
    await appendArchitectClarificationAnswer({ answer: 'staging', answerId: ids.secondClarificationAnswer,
      digestKey: key, digestKeyId: 's4-test-key', questionId: ids.secondClarificationQuestion,
      sessionCredential, sourcePlanArtifactId: second.artifactId, sourcePlanVersion: '2', taskId: ids.task })
    await recordArchitectPlanVersion({
      agentRunId: ids.thirdArchitectRun, digestKey: key, digestKeyId: 's4-test-key',
      planVersion: '3', taskId: ids.task,
      entries: [{ agent: null, bindingFingerprint: null, content: 'Third protected plan.',
        entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null },
      { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' }],
    })
    const latestHistory = await readArchitectPlanHistory({ planVersion: '3', sessionCredential, taskId: ids.task })
    expect(latestHistory.map((entry) => entry.entryId)).toEqual([
      `clarification_answer:${ids.clarificationAnswer}`,
      `clarification_answer:${ids.secondClarificationAnswer}`,
      `clarification_question:${ids.clarificationQuestion}`,
      `clarification_question:${ids.secondClarificationQuestion}`,
      'plan_body:000000',
      'requirement:plan-policy',
    ].sort((left, right) => left.localeCompare(right, 'en')))
    const [latestAudit] = await admin<{ returnedEntryCount: number; entrySetDigest: string }[]>`
      select returned_entry_count::integer as "returnedEntryCount", entry_set_digest as "entrySetDigest"
      from architect_plan_history_reads where task_id = ${ids.task}::uuid and plan_version = 3
      order by read_at desc limit 1
    `
    // canonicalArchitectPlanJson sorts object keys; PostgreSQL jsonb emits the
    // same canonical object order. Keep this literal byte representation in
    // the proof so an ordering or whitespace drift is diagnosable.
    const canonicalSet = latestHistory.map(({ entryId, contentDigest }) => ({ contentDigest, entryId }))
    const canonicalSerialized = JSON.stringify(canonicalSet)
    expect(canonicalSerialized).toMatch(/^\[{"contentDigest":"hmac-sha256:[0-9a-f]{64}","entryId":"clarification_answer:/)
    expect(latestAudit.returnedEntryCount).toBe(6)
    expect(latestAudit.entrySetDigest).toBe(`sha256:${createHash('sha256').update(canonicalSerialized).digest('hex')}`)
    const lockRun = randomUUID()
    const lockQuestion = randomUUID()
    await admin`insert into agent_runs (id, task_id, agent_type, model_id_used, status) values (${lockRun}::uuid, ${ids.task}::uuid, 'architect', 'test', 'completed')`
    const lockPlan = await recordArchitectPlanVersion({ agentRunId: lockRun, digestKey: key, digestKeyId: 's4-test-key', planVersion: '4', taskId: ids.task,
      entries: [{ agent: null, bindingFingerprint: null, content: 'Lock source.', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null }, { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' }, {
        agent: null, bindingFingerprint: null, entryId: `clarification_question:${lockQuestion}`, entryKind: 'clarification_question', projectionEligible: false, requirementKey: null,
        content: JSON.stringify({ schemaVersion: 1, questionId: lockQuestion, question: 'Lock?', suggestions: ['yes'] }) }] })
    await admin`insert into task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status)
      values (${lockQuestion}::uuid, ${ids.task}::uuid, ${`clarification_question:${lockQuestion}`}, ${lockPlan.artifactId}::uuid, 4, 'open')`
    const appName = `pr198-history-append-${randomUUID()}`
    const lockAnswer = randomUUID()
    const appendCredential = randomUUID()
    await admin`insert into sessions (id, user_id, credential_digest_v1, expires_at, credential_storage_version)
      values (${randomUUID()}::uuid, ${ids.user}::uuid, ${computeCredentialDigest(appendCredential).digest}::bytea,
        clock_timestamp() + interval '7 days', 2)`
    const appendUrl = new URL(historyReaderUrl!)
    appendUrl.searchParams.set('application_name', appName)
    const savedHistoryUrl = process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL
    const directReader = postgres(historyReaderUrl!, { max: 1, onnotice: () => {} })
    let appendPromise: Promise<{ answerId: string; allAnswered: boolean }> | null = null
    let appendSettled = false
    let readerPid = 0
    let lockedRows: Array<{ entry_id: string; content_digest: string }> = []
    try {
      process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = appendUrl.toString()
      await directReader.begin(async (tx) => {
        const [reader] = await tx<{ pid: number }[]>`select pg_backend_pid()::integer as pid`
        readerPid = reader.pid
        const credentialBytes = Buffer.from(sessionCredential, 'ascii')
        try {
          lockedRows = await tx<{ entry_id: string; content_digest: string }[]>`
            select entry_id, content_digest from forge.read_architect_plan_history_v1(
              ${credentialBytes}::bytea, ${ids.task}::uuid, 4::bigint
            )
          `
        } finally { credentialBytes.fill(0) }
        appendPromise = appendArchitectClarificationAnswer({ answer: 'yes', answerId: lockAnswer, digestKey: key, digestKeyId: 's4-test-key', questionId: lockQuestion,
          sessionCredential: appendCredential, sourcePlanArtifactId: lockPlan.artifactId, sourcePlanVersion: '4', taskId: ids.task })
          .finally(() => { appendSettled = true })
        let waiting: { pid: number; state: string; waitEvent: string | null } | undefined
        for (let attempt = 0; attempt < 40 && !waiting; attempt += 1) {
          const [row] = await admin<{ pid: number; state: string; waitEvent: string | null; waitEventType: string | null; blockingPids: number[] }[]>`
            select pid, state, wait_event as "waitEvent", wait_event_type as "waitEventType",
              pg_blocking_pids(pid) as "blockingPids"
            from pg_stat_activity where application_name = ${appName}
          `
          if (row?.waitEventType === 'Lock' && row.blockingPids.includes(readerPid)) waiting = row
          else await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(waiting).toEqual(expect.objectContaining({ state: expect.any(String), waitEvent: expect.anything() }))
        expect(appendSettled).toBe(false)
      })
      await expect(Promise.race([
        appendPromise!,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('append did not finish after reader commit')), 5_000)),
      ])).resolves.toMatchObject({ allAnswered: true })
    } finally {
      if (savedHistoryUrl === undefined) delete process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL
      else process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = savedHistoryUrl
      await directReader.end({ timeout: 5 })
    }
    expect(lockedRows.some((row) => row.entry_id === `clarification_answer:${lockAnswer}`)).toBe(false)
    const [lockedAudit] = await admin<{ returnedEntryCount: number; entrySetDigest: string }[]>`
      select returned_entry_count::integer as "returnedEntryCount", entry_set_digest as "entrySetDigest"
      from architect_plan_history_reads where task_id = ${ids.task}::uuid and plan_version = 4
      order by read_at desc limit 1
    `
    const lockedSet = lockedRows.map((row) => ({ contentDigest: row.content_digest, entryId: row.entry_id }))
    const lockedSerialized = JSON.stringify(lockedSet)
    expect(lockedAudit.returnedEntryCount).toBe(lockedRows.length)
    expect(lockedAudit.entrySetDigest).toBe(`sha256:${createHash('sha256').update(lockedSerialized).digest('hex')}`)
    // Dedicated exact-boundary fixture: 128 questions + 126 answers + two V2 structural rows.
    const boundaryTask = randomUUID()
    const overrunRun = randomUUID()
    const overrunReadRun = randomUUID()
    await admin`insert into tasks (id, project_id, submitted_by, title, prompt, status)
      values (${boundaryTask}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, 'Boundary', 'protected', 'running')`
    await admin`insert into agent_runs (id, task_id, agent_type, model_id_used, status) values
      (${overrunRun}::uuid, ${boundaryTask}::uuid, 'architect', 'test', 'completed'),
      (${overrunReadRun}::uuid, ${boundaryTask}::uuid, 'architect', 'test', 'completed')`
    const overrunQuestions = Array.from({ length: 128 }, () => randomUUID())
    const overrunPlan = await recordArchitectPlanVersion({
      agentRunId: overrunRun, digestKey: key, digestKeyId: 's4-test-key', planVersion: '1', taskId: boundaryTask,
      entries: [{ agent: null, bindingFingerprint: null, content: 'Overrun source.', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null }, { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' },
        ...overrunQuestions.map((questionId) => ({ agent: null, bindingFingerprint: null,
          content: JSON.stringify({ schemaVersion: 1, questionId, question: 'Bounded?', suggestions: ['yes'] }),
          entryId: `clarification_question:${questionId}`, entryKind: 'clarification_question' as const,
          projectionEligible: false, requirementKey: null }))],
    })
    for (const questionId of overrunQuestions) {
      await admin`insert into task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status)
        values (${questionId}::uuid, ${boundaryTask}::uuid, ${`clarification_question:${questionId}`}, ${overrunPlan.artifactId}::uuid, 1, 'open')`
      if (overrunQuestions.indexOf(questionId) >= 126) continue
      await appendArchitectClarificationAnswer({ answer: 'yes', answerId: randomUUID(), digestKey: key,
        digestKeyId: 's4-test-key', questionId, sessionCredential, sourcePlanArtifactId: overrunPlan.artifactId,
        sourcePlanVersion: '1', taskId: boundaryTask })
    }
    const boundaryV2 = await recordArchitectPlanVersion({ agentRunId: overrunReadRun, digestKey: key, digestKeyId: 's4-test-key', planVersion: '2', taskId: boundaryTask,
      entries: [{ agent: null, bindingFingerprint: null, content: 'Overrun read.', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null }, { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' }] })
    void boundaryV2
    const [boundaryCount] = await admin<{ count: number }[]>`select (2 + count(*) filter (where true) + (select count(*) from architect_clarification_answers where task_id = ${boundaryTask}::uuid))::integer as count from task_questions where task_id = ${boundaryTask}::uuid`
    expect(boundaryCount.count).toBe(256)
    const boundaryHistory = await readArchitectPlanHistory({ planVersion: '2', sessionCredential, taskId: boundaryTask })
    expect(boundaryHistory).toHaveLength(256)
    const [boundaryAudit] = await admin<{ count: number; returnedEntryCount: number; entrySetDigest: string }[]>`
      select count(*)::integer as count, max(returned_entry_count)::integer as "returnedEntryCount", max(entry_set_digest) as "entrySetDigest"
      from architect_plan_history_reads where task_id = ${boundaryTask}::uuid`
    const boundarySerialized = JSON.stringify(boundaryHistory.map(({ entryId, contentDigest }) => ({ contentDigest, entryId })))
    expect(boundaryAudit.count).toBe(1)
    expect(boundaryAudit.returnedEntryCount).toBe(256)
    expect(boundaryAudit.entrySetDigest).toBe(`sha256:${createHash('sha256').update(boundarySerialized).digest('hex')}`)
    await appendArchitectClarificationAnswer({ answer: 'yes', answerId: randomUUID(), digestKey: key,
      digestKeyId: 's4-test-key', questionId: overrunQuestions[126], sessionCredential,
      sourcePlanArtifactId: overrunPlan.artifactId, sourcePlanVersion: '1', taskId: boundaryTask })
    const [overBoundaryCount] = await admin<{ count: number }[]>`select (2 + count(*) + (select count(*) from architect_clarification_answers where task_id = ${boundaryTask}::uuid))::integer as count from task_questions where task_id = ${boundaryTask}::uuid`
    expect(overBoundaryCount.count).toBe(257)
    await expect(readArchitectPlanHistory({ planVersion: '2', sessionCredential, taskId: boundaryTask })).rejects.toMatchObject({ code: 'invalid_evidence' })
    const [boundaryAuditAfter] = await admin<{ count: number }[]>`select count(*)::integer as count from architect_plan_history_reads where task_id = ${boundaryTask}::uuid`
    expect(boundaryAuditAfter.count).toBe(1)
    }
    const packageEntry = recorded.entries.find((entry) => entry.entryKind === 'subtask')!
    const reference = executableReferenceForEntry(packageEntry)
    const [bound] = await issuer<{ referenceId: string }[]>`
      select forge.bind_architect_plan_entry_v1(
        ${ids.task}::uuid, ${ids.package}::uuid, ${ids.firstRun}::uuid,
        ${reference.planArtifactId}::uuid, ${reference.planVersion}::bigint,
        ${reference.entryId}, ${reference.contentDigest}, ${reference.digestKeyId},
        ${reference.requirementKey}, ${reference.bindingFingerprint}
      ) as "referenceId"
    `
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      reference,
      referenceId: bound.referenceId,
      taskId: ids.task,
    })).resolves.toMatchObject({
      content: expect.stringContaining('filesystem.project.read'),
      entryId: 'subtask:000001:backend',
    })
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      reference,
      referenceId: bound.referenceId,
      taskId: ids.task,
    })).rejects.toMatchObject({ code: 'invalid_evidence' })

    const planBody = recorded.entries.find((entry) => entry.entryKind === 'plan_body')!
    expect(() => executableReferenceForEntry(planBody)).toThrow(/ineligible Architect history/i)
    expect(architectReplanReferenceForEntry(planBody)).toEqual(expect.objectContaining({
      entryId: 'plan_body:000000',
    }))
    const replanContext = await bindArchitectReplanContext({
      agentRunId: ids.replanRun,
      priorPlanArtifactId: recorded.artifactId,
    })
    expect(replanContext.map((entry) => entry.entryId)).toEqual(expect.arrayContaining([
      'plan_body:000000',
      'requirement:plan-policy',
      'routing:filesystem-context:backend',
      `clarification_question:${ids.clarificationQuestion}`,
      `clarification_answer:${ids.clarificationAnswer}`,
    ]))
    const replanReferenceId = replanContext.find(
      (entry) => entry.entryId === 'plan_body:000000',
    )!.referenceId
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      expectedPurpose: 'architect_replan',
      referenceId: replanReferenceId,
    })).resolves.toMatchObject({
      content: 'Prior protected Architect plan body.',
      entryId: 'plan_body:000000',
    })
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      expectedPurpose: 'architect_replan',
      referenceId: replanReferenceId,
    })).rejects.toMatchObject({ code: 'invalid_evidence' })
    const questionReferenceId = replanContext.find(
      (entry) => entry.entryId === `clarification_question:${ids.clarificationQuestion}`,
    )!.referenceId
    const answerReferenceId = replanContext.find(
      (entry) => entry.entryId === `clarification_answer:${ids.clarificationAnswer}`,
    )!.referenceId
    await expect(resolveArchitectReplanEntry({
      digestKey: key,
      referenceId: questionReferenceId,
    })).resolves.toMatchObject({
      sourceKind: 'architect_plan_entry',
      entryId: `clarification_question:${ids.clarificationQuestion}`,
    })
    await expect(resolveArchitectReplanEntry({
      digestKey: key,
      referenceId: answerReferenceId,
    })).resolves.toMatchObject({
      sourceKind: 'clarification_answer',
      entryId: `clarification_answer:${ids.clarificationAnswer}`,
      questionId: ids.clarificationQuestion,
      answerId: ids.clarificationAnswer,
    })
    await expect(resolveArchitectReplanEntry({
      digestKey: key,
      referenceId: questionReferenceId,
    })).rejects.toMatchObject({ code: 'invalid_evidence' })
    await expect(resolveArchitectReplanEntry({
      digestKey: key,
      referenceId: answerReferenceId,
    })).rejects.toMatchObject({ code: 'invalid_evidence' })
    await runStatefulHistoryProof()
  })

  it('rolls back the whole protected clarification form when a later append conflicts', async () => {
    const taskId = randomUUID()
    const runId = randomUUID()
    const firstQuestionId = randomUUID()
    const secondQuestionId = randomUUID()
    const firstAnswerId = randomUUID()
    const secondAnswerId = randomUUID()
    await admin`insert into tasks (id, project_id, submitted_by, title, prompt, status)
      values (${taskId}::uuid, ${ids.project}::uuid, ${ids.user}::uuid,
        'Atomic clarification batch', 'protected', 'awaiting_answers')`
    await admin`insert into agent_runs (id, task_id, agent_type, model_id_used, status)
      values (${runId}::uuid, ${taskId}::uuid, 'architect', 'test', 'completed')`
    const source = await recordArchitectPlanVersion({
      agentRunId: runId,
      digestKey: key,
      digestKeyId: 's4-test-key',
      planVersion: '1',
      taskId,
      entries: [
        { agent: null, bindingFingerprint: null, content: 'body', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null },
        { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' },
        ...[firstQuestionId, secondQuestionId].map((questionId) => ({
          agent: null,
          bindingFingerprint: null,
          content: JSON.stringify({
            schemaVersion: 1,
            questionId,
            question: 'Which branch?',
            suggestions: ['main'],
          }),
          entryId: `clarification_question:${questionId}`,
          entryKind: 'clarification_question' as const,
          projectionEligible: false,
          requirementKey: null,
        })),
      ],
    })
    await admin`insert into task_questions (
        id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status
      ) values
        (${firstQuestionId}::uuid, ${taskId}::uuid,
          ${`clarification_question:${firstQuestionId}`}, ${source.artifactId}::uuid, 1, 'open'),
        (${secondQuestionId}::uuid, ${taskId}::uuid,
          ${`clarification_question:${secondQuestionId}`}, ${source.artifactId}::uuid, 1, 'open')`

    const batch = [{
      answer: 'main',
      answerId: firstAnswerId,
      digestKey: key,
      digestKeyId: 's4-test-key',
      questionId: firstQuestionId,
      sessionCredential,
      sourcePlanArtifactId: source.artifactId,
      sourcePlanVersion: '1',
      taskId,
    }, {
      answer: 'release',
      answerId: secondAnswerId,
      digestKey: key,
      digestKeyId: 's4-test-key',
      questionId: secondQuestionId,
      sessionCredential,
      sourcePlanArtifactId: source.artifactId,
      sourcePlanVersion: '1',
      taskId,
    }]
    await admin`update task_questions set status = 'legacy_unavailable'
      where task_id = ${taskId}::uuid and id = ${secondQuestionId}::uuid`
    await expect(appendArchitectClarificationAnswers(batch)).rejects.toMatchObject({
      code: 'invalid_evidence',
    })
    const [afterConflict] = await admin<{
      answerCount: number
      answeredCount: number
    }[]>`select
        (select count(*)::integer from architect_clarification_answers
          where task_id = ${taskId}::uuid) as "answerCount",
        (select count(*)::integer from task_questions
          where task_id = ${taskId}::uuid and status = 'answered') as "answeredCount"`
    expect(afterConflict).toEqual({ answerCount: 0, answeredCount: 0 })

    await admin`update task_questions set status = 'open'
      where task_id = ${taskId}::uuid and id = ${secondQuestionId}::uuid`
    await expect(appendArchitectClarificationAnswers(batch)).resolves.toEqual([
      { answerId: firstAnswerId, allAnswered: false },
      { answerId: secondAnswerId, allAnswered: true },
    ])
  })

  it('serves protected Architect history through the real password session route with PostgreSQL as authority', async () => {
    const ownerPassword = 'route-history-password'
    const routeProject = randomUUID()
    const routeTask = randomUUID()
    const routeRun = randomUUID()
    const otherUser = randomUUID()
    const otherProject = randomUUID()
    const otherTask = randomUUID()
    const otherRun = randomUUID()
    const digestKey = randomBytes(32)

    // Redis is unavailable and contains forged-looking state. The route must
    // still use only the locked PostgreSQL session decision.
    mockRedisDel.mockResolvedValue(0)
    mockRedisEval.mockResolvedValue(['{"userId":"forged"}', Date.now() + 60_000, 0, 0])
    mockRedisExpire.mockResolvedValue(1)
    mockRedisIncr.mockResolvedValue(1)
    mockRedisSet.mockRejectedValue(new Error('Redis unavailable for route proof'))

    const [firstUser] = await admin<{ id: string }[]>`select id::text as id from users limit 1`
    expect(firstUser?.id).toBeTruthy()
    await admin`update users set password_hash = ${await hashPassword(ownerPassword)} where id = ${firstUser!.id}::uuid`
    await admin.begin(async (tx) => {
      await tx`insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
        values (${routeProject}::uuid, 'Route history project', ${firstUser!.id}::uuid, 1, 1)`
      await tx`insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (${routeTask}::uuid, ${routeProject}::uuid, ${firstUser!.id}::uuid,
          'Route history task', 'protected route fixture', 'running')`
      await tx`insert into agent_runs (id, task_id, agent_type, model_id_used, status)
        values (${routeRun}::uuid, ${routeTask}::uuid, 'architect', 'test', 'completed')`
      await tx`insert into users (id, display_name) values (${otherUser}::uuid, 'Route history other user')`
      await tx`insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
        values (${otherProject}::uuid, 'Route history other project', ${otherUser}::uuid, 1, 1)`
      await tx`insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (${otherTask}::uuid, ${otherProject}::uuid, ${otherUser}::uuid,
          'Route history other task', 'protected other-user fixture', 'running')`
      await tx`insert into agent_runs (id, task_id, agent_type, model_id_used, status)
        values (${otherRun}::uuid, ${otherTask}::uuid, 'architect', 'test', 'completed')`
    })
    await recordArchitectPlanVersion({
      agentRunId: routeRun,
      digestKey,
      digestKeyId: 'route-history-key',
      planVersion: '1',
      taskId: routeTask,
      entries: [{
        agent: null, bindingFingerprint: null, content: 'Route-visible protected plan.',
        entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null,
      }, {
        agent: null, bindingFingerprint: null,
        content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }),
        entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy',
      }],
    })
    await recordArchitectPlanVersion({
      agentRunId: otherRun,
      digestKey,
      digestKeyId: 'route-history-key',
      planVersion: '1',
      taskId: otherTask,
      entries: [{
        agent: null, bindingFingerprint: null, content: 'Other-user protected plan.',
        entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null,
      }, {
        agent: null, bindingFingerprint: null,
        content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }),
        entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy',
      }],
    })

    const { POST: passwordLogin } = await import('@/app/api/auth/login/password/route')
    const { GET: protectedHistory } = await import('@/app/api/tasks/[id]/architect-plan-history/[planVersion]/route')
    const { createSession } = await import('@/lib/session')
    const passwordSession = async (): Promise<string> => {
      const response = await passwordLogin(new Request('http://localhost/api/auth/login/password', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ownerPassword }),
      }) as never)
      expect(response.status).toBe(200)
      const match = response.headers.get('set-cookie')?.match(/(?:^|,\s*)forge_session=([^;]+)/)
      expect(match?.[1]).toMatch(/^[0-9a-f-]{36}$/)
      return match![1]
    }
    const routeRead = async (credential: string, taskId: string, planVersion: string) => protectedHistory(
      new Request(`http://localhost/api/tasks/${taskId}/architect-plan-history/${planVersion}`, {
        headers: { cookie: `forge_session=${credential}` },
      }) as never,
      { params: Promise.resolve({ id: taskId, planVersion }) },
    )
    const auditCount = async (taskId: string) => {
      const [row] = await admin<{ count: number }[]>`
        select count(*)::integer as count from architect_plan_history_reads where task_id = ${taskId}::uuid
      `
      return row.count
    }

    const liveCredential = await passwordSession()
    const successful = await routeRead(liveCredential, routeTask, '1')
    expect(successful.status).toBe(200)
    const successfulBody = await successful.json() as { taskId: string; planVersion: string; entries: Array<{ entryId: string; content: string }> }
    expect(successfulBody).toEqual(expect.objectContaining({ taskId: routeTask, planVersion: '1' }))
    expect(successfulBody.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: 'plan_body:000000', content: 'Route-visible protected plan.' }),
    ]))
    const responseText = JSON.stringify(successfulBody)
    expect(responseText).not.toContain(liveCredential)
    expect(responseText).not.toMatch(/credential|storage|session(?:_|-)?id/i)
    const [successAudit] = await admin<{ count: number; digest: string; returned: number }[]>`
      select count(*)::integer as count, max(entry_set_digest) as digest,
        max(returned_entry_count)::integer as returned
      from architect_plan_history_reads where task_id = ${routeTask}::uuid
    `
    expect(successAudit).toEqual({
      count: 1,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      returned: successfulBody.entries.length,
    })
    const [auditTextColumns] = await admin<{ count: number }[]>`
      select count(*)::integer as count
      from information_schema.columns
      where table_schema = 'public' and table_name = 'architect_plan_history_reads'
        and column_name in ('content', 'credential', 'credential_digest', 'storage_locator')
    `
    expect(auditTextColumns).toEqual({ count: 0 })

    const assertSessionDenied = async (credential: string) => {
      const before = await auditCount(routeTask)
      const response = await routeRead(credential, routeTask, '1')
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expect(await auditCount(routeTask)).toBe(before)
    }
    const revokedCredential = await passwordSession()
    await admin`update sessions set revoked_at = clock_timestamp()
      where credential_digest_v1 = ${computeCredentialDigest(revokedCredential).digest}::bytea`
    await assertSessionDenied(revokedCredential)

    const expiryBoundaryCredential = await passwordSession()
    await admin`update sessions set expires_at = clock_timestamp()
      where credential_digest_v1 = ${computeCredentialDigest(expiryBoundaryCredential).digest}::bytea`
    await assertSessionDenied(expiryBoundaryCredential)

    const rotatedOldCredential = await passwordSession()
    const rotatedCurrentCredential = await passwordSession()
    await admin`update sessions set revoked_at = clock_timestamp()
      where credential_digest_v1 = ${computeCredentialDigest(rotatedOldCredential).digest}::bytea`
    await assertSessionDenied(rotatedOldCredential)
    const [rotatedCurrent] = await admin<{ live: boolean }[]>`
      select revoked_at is null and expires_at > clock_timestamp() as live from sessions
      where credential_digest_v1 = ${computeCredentialDigest(rotatedCurrentCredential).digest}::bytea
    `
    expect(rotatedCurrent).toEqual({ live: true })

    await assertSessionDenied(randomUUID())

    // The password route is intentionally single-user today, so create the
    // second user's canonical database-authoritative session through the same
    // production session boundary that the route later validates.
    const otherCredential = await createSession(otherUser, null, { ip: null, userAgent: null })
    const otherSuccessful = await routeRead(otherCredential, otherTask, '1')
    expect(otherSuccessful.status).toBe(200)
    const otherSuccessfulBody = await otherSuccessful.json() as { taskId: string; planVersion: string; entries: Array<{ entryId: string; content: string }> }
    expect(otherSuccessfulBody).toEqual(expect.objectContaining({ taskId: otherTask, planVersion: '1' }))
    expect(otherSuccessfulBody.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: 'plan_body:000000', content: 'Other-user protected plan.' }),
    ]))
    const [otherSuccessAudit] = await admin<{ count: number; digest: string; returned: number }[]>`
      select count(*)::integer as count, max(entry_set_digest) as digest,
        max(returned_entry_count)::integer as returned
      from architect_plan_history_reads where task_id = ${otherTask}::uuid
    `
    expect(otherSuccessAudit).toEqual({
      count: 1,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      returned: otherSuccessfulBody.entries.length,
    })

    const crossTaskCredential = await passwordSession()
    const beforeCrossTaskOwner = await auditCount(routeTask)
    const beforeCrossTaskOther = await auditCount(otherTask)
    const crossTask = await routeRead(crossTaskCredential, otherTask, '1')
    expect(crossTask.status).toBe(404)
    await expect(crossTask.json()).resolves.toEqual({ error: 'Architect plan history not found.' })
    expect(await auditCount(routeTask)).toBe(beforeCrossTaskOwner)
    expect(await auditCount(otherTask)).toBe(beforeCrossTaskOther)

    const beforeWrongVersion = await auditCount(routeTask)
    const wrongVersion = await routeRead(crossTaskCredential, routeTask, '2')
    expect(wrongVersion.status).toBe(404)
    await expect(wrongVersion.json()).resolves.toEqual({ error: 'Architect plan history not found.' })
    expect(await auditCount(routeTask)).toBe(beforeWrongVersion)
    expect(mockRedisSet).toHaveBeenCalled()
  })

  it('resume-safely rekeys a crash-window legacy session and leaves no raw-id lookup target', async () => {
    const legacyCredential = randomUUID()
    const legacyUser = randomUUID()
    const expectedDigest = computeCredentialDigest(legacyCredential).digest
    await admin.begin(async (tx) => {
      await tx`insert into users (id, display_name) values (${legacyUser}::uuid, 'Legacy session rekey test')`
      // This is the durable state after digest backfill but before the independent
      // primary-key update. It models a statement-level migration interruption.
      await tx`
        insert into sessions (
          id, user_id, credential_digest_v1, expires_at, credential_storage_version
        )
        values (
          ${legacyCredential}::uuid, ${legacyUser}::uuid, ${expectedDigest}::bytea,
          clock_timestamp() + interval '7 days', 2
        )
      `
    })

    const applyRekey = () => admin`
      update sessions
      set id = gen_random_uuid()
      where credential_digest_v1 = sha256(
        convert_to('forge:web-session:v1', 'UTF8') || decode('00', 'hex') || convert_to(id::text, 'UTF8')
      )
    `
    expect((await applyRekey()).count).toBe(1)
    expect((await applyRekey()).count).toBe(0)

    const [proof] = await admin<{
      digestRows: number
      rawIdRows: number
      retainedRawIds: number
    }[]>`
      select
        count(*) filter (where credential_digest_v1 = ${expectedDigest}::bytea)::integer as "digestRows",
        count(*) filter (where id = ${legacyCredential}::uuid)::integer as "rawIdRows",
        count(*) filter (
          where credential_digest_v1 = sha256(
            convert_to('forge:web-session:v1', 'UTF8') || decode('00', 'hex') || convert_to(id::text, 'UTF8')
          )
        )::integer as "retainedRawIds"
      from sessions
    `
    expect(proof).toEqual({ digestRows: 1, rawIdRows: 0, retainedRawIds: 0 })
  })

  it('uses production logout and claim paths for v0, v1, and v2 session cache purges', async () => {
    const { destroySession, reconcilePendingSessionCacheInvalidations } = await import('@/lib/session')
    for (const invalidDigest of [null, Buffer.alloc(31, 1)]) {
      const invalidSession = randomUUID()
      const liveDigest = computeCredentialDigest(randomUUID()).digest
      await admin`
        insert into sessions (id, user_id, credential_digest_v1, expires_at, credential_storage_version)
        values (${invalidSession}::uuid, ${ids.user}::uuid, ${liveDigest}::bytea,
          clock_timestamp() + interval '7 days', 2)
      `
      await expect(admin`
        update sessions
        set cache_purge_pending_at = clock_timestamp(),
          cache_purge_credential_digest_v1 = ${invalidDigest}::bytea,
          cache_purge_generation = gen_random_uuid()
        where id = ${invalidSession}::uuid
      `).rejects.toMatchObject({ code: '23514' })
    }
    for (const storageVersion of [0, 1, 2] as const) {
      const credential = randomUUID()
      const digest = computeCredentialDigest(credential).digest
      const sessionId = storageVersion < 2 ? credential : randomUUID()
      if (storageVersion === 0) {
        await admin`insert into sessions (id, user_id, credential_storage_version)
          values (${sessionId}::uuid, ${ids.user}::uuid, 0)`
      } else {
        await admin`
          insert into sessions (id, user_id, credential_digest_v1, expires_at, credential_storage_version)
          values (${sessionId}::uuid, ${ids.user}::uuid, ${digest}::bytea,
            clock_timestamp() + interval '7 days', ${storageVersion})
        `
      }

      mockRedisDel.mockRejectedValueOnce(new Error('test redis outage'))
      await destroySession(credential)
      const [pending] = await admin<{
        digestMatches: boolean
        legacy: boolean
        pending: boolean
        revoked: boolean
      }[]>`
        select cache_purge_credential_digest_v1 = ${digest}::bytea as "digestMatches",
          credential_storage_version < 2 as legacy,
          cache_purge_pending_at is not null as pending,
          revoked_at is not null as revoked
        from sessions where id = ${sessionId}::uuid
      `
      expect(pending).toEqual({ digestMatches: true, legacy: storageVersion < 2, pending: true, revoked: true })

      await admin`update sessions set cache_purge_next_attempt_at = clock_timestamp()
        where id = ${sessionId}::uuid`
      mockRedisDel.mockResolvedValueOnce(0)
      await expect(reconcilePendingSessionCacheInvalidations(1)).resolves.toEqual({
        claimed: 1, completed: 1, deferred: 0, stale: 0,
      })
      const [completed] = await admin<{
        completed: boolean
        digestCleared: boolean
        pending: boolean
      }[]>`
        select cache_purge_completed_at is not null as completed,
          cache_purge_credential_digest_v1 is null as "digestCleared",
          cache_purge_pending_at is not null as pending
        from sessions where id = ${sessionId}::uuid
      `
      expect(completed).toEqual({ completed: true, digestCleared: true, pending: false })
    }

    const expiredClaimCredential = randomUUID()
    const expiredClaimDigest = computeCredentialDigest(expiredClaimCredential).digest
    const expiredClaimSession = randomUUID()
    await admin`
      insert into sessions (id, user_id, credential_digest_v1, expires_at, credential_storage_version)
      values (${expiredClaimSession}::uuid, ${ids.user}::uuid, ${expiredClaimDigest}::bytea,
        clock_timestamp() + interval '7 days', 2)
    `
    mockRedisDel.mockRejectedValueOnce(new Error('test redis outage'))
    await destroySession(expiredClaimCredential)
    await admin`
      update sessions set cache_purge_claim_token = gen_random_uuid(),
        cache_purge_claim_expires_at = clock_timestamp() - interval '1 second',
        cache_purge_next_attempt_at = clock_timestamp()
      where id = ${expiredClaimSession}::uuid
    `
    mockRedisDel.mockResolvedValueOnce(0)
    const [first, second] = await Promise.all([
      reconcilePendingSessionCacheInvalidations(1),
      reconcilePendingSessionCacheInvalidations(1),
    ])
    expect([first.claimed, second.claimed].sort()).toEqual([0, 1])
    expect(first.completed + second.completed).toBe(1)
  })

  it.each([
    ['v2', 2],
    ['dual-write v1', 1],
  ])('holds the %s session row through cache population so logout waits and then purges it', async (
    _label,
    credentialStorageVersion,
  ) => {
    const { destroySession, getSession } = await import('@/lib/session')
    const credential = randomUUID()
    const digest = computeCredentialDigest(credential).digest
    const sessionId = credentialStorageVersion === 1 ? credential : randomUUID()
    mockRedisDel.mockClear()
    mockRedisSet.mockClear()
    await admin`
      insert into sessions (id, user_id, credential_digest_v1, expires_at, credential_storage_version)
      values (${sessionId}::uuid, ${ids.user}::uuid, ${digest}::bytea,
        clock_timestamp() + interval '7 days', ${credentialStorageVersion})
    `

    let releaseCacheWrite: (() => void) | undefined
    const cacheWriteStarted = new Promise<void>((resolve) => {
      mockRedisSet.mockImplementationOnce(async () => {
        resolve()
        await new Promise<void>((release) => { releaseCacheWrite = release })
        return 'OK'
      })
    })
    mockRedisDel.mockResolvedValueOnce(0)
    const read = getSession(new Request('http://localhost/', {
      headers: { cookie: `forge_session=${credential}` },
    }))
    await cacheWriteStarted
    let revokeSettled = false
    const revoke = destroySession(credential).then(() => { revokeSettled = true })
    const waitForBlockedLogout = async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const [blocked] = await admin<{ count: number }[]>`
          select count(*)::integer as count
          from pg_catalog.pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like 'update "sessions" set%'
        `
        if (blocked?.count === 1) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('logout did not block on the cache-write session row lock')
    }
    try {
      await waitForBlockedLogout()
      expect(revokeSettled).toBe(false)
    } finally {
      releaseCacheWrite?.()
    }
    await expect(read).resolves.toEqual({ sessionId, userId: ids.user })
    await expect(revoke).resolves.toBeUndefined()
    expect(mockRedisSet).toHaveBeenCalledTimes(credentialStorageVersion === 1 ? 2 : 1)
    expect(mockRedisDel).toHaveBeenCalledWith(
      expect.stringMatching(/^session:v2:/),
      ...(credentialStorageVersion === 1 ? [`session:${credential}`] : []),
    )
  })

  it('allow-once-single-winner: atomically keeps one audit and one nonce claim', async () => {
    const packageId = randomUUID()
    const decisionId = randomUUID()
    const nonce = randomUUID()
    await admin.begin(async (tx) => {
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (
          ${packageId}::uuid, ${ids.task}::uuid, 'backend',
          'Single-winner package', 'bounded', 10, 'ready'
        )
      `
      await tx`
        insert into filesystem_mcp_grant_approvals (
          id, project_id, task_id, work_package_id, decided_by, decision,
          capabilities, effective_grant, decision_scope, grant_decision_revision,
          root_binding_revision, grant_nonce, pointer_fingerprint
        ) values (
          ${decisionId}::uuid, ${ids.project}::uuid, ${ids.task}::uuid,
          ${packageId}::uuid, ${ids.user}::uuid, 'approved',
          '["filesystem.project.read"]'::jsonb, '{}'::jsonb, 'package', 1, 1,
          ${nonce}::uuid, ${SHA}
        )
      `
      await tx`
        update filesystem_mcp_current_decision_pointers
        set current_decision_id = ${decisionId}::uuid,
            current_decision_task_id = ${ids.task}::uuid,
            current_decision_work_package_id = ${packageId}::uuid,
            current_decision_revision = 1,
            current_decision_fingerprint = ${SHA},
            pointer_fingerprint = ${SHA}, pointer_version = 1
        where work_package_id = ${packageId}::uuid
      `
    })
    const [snapshot] = await admin<{ updatedAt: string }[]>`
      select updated_at::text as "updatedAt" from work_packages where id = ${packageId}::uuid
    `
    const attempts = await Promise.allSettled([
      issuer`select * from forge.claim_work_package_lifecycle_v2(
        'packet', ${ids.task}::uuid, ${packageId}::uuid,
        ${snapshot.updatedAt}::text::timestamptz, ${ids.firstClaimRun}::uuid,
        'backend', null, 1, null, 'test', null, 'not_applicable',
        'implementation', 30, ${decisionId}::uuid,
        ${ids.firstLocalClaim}::uuid, ${randomUUID()}::uuid,
        30, 20, array['filesystem.project.read']::text[]
      )`,
      issuer`select * from forge.claim_work_package_lifecycle_v2(
        'packet', ${ids.task}::uuid, ${packageId}::uuid,
        ${snapshot.updatedAt}::text::timestamptz, ${ids.secondClaimRun}::uuid,
        'backend', null, 1, null, 'test', null, 'not_applicable',
        'implementation', 30, ${decisionId}::uuid,
        ${ids.secondLocalClaim}::uuid, ${randomUUID()}::uuid,
        30, 20, array['filesystem.project.read']::text[]
      )`,
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)

    const [counts] = await admin<{ audits: number; nonceClaims: number }[]>`
      select
        count(distinct audit.id)::integer as audits,
        count(distinct claim.id)::integer as "nonceClaims"
      from filesystem_mcp_runtime_audits audit
      left join filesystem_mcp_decision_nonce_claims claim
        on claim.runtime_audit_id = audit.id
      where audit.grant_approval_id = ${decisionId}::uuid
    `
    expect(counts).toEqual({ audits: 1, nonceClaims: 1 })
    await admin`
      update work_packages
      set status = 'blocked', metadata = metadata - 'executionLease'
      where id = ${packageId}::uuid
    `
  })

  it('failure-recovery-atomicity: rolls back both audit and nonce on invalid coverage', async () => {
    const packageId = randomUUID()
    const runId = randomUUID()
    const decisionId = randomUUID()
    const nonce = randomUUID()
    await admin.begin(async (tx) => {
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (${packageId}::uuid, ${ids.task}::uuid, 'backend', 'Rollback package', 'bounded', 11, 'ready')
      `
      await tx`
        insert into filesystem_mcp_grant_approvals (
          id, project_id, task_id, work_package_id, decided_by, decision,
          capabilities, effective_grant, decision_scope, grant_decision_revision,
          root_binding_revision, grant_nonce, pointer_fingerprint
        ) values (
          ${decisionId}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${packageId}::uuid,
          ${ids.user}::uuid, 'approved', '["filesystem.project.read"]'::jsonb,
          '{}'::jsonb, 'package', 2, 1, ${nonce}::uuid, ${SHA}
        )
      `
      await tx`
        update filesystem_mcp_current_decision_pointers
        set current_decision_id = ${decisionId}::uuid,
            current_decision_task_id = ${ids.task}::uuid,
            current_decision_work_package_id = ${packageId}::uuid,
            current_decision_revision = 2, current_decision_fingerprint = ${SHA},
            pointer_fingerprint = ${SHA}, pointer_version = 1
        where work_package_id = ${packageId}::uuid
      `
    })
    const [snapshot] = await admin<{ updatedAt: string }[]>`
      select updated_at::text as "updatedAt" from work_packages where id = ${packageId}::uuid
    `

    await expect(issuer`select * from forge.claim_work_package_lifecycle_v2(
      'packet', ${ids.task}::uuid, ${packageId}::uuid,
      ${snapshot.updatedAt}::text::timestamptz, ${runId}::uuid,
      'backend', null, 1, null, 'test', null, 'not_applicable',
      'implementation', 30, ${decisionId}::uuid,
      ${randomUUID()}::uuid, ${randomUUID()}::uuid,
      30, 20, array['filesystem.project.write']::text[]
    )`).rejects.toBeDefined()
    const [row] = await admin<{ audits: number; nonceClaims: number; runs: number }[]>`
      select
        (select count(*)::integer from filesystem_mcp_runtime_audits
          where grant_approval_id = ${decisionId}::uuid) as audits,
        (select count(*)::integer from filesystem_mcp_decision_nonce_claims
          where grant_approval_id = ${decisionId}::uuid) as "nonceClaims",
        (select count(*)::integer from agent_runs
          where id = ${runId}::uuid) as runs
    `
    expect(row).toEqual({ audits: 0, nonceClaims: 0, runs: 0 })
  })

  it('always-allow-single-run-claim: fails closed without the immutable S3 project pointer', async () => {
    const packageId = randomUUID()
    const runId = randomUUID()
    const decisionId = randomUUID()
    const claimToken = randomUUID()
    await admin.begin(async (tx) => {
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (${packageId}::uuid, ${ids.task}::uuid, 'backend', 'Project grant package', 'bounded', 12, 'ready')
      `
      await tx`
        insert into project_filesystem_grant_decisions (
          id, project_id, decision, capabilities, grant_decision_revision,
          root_binding_revision, decision_fingerprint, decision_generation, decided_by
        ) values (
          ${decisionId}::uuid, ${ids.project}::uuid, 'approved',
          '["filesystem.project.read"]'::jsonb, 3, 1, ${SHA}, 1, ${ids.user}::uuid
        )
      `
    })
    const [snapshot] = await admin<{ updatedAt: string }[]>`
      select updated_at::text as "updatedAt" from work_packages where id = ${packageId}::uuid
    `

    await expect(issuer`select * from forge.claim_work_package_lifecycle_v2(
      'packet', ${ids.task}::uuid, ${packageId}::uuid,
      ${snapshot.updatedAt}::text::timestamptz, ${runId}::uuid,
      'backend', null, 1, null, 'test', null, 'not_applicable',
      'implementation', 30, ${decisionId}::uuid,
      ${claimToken}::uuid, ${randomUUID()}::uuid,
      30, 20, array['filesystem.project.read']::text[]
    )`).rejects.toMatchObject({ code: '55000' })
    const [row] = await admin<{ audits: number }[]>`
      select count(*)::integer as audits from filesystem_mcp_runtime_audits
      where project_decision_id = ${decisionId}::uuid
    `
    expect(row.audits).toBe(0)
  })

  it('typed-writer-boundary: rejects a direct v2 audit before partial evidence exists', async () => {
    await expect(admin`
      insert into filesystem_mcp_runtime_audits (task_id, status, protocol_version)
      values (${ids.task}::uuid, 'claiming', 2)
    `).rejects.toMatchObject({ code: '42501' })
    const [row] = await admin<{ malformed: number }[]>`
      select count(*)::integer as malformed
      from filesystem_mcp_runtime_audits
      where protocol_version = 2 and authorization_snapshot is null
    `
    expect(row.malformed).toBe(0)
  })

  it('creates local evidence only through the running-run fixed principal', async () => {
    const packageId = randomUUID()
    const runId = randomUUID()
    const claimToken = randomUUID()
    await admin.begin(async (tx) => {
      await tx`
        insert into work_packages (id, task_id, assigned_role, title, summary, sequence, status)
        values (${packageId}::uuid, ${ids.task}::uuid, 'backend', 'Fixed writer package', 'bounded', 13, 'ready')
      `
    })
    await expect(issuer`
      select forge.create_local_run_evidence_v1(${runId}::uuid, ${claimToken}::uuid, 30)
    `).rejects.toMatchObject({ code: '42501' })
    const [snapshot] = await admin<{ updatedAt: string }[]>`
      select updated_at::text as "updatedAt" from work_packages where id = ${packageId}::uuid
    `
    const [created] = await issuer<{ evidenceId: string }[]>`
      select local_run_evidence_id as "evidenceId"
      from forge.claim_work_package_lifecycle_v2(
        'local_only', ${ids.task}::uuid, ${packageId}::uuid,
        ${snapshot.updatedAt}::text::timestamptz, ${runId}::uuid,
        'backend', null, 1, null, 'test', null, 'not_applicable',
        'implementation', 30, null, ${claimToken}::uuid, null,
        30, null, array[]::text[]
      )
    `
    const [row] = await admin<{ agentRunId: string; state: string }[]>`
      select agent_run_id as "agentRunId", state
      from work_package_local_run_evidence where id = ${created.evidenceId}::uuid
    `
    expect(row).toEqual({ agentRunId: runId, state: 'claimed' })
  })

  it('rejects hostile clarification routine identities and ACL tuples without retaining mutations', async () => {
    const rollbackMarker = 'S4 clarification routine authority probe rollback'
    const authorityError = 'The exact S4 clarification routine authority is incomplete'

    async function runAuthorityProbe(mutation: string): Promise<'accepted' | 'rejected'> {
      try {
        await admin.begin(async (tx) => {
          const [{ migrationRole }] = await tx<{ migrationRole: string }[]>`
            select database_row.datdba::pg_catalog.regrole::text as "migrationRole"
            from pg_catalog.pg_database database_row
            where database_row.datname = pg_catalog.current_database()
          `
          await tx.unsafe(`
            alter role forge_s4_routines_owner password null;
            alter role forge_architect_plan_writer password null;
            alter role forge_architect_plan_resolver password null;
            alter role forge_architect_plan_history_reader password null;
            alter role forge_packet_issuer password null;
            alter role forge_review_source_resolver password null;
            alter role forge_s4_recovery_operator password null;
            alter role forge_local_projection_archiver password null;
            alter role forge_project_root_reconciler password null;
          `)
          await tx`grant forge_s4_routines_owner to ${tx(migrationRole)}
            with admin false, inherit false, set true`
          await tx`grant execute on function
            public.forge_finalize_epic_172_s4_owner_bootstrap_v1()
            to ${tx(migrationRole)}`
          await tx.unsafe(mutation)
          await tx`set local session authorization ${tx(migrationRole)}`
          await tx`select public.forge_finalize_epic_172_s4_owner_bootstrap_v1()`
          throw new Error(rollbackMarker)
        })
      } catch (error) {
        if (error instanceof Error && error.message === rollbackMarker) return 'accepted'
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === '42501'
          && 'message' in error
          && error.message === authorityError
        ) {
          return 'rejected'
        }
        throw new Error('The S4 clarification routine authority probe failed unexpectedly.')
      }
      throw new Error('The S4 clarification routine authority probe did not roll back.')
    }

    const hostileMutations = [
      `
        grant execute on function forge.bind_architect_replan_context_v3(uuid,uuid)
          to forge_packet_issuer;
      `,
      `
        grant execute on function forge.resolve_architect_plan_entry_v2(uuid)
          to forge_architect_plan_resolver with grant option;
      `,
      `
        revoke execute on function
          forge.append_architect_clarification_answer_v1(
            bytea,uuid,uuid,uuid,bigint,uuid,text,text,text
          )
          from forge_architect_plan_history_reader;
      `,
      `
        alter function forge.resolve_architect_plan_entry_v2(uuid)
          rename to resolve_architect_plan_entry_v2_exact_probe;
        create function forge.resolve_architect_plan_entry_v2(text)
          returns void language plpgsql as 'begin return; end';
        revoke all on function forge.resolve_architect_plan_entry_v2(text) from public;
        alter function forge.resolve_architect_plan_entry_v2(text)
          owner to forge_s4_routines_owner;
        grant execute on function forge.resolve_architect_plan_entry_v2(text)
          to forge_architect_plan_resolver;
      `,
    ]

    expect(await runAuthorityProbe('')).toBe('accepted')
    for (const mutation of hostileMutations) {
      expect(await runAuthorityProbe(mutation)).toBe('rejected')
      expect(await runAuthorityProbe('')).toBe('accepted')
    }
  })

})

describe.skipIf(!enabled)('Epic 172 legacy leakage scrub PostgreSQL proof', () => {
  const scrubKey = Buffer.alloc(32, 19)
  const scrubKeyId = 's4-scrub-proof-v2'
  const ids = {
    user: randomUUID(), project: randomUUID(), task: randomUUID(), run: randomUUID(),
    expandReceipt: randomUUID(), disabledReceipt: randomUUID(),
  }
  const redis: LegacyLeakageScrubRedis = {
    async purgeLegacyTaskEventKeys(): Promise<RedisScanEvidence> {
      return { complete: true, keysExamined: 0, keysDeleted: 0, remainingKeys: 0, valuesExamined: 0, violations: 0 }
    },
    async scanV2TaskEventHistory(): Promise<RedisScanEvidence> {
      return { complete: true, keysExamined: 0, keysDeleted: 0, remainingKeys: 0, valuesExamined: 0, violations: 0 }
    },
  }
  let admin: ReturnType<typeof postgres>
  let prepared = false
  const scrubOperationIds = new Set<string>()

  function checkpointKey(operationId: string): string {
    return `${LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX}${operationId}`
  }

  async function prepareScrubFixture(): Promise<void> {
    if (prepared) return
    const exactBuilds = JSON.stringify([`issue_179_s4@${'a'.repeat(40)}`])
    const [signer] = await admin<{ id: string }[]>`
      select id::text as id
      from forge_release_signer_keys
      where policy_id = 'forge-epic-172-release-signing-v1' and generation = 1
    `
    if (!signer) throw new Error('S4_SCRUB_POSTGRES fixture requires the shared canonical release signer generation 1.')
    await admin.begin(async (tx) => {
      await tx`insert into users (id, display_name) values (${ids.user}::uuid, 'S4 scrub proof')`
      await tx`insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
        values (${ids.project}::uuid, 'S4 scrub proof', ${ids.user}::uuid, 1, 1)`
      await tx`insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, 'S4 scrub proof', 'canonical prompt', 'running')`
      await tx`insert into agent_runs (id, task_id, agent_type, model_id_used, status)
        values (${ids.run}::uuid, ${ids.task}::uuid, 'architect', 'test', 'completed')`
      await tx`insert into forge_epic_172_release_evidence (
        id, evidence_kind, owner_issue, owner_slice, exact_builds, required_evidence, reviewed_sha, epoch,
        predecessor_receipt_ids, predecessor_set_digest, transition_identity_digest, signer_key_id, signer_generation,
        github_app_id, controller_run_id, controller_job_id, envelope_digest, detached_signature, nonce, issued_at, envelope
      ) values
        (${ids.expandReceipt}::uuid, 's4_expand', 179, 's4', ${exactBuilds}::text::jsonb,
          '[{"name":"bootstrap","measurementDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb, ${'a'.repeat(40)}, ${null}, '[]'::jsonb, ${'0'.repeat(64)}, ${'1'.repeat(64)},
          ${signer.id}::uuid, 1, 's4-scrub-proof', 'scrub-proof', 'expand', ${'2'.repeat(64)},
          decode(repeat('aa', 64), 'hex'), ${randomUUID()}::uuid, transaction_timestamp(), '{}'::jsonb),
        (${ids.disabledReceipt}::uuid, 's4_producers_disabled', 179, 's4', ${exactBuilds}::text::jsonb,
          '[{"name":"s4_expand_receipt"},{"name":"legacy_credentials_publishers_and_sessions_drained"},{"name":"expansion_journal_reconciled_through_watermark"},{"name":"project_root_bindings_complete"},{"name":"legacy_prompt_and_event_data_zero_scan_green"},{"name":"all_v2_producers_disabled"}]'::jsonb,
          ${'a'.repeat(40)}, ${null}, jsonb_build_array(${ids.expandReceipt}::text), ${'0'.repeat(64)}, ${'3'.repeat(64)},
          ${signer.id}::uuid, 1, 's4-scrub-proof', 'scrub-proof', 'disabled', ${'4'.repeat(64)},
          decode(repeat('bb', 64), 'hex'), ${randomUUID()}::uuid, transaction_timestamp(), '{}'::jsonb)
      `
      await tx`update forge_epic_172_enablement_state
        set state = 'disabled', owner_operation_id = null, exact_builds = null, reviewed_sha = null, epoch = null,
          enablement_receipt_id = null, final_readiness_receipt_id = null, opening_authorization_id = null,
          controller_login_id = null, controller_run_id = null, controller_token_digest = null, lease_generation = null,
          last_heartbeat_at = null, lease_expires_at = null, updated_at = clock_timestamp()
        where singleton_id = 'epic-172'`
      await tx`insert into task_logs (task_id, event_type, title, message, front_matter, metadata)
        values (${ids.task}::uuid, 'scrub_proof', 'Scrub proof', 'RAW-SCRUB-SENTINEL',
          '{"prompt":"RAW-SCRUB-PROMPT"}'::jsonb, '{"storageLocator":"/private/scrub-proof"}'::jsonb)`
    })
    prepared = true
  }

  beforeAll(() => {
    admin = postgres(adminUrl!, { max: 3, onnotice: () => {} })
  })

  afterAll(async () => {
    try {
      // The protected artifact/version race intentionally commits immutable plan rows;
      // only mutable fixture rows and operation checkpoints are removed here.
      for (const operationId of scrubOperationIds) {
        await admin`delete from app_settings where key = ${checkpointKey(operationId)}`
      }
      await admin`delete from task_logs where task_id = ${ids.task}::uuid`
      const [rawResidue] = await admin<{ count: number }[]>`
        select (
          (select count(*) from task_logs
            where task_id = ${ids.task}::uuid
              and (message like '%RAW-SCRUB%' or message like '%RAW-REAPPEARED%'))
          +
          (select count(*) from artifacts
            where agent_run_id = ${ids.run}::uuid
              and (content like '%LEGACY-ADR-RACE-SENTINEL%' or content like '%RAW-SCRUB%'))
        )::integer as count
      `
      expect(rawResidue.count).toBe(0)
    } finally {
      await admin?.end({ timeout: 5 })
    }
  })

  it('S4_SCRUB_POSTGRES: authorizes, CAS-scrubs, resumes, and fails closed on reappearance', async () => {
    await prepareScrubFixture()
    console.info('S4_SCRUB_POSTGRES_START')
    const adapter = createLegacyLeakagePostgresAdapter(admin, scrubKey)
    const checkpointFor = async (operationId: string): Promise<LegacyLeakageScrubCheckpoint> => ({
      schemaVersion: 2, operationId, actor: 'scrub-operator', authorizationReceiptId: ids.disabledReceipt,
      fingerprintKeyId: scrubKeyId, sentinelSetFingerprint: 'a'.repeat(64), phase: 'task_logs', state: 'running',
      lastKey: null, rowsExamined: 0, rowsChanged: 0, conflicts: 0, redisKeysExamined: 0, redisKeysDeleted: 0,
      redisV2ValuesExamined: 0, lastPreFingerprint: null, lastPostFingerprint: null, databaseTime: await adapter.databaseTime(),
    })
    const before = await admin<{ count: number }[]>`select count(*)::integer as count from app_settings where key like 'epic172:s4:legacy-leakage-scrub:v1:%'`
    await expect(runLegacyLeakageScrub({
      actor: 'scrub-operator', authorizationReceiptId: randomUUID(), fingerprintKey: scrubKey,
      fingerprintKeyId: scrubKeyId, mode: 'apply', operationId: `invalid-${randomUUID()}`,
    }, { database: adapter, redis })).rejects.toThrow('fixed S4 producers-disabled drain contract')
    const afterInvalid = await admin<{ count: number }[]>`select count(*)::integer as count from app_settings where key like 'epic172:s4:legacy-leakage-scrub:v1:%'`
    expect(afterInvalid[0].count).toBe(before[0].count)

    // Real row-CAS and checkpoint-token conflicts: neither may overwrite a concurrent value.
    const [casLog] = await admin<{ id: string; message: string; frontMatter: Record<string, unknown>; metadata: Record<string, unknown> }[]>`
      select id::text as id, message, front_matter as "frontMatter", metadata
      from task_logs where task_id = ${ids.task}::uuid order by sequence desc limit 1`
    const casRow: LegacyLeakageScrubRow = { id: casLog.id, kind: 'task_log', message: casLog.message, frontMatter: casLog.frontMatter, metadata: casLog.metadata }
    const rowCasOperationId = `row-cas-${randomUUID()}`
    scrubOperationIds.add(rowCasOperationId)
    const casCheckpoint = await adapter.createCheckpoint(await checkpointFor(rowCasOperationId))
    expect(casCheckpoint).not.toBeNull()
    await admin`update task_logs set message = 'CONCURRENT-ROW-VALUE' where id = ${casRow.id}::uuid`
    const rowConflict = await adapter.commitRow({
      current: casCheckpoint!, expectedRowFingerprint: legacyLeakageRowFingerprint(casRow, scrubKey),
      nextCheckpoint: { ...casCheckpoint!.checkpoint, lastKey: casRow.id, rowsExamined: 1, databaseTime: await adapter.databaseTime() },
      row: sanitizeLegacyLeakageRow(casRow),
    })
    expect(rowConflict).toBe('row_conflict')
    const [rowAfterConflict] = await admin<{ message: string }[]>`select message from task_logs where id = ${casRow.id}::uuid`
    expect(rowAfterConflict.message).toBe('CONCURRENT-ROW-VALUE')
    const [checkpointAfterRowConflict] = await admin<{ value: string }[]>`
      select value from app_settings where key = ${checkpointKey(rowCasOperationId)}`
    expect(checkpointAfterRowConflict.value).toBe(casCheckpoint!.token)

    const checkpointCasOperationId = `checkpoint-cas-${randomUUID()}`
    scrubOperationIds.add(checkpointCasOperationId)
    const tokenCheckpoint = await adapter.createCheckpoint(await checkpointFor(checkpointCasOperationId))
    expect(tokenCheckpoint).not.toBeNull()
    const advanced = await adapter.compareAndSetCheckpoint(tokenCheckpoint!, {
      ...tokenCheckpoint!.checkpoint, databaseTime: await adapter.databaseTime(),
    })
    expect(advanced).not.toBeNull()
    const externallyAdvancedCheckpointBytes = advanced!.token
    const tokenConflict = await adapter.commitRow({
      current: tokenCheckpoint!, expectedRowFingerprint: legacyLeakageRowFingerprint({ ...casRow, message: 'CONCURRENT-ROW-VALUE' }, scrubKey),
      nextCheckpoint: { ...tokenCheckpoint!.checkpoint, lastKey: casRow.id, rowsExamined: 1, databaseTime: await adapter.databaseTime() },
      row: sanitizeLegacyLeakageRow({ ...casRow, message: 'CONCURRENT-ROW-VALUE' }),
    })
    expect(tokenConflict).toBe('checkpoint_conflict')
    const [rowAfterTokenConflict] = await admin<{ message: string }[]>`select message from task_logs where id = ${casRow.id}::uuid`
    expect(rowAfterTokenConflict.message).toBe('CONCURRENT-ROW-VALUE')
    const [checkpointAfterTokenConflict] = await admin<{ value: string }[]>`
      select value from app_settings where key = ${checkpointKey(checkpointCasOperationId)}`
    expect(checkpointAfterTokenConflict.value).toBe(externallyAdvancedCheckpointBytes)

    const operationId = `pg-scrub-${randomUUID()}`
    scrubOperationIds.add(operationId)
    const applied = await runLegacyLeakageScrub({
      actor: 'scrub-operator', authorizationReceiptId: ids.disabledReceipt, fingerprintKey: scrubKey,
      fingerprintKeyId: scrubKeyId, mode: 'apply', operationId, batchSize: 1_000, maxBatches: 1_000,
    }, { database: adapter, redis })
    expect(applied.checkpoint?.state).toBe('complete')
    const [scrubbed] = await admin<{ message: string; metadata: Record<string, unknown> }[]>`
      select message, metadata from task_logs where task_id = ${ids.task}::uuid order by sequence desc limit 1`
    expect(scrubbed.message).toBe('legacy_task_log_unavailable')
    expect(JSON.stringify(scrubbed.metadata)).not.toContain('RAW-SCRUB')

    // A complete replay reads the persisted checkpoint and cannot re-scrub or double-count rows.
    const replay = await runLegacyLeakageScrub({
      actor: 'scrub-operator', authorizationReceiptId: ids.disabledReceipt, fingerprintKey: scrubKey,
      fingerprintKeyId: scrubKeyId, mode: 'resume', operationId, batchSize: 1_000, maxBatches: 1_000,
    }, { database: adapter, redis })
    expect(replay.checkpoint).toEqual(applied.checkpoint)

    await admin`update task_logs set message = 'RAW-REAPPEARED-SENTINEL' where task_id = ${ids.task}::uuid`
    await expect(runLegacyLeakageScrub({
      actor: 'scrub-operator', authorizationReceiptId: ids.disabledReceipt, fingerprintKey: scrubKey,
      fingerprintKeyId: scrubKeyId, mode: 'resume', operationId, batchSize: 1_000, maxBatches: 1_000,
    }, { database: adapter, redis })).rejects.toThrow('database or Redis leakage reappeared')
    await admin`delete from task_logs where task_id = ${ids.task}::uuid`
    console.info('S4_SCRUB_POSTGRES_AUTH_CAS_RESUME_OK')
  })

  it('S4_SCRUB_POSTGRES_ARTIFACT_LINK_RACE: post-lock reload refuses a newly protected artifact', async () => {
    await prepareScrubFixture()
    const adapterUrl = new URL(adminUrl!)
    adapterUrl.searchParams.set('application_name', `s4-scrub-race-${randomUUID()}`)
    const scrubSql = postgres(adapterUrl.toString(), { max: 1, onnotice: () => {} })
    const adapter = createLegacyLeakagePostgresAdapter(scrubSql, scrubKey)
    const artifactId = randomUUID()
    await admin`insert into artifacts (id, agent_run_id, artifact_type, content, metadata)
      values (${artifactId}::uuid, ${ids.run}::uuid, 'adr_text', 'LEGACY-ADR-RACE-SENTINEL', '{"legacy":true}'::jsonb)`
    const artifactRaceOperationId = `artifact-race-${randomUUID()}`
    scrubOperationIds.add(artifactRaceOperationId)
    const checkpoint = await adapter.createCheckpoint({
      schemaVersion: 2, operationId: artifactRaceOperationId, actor: 'scrub-operator', authorizationReceiptId: ids.disabledReceipt,
      fingerprintKeyId: scrubKeyId, sentinelSetFingerprint: 'a'.repeat(64), phase: 'artifacts', state: 'running',
      lastKey: null, rowsExamined: 0, rowsChanged: 0, conflicts: 0, redisKeysExamined: 0, redisKeysDeleted: 0,
      redisV2ValuesExamined: 0, lastPreFingerprint: null, lastPostFingerprint: null, databaseTime: await adapter.databaseTime(),
    })
    expect(checkpoint).not.toBeNull()
    const scanned = await adapter.scanRows('artifacts', null, 10_000)
    const source = scanned.find((row) => row.id === artifactId)
    expect(source).toEqual({
      id: artifactId,
      kind: 'artifact',
      content: 'LEGACY-ADR-RACE-SENTINEL',
      metadata: { legacy: true },
      replaceContent: true,
    })
    if (!source) throw new Error('S4 scrub artifact race fixture was not returned by the production artifacts scanner.')
    const linkerUrl = new URL(adminUrl!)
    linkerUrl.searchParams.set('application_name', `s4-artifact-linker-${randomUUID()}`)
    const linker = postgres(linkerUrl.toString(), { max: 1, onnotice: () => {} })
    const [scrubBackend] = await scrubSql<{ pid: number }[]>`select pg_backend_pid() as pid`
    const [linkerBackend] = await linker<{ pid: number }[]>`select pg_backend_pid() as pid`
    let releaseLinker!: () => void
    const linkerRelease = new Promise<void>((resolve) => { releaseLinker = resolve })
    let linkerTransactionStarted!: () => void
    const linkerTransactionStartedPromise = new Promise<void>((resolve) => { linkerTransactionStarted = resolve })
    let linkerLocked!: () => void
    const linkerLockedPromise = new Promise<void>((resolve) => { linkerLocked = resolve })
    const linkerTransaction = linker.begin(async (tx) => {
      linkerTransactionStarted()
      await tx`select id from artifacts where id = ${artifactId}::uuid for update`
      await tx`update artifacts set content = ${ARCHITECT_PLAN_HEADER}, metadata = '{"historyAvailable":true}'::jsonb where id = ${artifactId}::uuid`
      await tx`insert into architect_plan_versions (task_id, plan_artifact_id, plan_version, digest_key_id, entry_count, entry_set_digest, structural_set_digest)
        values (${ids.task}::uuid, ${artifactId}::uuid, 1, 's4-test-key', 1, ${`hmac-sha256:${'a'.repeat(64)}`}, ${`hmac-sha256:${'b'.repeat(64)}`})`
      await tx`insert into architect_plan_entries (task_id, plan_artifact_id, plan_version, entry_id, entry_kind, content, content_digest, digest_key_id, projection_eligible)
        values (${ids.task}::uuid, ${artifactId}::uuid, 1, 'plan_body:000000', 'plan_body', 'PROTECTED-ENTRY-NEVER-READ', ${`hmac-sha256:${'c'.repeat(64)}`}, 's4-test-key', false)`
      linkerLocked()
      await linkerRelease
    })
    let commitPromise: Promise<'committed' | 'row_conflict' | 'checkpoint_conflict'> | undefined
    let linkerReleased = false
    const releaseLinkerOnce = () => {
      if (!linkerReleased) {
        linkerReleased = true
        releaseLinker()
      }
    }
    try {
      await linkerTransactionStartedPromise
      await linkerLockedPromise
      const checkpointBytesBeforeRace = checkpoint!.token
      let scrubCommitStarted!: () => void
      const scrubCommitStartedPromise = new Promise<void>((resolve) => { scrubCommitStarted = resolve })
      commitPromise = Promise.resolve().then(async () => {
        scrubCommitStarted()
        return adapter.commitRow({
          current: checkpoint!, expectedRowFingerprint: legacyLeakageRowFingerprint(source, scrubKey),
          nextCheckpoint: { ...checkpoint!.checkpoint, lastKey: artifactId, rowsExamined: 1, databaseTime: await adapter.databaseTime() },
          row: sanitizeLegacyLeakageRow(source),
        })
      })
      await scrubCommitStartedPromise
      let blockerObserved = false
      for (let attempt = 0; attempt < 40 && !blockerObserved; attempt += 1) {
        const [row] = await admin<{ pid: number; state: string; waitEventType: string | null; blockingPids: number[] }[]>`
          select pid, state, wait_event_type as "waitEventType", pg_blocking_pids(pid) as "blockingPids"
          from pg_stat_activity
          where pid = ${scrubBackend.pid}`
        blockerObserved = row?.waitEventType === 'Lock' && row.blockingPids.includes(linkerBackend.pid)
        if (!blockerObserved) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(blockerObserved).toBe(true)
      releaseLinkerOnce()
      await linkerTransaction
      await expect(commitPromise).resolves.toBe('row_conflict')
      const [checkpointAfterRace] = await admin<{ value: string }[]>`
        select value from app_settings where key = ${checkpointKey(artifactRaceOperationId)}`
      expect(checkpointAfterRace.value).toBe(checkpointBytesBeforeRace)
    } finally {
      releaseLinkerOnce()
      await Promise.allSettled([linkerTransaction, ...(commitPromise ? [commitPromise] : [])])
      await Promise.all([linker.end({ timeout: 5 }), scrubSql.end({ timeout: 5 })])
    }
    const [artifact] = await admin<{ content: string; protectedVersions: number }[]>`
      select a.content, (select count(*)::integer from architect_plan_versions where plan_artifact_id = a.id) as "protectedVersions"
      from artifacts a where a.id = ${artifactId}::uuid`
    expect(artifact).toEqual({ content: ARCHITECT_PLAN_HEADER, protectedVersions: 1 })
    console.info('S4_SCRUB_POSTGRES_ARTIFACT_LINK_RACE_OK')
  })
})
