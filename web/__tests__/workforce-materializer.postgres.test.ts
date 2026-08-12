import { randomUUID } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { prepareArchitectArtifact } from '@/worker/architect-artifact'
import { materializeWorkforceFromArchitectArtifact } from '@/worker/workforce-materializer'
import { computeReadyWorkPackageIds } from '@/worker/work-package-handoff'

const required = process.env.FORGE_WORKFORCE_MATERIALIZER_REQUIRE_POSTGRES_TEST === '1'
const databaseUrl = process.env.DATABASE_URL?.trim()
const adminUrl = process.env.FORGE_WORKFORCE_MATERIALIZER_POSTGRES_ADMIN_TEST_URL?.trim()
const enabled = required && Boolean(databaseUrl && adminUrl)

if (required && (!databaseUrl || !adminUrl)) {
  throw new Error(
    'FORGE_WORKFORCE_MATERIALIZER_REQUIRE_POSTGRES_TEST=1 requires DATABASE_URL and FORGE_WORKFORCE_MATERIALIZER_POSTGRES_ADMIN_TEST_URL for the disposable PostgreSQL materializer proof; the mandatory suite may not skip.',
  )
}

function planText(roles: Array<{ role: string; reviewRequirement: string }>): string {
  return [
    '# Plan',
    ...roles.map((agent) => `- [${agent.role}] ${agent.role} work`),
    '',
    '```agent_breakdown_json',
    JSON.stringify({
      agents: roles.map((agent) => ({
        role: agent.role,
        tasks: 1,
        summary: `${agent.role} work`,
        steps: [`Complete ${agent.role} work`],
        reviewRequirement: agent.reviewRequirement,
      })),
    }),
    '```',
    '',
    '```capability_classification_json',
    JSON.stringify({
      schemaVersion: 1,
      required: ['business-logic'],
      optional: [],
      excluded: [],
    }),
    '```',
    '',
    '```mcp_execution_design_json',
    JSON.stringify({
      schemaVersion: 1,
      requirements: [],
      promptOverlays: {},
      requirementContexts: [],
      mcpAwareSubtasks: [],
    }),
    '```',
    '',
    '```open_questions_json',
    JSON.stringify({ questions: [] }),
    '```',
  ].join('\n')
}

const OVERVIEW = {
  projectId: 'project-1',
  config: { profile: 'default', requiredMcps: [], overrides: {} },
  catalog: [],
  mcpsRoot: '/tmp/mcps',
  statuses: [],
  summary: { label: 'Unavailable', status: 'missing', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
}

describe.skipIf(!enabled)('workforce materializer replan supersession', () => {
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    artifact: randomUUID(),
  }

  let sql: ReturnType<typeof postgres>
  let adminSql: ReturnType<typeof postgres>
  const suffix = randomUUID().slice(0, 8)
  // The materializer only wires QA-after-implementation and reviewer-after-QA
  // dependencies for the exact canonical roles, so the fixture uses those
  // agent types. Display names are namespaced so repeated runs can clean up
  // only their own rows (agent_type is unique per config).
  const agentCatalog = {
    backend: { agentType: 'backend', displayName: `FM proof Backend ${suffix}` },
    qa: { agentType: 'qa', displayName: `FM proof QA ${suffix}` },
    reviewer: { agentType: 'reviewer', displayName: `FM proof Reviewer ${suffix}` },
  }

  beforeAll(async () => {
    sql = postgres(databaseUrl!, { max: 2, onnotice: () => {} })
    adminSql = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    await adminSql.begin(async (tx) => {
      await tx`
        delete from agent_configs
        where display_name like 'FM proof %'
           or agent_type in ('backend', 'qa', 'reviewer')
      `
      await tx`
        insert into users (id, display_name)
        values (${ids.user}::uuid, 'Materializer replan proof')
      `
      await tx`
        insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
        values (${ids.project}::uuid, 'Materializer replan proof', ${ids.user}::uuid, 1, 1)
      `
      await tx`
        insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (
          ${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid,
          'Materializer replan proof', 'Bounded disposable test fixture', 'running'
        )
      `
      await tx`
        insert into agent_runs (id, task_id, agent_type, model_id_used, status)
        values (${ids.run}::uuid, ${ids.task}::uuid, 'architect', 'materializer-proof', 'completed')
      `
      await tx`
        insert into artifacts (id, agent_run_id, artifact_type, content)
        values (${ids.artifact}::uuid, ${ids.run}::uuid, 'adr_text', '# Plan artifact')
      `
      await tx`
        insert into agent_configs (agent_type, display_name, is_active, is_system, system_prompt)
        values
          (${agentCatalog.backend.agentType}, ${agentCatalog.backend.displayName}, true, true, ''),
          (${agentCatalog.qa.agentType}, ${agentCatalog.qa.displayName}, true, true, ''),
          (${agentCatalog.reviewer.agentType}, ${agentCatalog.reviewer.displayName}, true, true, '')
      `
    })
  })

  afterAll(async () => {
    await Promise.all([
      sql?.end({ timeout: 5 }),
      adminSql?.end({ timeout: 5 }),
    ])
  })

  it('supersedes the previous pending wave instead of deleting it, and renumbers the new wave', async () => {
    const first = await materializeWorkforceFromArchitectArtifact({
      taskId: ids.task,
      architectRunId: ids.run,
      artifactId: ids.artifact,
      planVersion: '1',
      prepared: prepareArchitectArtifact(
        planText([
          { role: agentCatalog.backend.displayName, reviewRequirement: 'both' },
          { role: agentCatalog.qa.displayName, reviewRequirement: 'none' },
          { role: agentCatalog.reviewer.displayName, reviewRequirement: 'none' },
        ]),
        OVERVIEW,
      ),
    })
    expect(first).toMatchObject({ status: 'materialized', workPackageCount: 3, dependencyCount: 2 })

    const [waveOne] = await sql<Array<{ id: string; sequence: number; status: string }>>`
      select id, sequence, status
      from work_packages
      where task_id = ${ids.task}::uuid
      order by sequence
    `
    expect(waveOne).toEqual({
      id: expect.any(String),
      sequence: 1,
      status: 'pending',
    })
    const [headCount] = await adminSql<Array<{ count: number }>>`
      select count(*)::int as count
      from work_package_local_projection_heads
      where task_id = ${ids.task}::uuid
    `
    expect(headCount).toEqual({ count: 24 })

    // Replan: a new plan wave must replace the pending wave. This previously
    // deleted the pending packages, which the immutable projection heads (and
    // dependency rows) reject with foreign-key violations, failing the task.
    const second = await materializeWorkforceFromArchitectArtifact({
      taskId: ids.task,
      architectRunId: ids.run,
      artifactId: ids.artifact,
      planVersion: '2',
      prepared: prepareArchitectArtifact(
        planText([
          { role: agentCatalog.backend.displayName, reviewRequirement: 'both' },
          { role: agentCatalog.qa.displayName, reviewRequirement: 'none' },
        ]),
        OVERVIEW,
      ),
    })
    expect(second).toMatchObject({ status: 'materialized', workPackageCount: 2, dependencyCount: 1 })

    const rows = await sql<Array<{ id: string; sequence: number; status: string; metadata: Record<string, unknown> }>>`
      select id, sequence, status, metadata
      from work_packages
      where task_id = ${ids.task}::uuid
      order by sequence
    `
    expect(rows).toHaveLength(5)
    const [supersededBackend, supersededQa, supersededReviewer, replanBackend, replanQa] = rows
    expect(supersededBackend).toMatchObject({ sequence: 1, status: 'cancelled' })
    expect(supersededQa).toMatchObject({ sequence: 2, status: 'cancelled' })
    expect(supersededReviewer).toMatchObject({ sequence: 3, status: 'cancelled' })
    expect(supersededBackend.metadata).toMatchObject({ supersededByPlanRevision: true })
    expect(replanBackend).toMatchObject({ sequence: 4, status: 'pending' })
    expect(replanQa).toMatchObject({ sequence: 5, status: 'pending' })

    const [headCountAfterReplan] = await adminSql<Array<{ count: number }>>`
      select count(*)::int as count
      from work_package_local_projection_heads
      where task_id = ${ids.task}::uuid
    `
    expect(headCountAfterReplan).toEqual({ count: 40 })

    // Handoff readiness must ignore the cancelled superseded wave.
    const ready = computeReadyWorkPackageIds(
      rows.map((row) => ({
        id: row.id,
        assignedRole: 'backend',
        blockedReason: null,
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: row.metadata,
        reviewRequirement: 'both',
        sequence: row.sequence,
        status: row.status,
        title: 'Package',
        updatedAt: new Date(),
      })),
      [],
    )
    expect(ready).toEqual([replanBackend.id, replanQa.id])
  })
})
