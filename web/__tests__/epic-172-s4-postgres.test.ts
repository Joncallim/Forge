import { createHash, randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bindArchitectReplanContext,
  executableReferenceForEntry,
  recordArchitectPlanVersion,
  resolveArchitectReplanEntry,
  resolveArchitectPlanEntry,
} from '@/lib/mcps/s4-protocol-store'
import { architectReplanReferenceForEntry } from '@/lib/mcps/architect-plan-entries'
import { computeCredentialDigest } from '@/lib/session-credential-digest'
import { appendArchitectClarificationAnswer, readArchitectPlanHistory } from '@/lib/mcps/history-reader'

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

  beforeAll(async () => {
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = writerUrl!
    process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL = resolverUrl!
    process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = historyReaderUrl!
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

})
