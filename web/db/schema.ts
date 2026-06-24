import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  inet,
  jsonb,
  bigint,
  customType,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'

// bytea is not in drizzle-orm/pg-core as a named export, so we declare it once
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea'
  },
})

// ---------------------------------------------------------------------------
// Timestamp helper — all timestamps are timezone-aware
// ---------------------------------------------------------------------------
const tsOpts = { mode: 'date' as const, withTimezone: true }

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', tsOpts),
})

export type User = InferSelectModel<typeof users>
export type NewUser = InferInsertModel<typeof users>

// ---------------------------------------------------------------------------
// credentials  (WebAuthn)
// ---------------------------------------------------------------------------
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    deviceType: text('device_type').notNull(), // 'singleDevice' | 'multiDevice'
    backedUp: boolean('backed_up').notNull().default(false),
    transports: text('transports').array(),
    aaguid: text('aaguid'),
    friendlyName: text('friendly_name'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', tsOpts),
  },
  (t) => [
    index('credentials_user_id_idx').on(t.userId),
    uniqueIndex('credentials_credential_id_idx').on(t.credentialId),
  ],
)

export type Credential = InferSelectModel<typeof credentials>
export type NewCredential = InferInsertModel<typeof credentials>

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(), // same UUID in Redis + cookie
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id').references(() => credentials.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', tsOpts).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', tsOpts),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_revoked_at_idx').on(t.revokedAt),
  ],
)

export type Session = InferSelectModel<typeof sessions>
export type NewSession = InferInsertModel<typeof sessions>

// ---------------------------------------------------------------------------
// providerConfigs
// ---------------------------------------------------------------------------
export const providerConfigs = pgTable(
  'provider_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    providerType: text('provider_type').notNull(), // see lib/providers/types.ts
    modelId: text('model_id').notNull(),
    baseUrl: text('base_url'), // required for custom, ollama, and litellm
    apiKeyEnvVar: text('api_key_env_var'), // optional fallback: env var NAME only, never the secret
    apiKeyCiphertext: text('api_key_ciphertext'), // AES-256-GCM key entered via the UI (see lib/crypto.ts)
    isLocal: boolean('is_local').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('provider_configs_provider_type_idx').on(t.providerType),
    index('provider_configs_is_active_idx').on(t.isActive),
  ],
)

export type ProviderConfig = InferSelectModel<typeof providerConfigs>
export type NewProviderConfig = InferInsertModel<typeof providerConfigs>

// ---------------------------------------------------------------------------
// providerHealthChecks
// ---------------------------------------------------------------------------
export const providerHealthChecks = pgTable(
  'provider_health_checks',
  {
    providerConfigId: uuid('provider_config_id')
      .primaryKey()
      .references(() => providerConfigs.id, { onDelete: 'cascade' }),
    reachable: boolean('reachable').notNull().default(false),
    envVarPresent: boolean('env_var_present').notNull().default(false),
    latencyMs: integer('latency_ms'),
    error: text('error'),
    checkedAt: timestamp('checked_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('provider_health_checks_checked_at_idx').on(t.checkedAt),
  ],
)

export type ProviderHealthCheck = InferSelectModel<typeof providerHealthChecks>
export type NewProviderHealthCheck = InferInsertModel<typeof providerHealthChecks>

export type ProjectMcpConfig = {
  profile: 'default' | 'custom'
  requiredMcps: string[]
  overrides: Record<string, { enabled?: boolean; installPath?: string }>
}

export const DEFAULT_PROJECT_MCP_CONFIG: ProjectMcpConfig = {
  profile: 'default',
  requiredMcps: ['filesystem', 'github'],
  overrides: {},
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  githubRepo: text('github_repo'), // 'owner/repo'
  localPath: text('local_path'),
  githubTokenEnvVar: text('github_token_env_var'),
  pmProviderConfigId: uuid('pm_provider_config_id').references(
    () => providerConfigs.id,
    { onDelete: 'set null' },
  ),
  mcpConfig: jsonb('mcp_config')
    .$type<ProjectMcpConfig>()
    .notNull()
    .default(sql`'{"profile":"default","requiredMcps":["filesystem","github"],"overrides":{}}'::jsonb`),
  defaultBranch: text('default_branch').notNull().default('main'),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', tsOpts),
})

export type Project = InferSelectModel<typeof projects>
export type NewProject = InferInsertModel<typeof projects>

// ---------------------------------------------------------------------------
// mcpInstallations
// ---------------------------------------------------------------------------
export const mcpInstallations = pgTable(
  'mcp_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mcpId: text('mcp_id').notNull(),
    installPath: text('install_path').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    source: text('source').notNull().default('catalog'),
    metadata: jsonb('metadata'),
    installedAt: timestamp('installed_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('mcp_installations_mcp_id_idx').on(t.mcpId),
    index('mcp_installations_enabled_idx').on(t.enabled),
  ],
)

export type McpInstallation = InferSelectModel<typeof mcpInstallations>
export type NewMcpInstallation = InferInsertModel<typeof mcpInstallations>

// ---------------------------------------------------------------------------
// projectMcpStatusChecks
// ---------------------------------------------------------------------------
export const projectMcpStatusChecks = pgTable(
  'project_mcp_status_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mcpId: text('mcp_id').notNull(),
    status: text('status').notNull(),
    installState: text('install_state').notNull(),
    error: text('error'),
    details: jsonb('details'),
    checkedAt: timestamp('checked_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('project_mcp_status_project_mcp_idx').on(t.projectId, t.mcpId),
    index('project_mcp_status_project_id_idx').on(t.projectId),
    index('project_mcp_status_mcp_id_idx').on(t.mcpId),
    index('project_mcp_status_checked_at_idx').on(t.checkedAt),
  ],
)

export type ProjectMcpStatusCheck = InferSelectModel<typeof projectMcpStatusChecks>
export type NewProjectMcpStatusCheck = InferInsertModel<typeof projectMcpStatusChecks>

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    submittedBy: uuid('submitted_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    // 'pending'|'running'|'awaiting_answers'|'awaiting_approval'|'approved'|'rejected'|'completed'|'failed'|'cancelled'
    status: text('status').notNull().default('pending'),
    pmProviderConfigId: uuid('pm_provider_config_id').references(
      () => providerConfigs.id,
      { onDelete: 'set null' },
    ),
    githubBranch: text('github_branch'),
    githubPrUrl: text('github_pr_url'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
    completedAt: timestamp('completed_at', tsOpts),
  },
  (t) => [
    index('tasks_project_id_status_idx').on(t.projectId, t.status),
    index('tasks_submitted_by_idx').on(t.submittedBy),
    index('tasks_created_at_desc_idx').on(t.createdAt),
  ],
)

export type Task = InferSelectModel<typeof tasks>
export type NewTask = InferInsertModel<typeof tasks>

// ---------------------------------------------------------------------------
// taskAttempts
// ---------------------------------------------------------------------------
export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    queueName: text('queue_name').notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    // 'running'|'completed'|'failed'|'dead_lettered'
    status: text('status').notNull().default('running'),
    workerId: text('worker_id'),
    jobPayload: jsonb('job_payload'),
    errorMessage: text('error_message'),
    claimedAt: timestamp('claimed_at', tsOpts).defaultNow().notNull(),
    startedAt: timestamp('started_at', tsOpts),
    completedAt: timestamp('completed_at', tsOpts),
    nextRetryAt: timestamp('next_retry_at', tsOpts),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('task_attempts_task_id_created_at_idx').on(t.taskId, t.createdAt),
    index('task_attempts_status_idx').on(t.status),
    index('task_attempts_queue_name_idx').on(t.queueName),
  ],
)

export type TaskAttempt = InferSelectModel<typeof taskAttempts>
export type NewTaskAttempt = InferInsertModel<typeof taskAttempts>

// ---------------------------------------------------------------------------
// agentHarnesses
// ---------------------------------------------------------------------------
export const agentHarnesses = pgTable(
  'agent_harnesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    role: text('role').notNull(),
    displayName: text('display_name').notNull(),
    category: text('category').notNull().default('general'),
    description: text('description').notNull().default(''),
    systemPrompt: text('system_prompt').notNull().default(''),
    toolPolicy: jsonb('tool_policy')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    referencePaths: jsonb('reference_paths')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    outputSchema: jsonb('output_schema')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    validationChecks: jsonb('validation_checks')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    defaultProviderConfigId: uuid('default_provider_config_id').references(
      () => providerConfigs.id,
      { onDelete: 'set null' },
    ),
    isActive: boolean('is_active').notNull().default(true),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('agent_harnesses_slug_idx').on(t.slug),
    index('agent_harnesses_role_idx').on(t.role),
    index('agent_harnesses_category_idx').on(t.category),
    index('agent_harnesses_is_active_idx').on(t.isActive),
  ],
)

export type AgentHarness = InferSelectModel<typeof agentHarnesses>
export type NewAgentHarness = InferInsertModel<typeof agentHarnesses>

// ---------------------------------------------------------------------------
// workPackages
// ---------------------------------------------------------------------------
export const workPackages = pgTable(
  'work_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    harnessId: uuid('harness_id').references(() => agentHarnesses.id, {
      onDelete: 'set null',
    }),
    assignedRole: text('assigned_role').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    // 'pending'|'ready'|'running'|'awaiting_approval'|'completed'|'failed'|'cancelled'
    status: text('status').notNull().default('pending'),
    sequence: integer('sequence').notNull(),
    steps: jsonb('steps').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    requiredCapabilities: jsonb('required_capabilities')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    acceptanceCriteria: jsonb('acceptance_criteria')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    mcpRequirements: jsonb('mcp_requirements')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    blockedReason: text('blocked_reason'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('work_packages_task_sequence_idx').on(t.taskId, t.sequence),
    index('work_packages_task_id_status_idx').on(t.taskId, t.status),
    index('work_packages_harness_id_idx').on(t.harnessId),
    index('work_packages_assigned_role_idx').on(t.assignedRole),
  ],
)

export type WorkPackage = InferSelectModel<typeof workPackages>
export type NewWorkPackage = InferInsertModel<typeof workPackages>

// ---------------------------------------------------------------------------
// workPackageDependencies
// ---------------------------------------------------------------------------
export const workPackageDependencies = pgTable(
  'work_package_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workPackageId: uuid('work_package_id')
      .notNull()
      .references(() => workPackages.id, { onDelete: 'cascade' }),
    dependsOnWorkPackageId: uuid('depends_on_work_package_id')
      .notNull()
      .references(() => workPackages.id, { onDelete: 'cascade' }),
    dependencyType: text('dependency_type').notNull().default('finish_to_start'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('work_package_dependencies_unique_idx').on(
      t.workPackageId,
      t.dependsOnWorkPackageId,
    ),
    index('work_package_dependencies_work_package_id_idx').on(t.workPackageId),
    index('work_package_dependencies_depends_on_idx').on(t.dependsOnWorkPackageId),
  ],
)

export type WorkPackageDependency = InferSelectModel<typeof workPackageDependencies>
export type NewWorkPackageDependency = InferInsertModel<typeof workPackageDependencies>

// ---------------------------------------------------------------------------
// agentRuns
// ---------------------------------------------------------------------------
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'set null',
    }),
    harnessId: uuid('harness_id').references(() => agentHarnesses.id, {
      onDelete: 'set null',
    }),
    // 'architect'|'backend'|'frontend'|'qa'|'reviewer'|'devops'
    agentType: text('agent_type').notNull(),
    stage: text('stage'),
    attemptNumber: integer('attempt_number'),
    providerConfigId: uuid('provider_config_id').references(
      () => providerConfigs.id,
      { onDelete: 'set null' },
    ),
    modelIdUsed: text('model_id_used').notNull(), // snapshot at run time
    // 'pending'|'running'|'completed'|'failed'
    status: text('status').notNull().default('pending'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }), // null for local models
    startedAt: timestamp('started_at', tsOpts),
    completedAt: timestamp('completed_at', tsOpts),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('agent_runs_task_id_created_at_idx').on(t.taskId, t.createdAt),
    index('agent_runs_work_package_id_idx').on(t.workPackageId),
    index('agent_runs_harness_id_idx').on(t.harnessId),
    index('agent_runs_stage_idx').on(t.stage),
    index('agent_runs_agent_type_status_idx').on(t.agentType, t.status),
  ],
)

export type AgentRun = InferSelectModel<typeof agentRuns>
export type NewAgentRun = InferInsertModel<typeof agentRuns>

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    // 'pr_url'|'file_diff'|'adr_text'|'test_report'|'review_finding'|'log_output'
    artifactType: text('artifact_type').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('artifacts_agent_run_id_idx').on(t.agentRunId),
    index('artifacts_artifact_type_idx').on(t.artifactType),
  ],
)

export type Artifact = InferSelectModel<typeof artifacts>
export type NewArtifact = InferInsertModel<typeof artifacts>

// ---------------------------------------------------------------------------
// approvalGates
// ---------------------------------------------------------------------------
export const approvalGates = pgTable(
  'approval_gates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'set null',
    }),
    gateType: text('gate_type').notNull(),
    // 'pending'|'approved'|'rejected'|'cancelled'
    status: text('status').notNull().default('pending'),
    sourceAgentRunId: uuid('source_agent_run_id').references(() => agentRuns.id, {
      onDelete: 'set null',
    }),
    sourceArtifactId: uuid('source_artifact_id').references(() => artifacts.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    instructions: text('instructions').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    decidedAt: timestamp('decided_at', tsOpts),
    decidedBy: uuid('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('approval_gates_task_gate_artifact_idx').on(
      t.taskId,
      t.gateType,
      t.sourceArtifactId,
    ),
    index('approval_gates_task_id_status_idx').on(t.taskId, t.status),
    index('approval_gates_work_package_id_idx').on(t.workPackageId),
    index('approval_gates_source_agent_run_id_idx').on(t.sourceAgentRunId),
  ],
)

export type ApprovalGate = InferSelectModel<typeof approvalGates>
export type NewApprovalGate = InferInsertModel<typeof approvalGates>

// ---------------------------------------------------------------------------
// vcsChanges
// ---------------------------------------------------------------------------
export const vcsChanges = pgTable(
  'vcs_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'set null',
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'set null',
    }),
    changeType: text('change_type').notNull().default('branch'),
    // 'planned'|'created'|'updated'|'submitted'|'merged'|'abandoned'|'failed'
    status: text('status').notNull().default('planned'),
    repository: text('repository'),
    branchName: text('branch_name'),
    baseBranch: text('base_branch'),
    commitSha: text('commit_sha'),
    pullRequestUrl: text('pull_request_url'),
    diffSummary: text('diff_summary'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('vcs_changes_task_id_status_idx').on(t.taskId, t.status),
    index('vcs_changes_work_package_id_idx').on(t.workPackageId),
    index('vcs_changes_agent_run_id_idx').on(t.agentRunId),
    index('vcs_changes_pull_request_url_idx').on(t.pullRequestUrl),
  ],
)

export type VcsChange = InferSelectModel<typeof vcsChanges>
export type NewVcsChange = InferInsertModel<typeof vcsChanges>

// ---------------------------------------------------------------------------
// agentConfigs
// ---------------------------------------------------------------------------
export const agentConfigs = pgTable(
  'agent_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable slug, such as 'architect', 'backend', or a user-defined specialist.
    agentType: text('agent_type').notNull().unique(),
    displayName: text('display_name').notNull().default(''),
    description: text('description').notNull().default(''),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    providerConfigId: uuid('provider_config_id').references(
      () => providerConfigs.id,
      { onDelete: 'set null' },
    ),
    systemPrompt: text('system_prompt').notNull(),
    frontmatterOverrides: jsonb('frontmatter_overrides'),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('agent_configs_agent_type_idx').on(t.agentType),
    index('agent_configs_is_active_idx').on(t.isActive),
  ],
)

export type AgentConfig = InferSelectModel<typeof agentConfigs>
export type NewAgentConfig = InferInsertModel<typeof agentConfigs>

// ---------------------------------------------------------------------------
// workforces
// ---------------------------------------------------------------------------
export const workforces = pgTable(
  'workforces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull().default(''),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('workforces_slug_idx').on(t.slug),
    index('workforces_is_active_idx').on(t.isActive),
    index('workforces_is_default_idx').on(t.isDefault),
  ],
)

export type Workforce = InferSelectModel<typeof workforces>
export type NewWorkforce = InferInsertModel<typeof workforces>

// ---------------------------------------------------------------------------
// workforceAgents
// ---------------------------------------------------------------------------
export const workforceAgents = pgTable(
  'workforce_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workforceId: uuid('workforce_id')
      .notNull()
      .references(() => workforces.id, { onDelete: 'cascade' }),
    agentConfigId: uuid('agent_config_id')
      .notNull()
      .references(() => agentConfigs.id, { onDelete: 'cascade' }),
    roleLabel: text('role_label'),
    sequence: integer('sequence').notNull().default(1),
    isRequired: boolean('is_required').notNull().default(true),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('workforce_agents_workforce_agent_idx').on(t.workforceId, t.agentConfigId),
    index('workforce_agents_workforce_sequence_idx').on(t.workforceId, t.sequence),
    index('workforce_agents_agent_config_id_idx').on(t.agentConfigId),
  ],
)

export type WorkforceAgent = InferSelectModel<typeof workforceAgents>
export type NewWorkforceAgent = InferInsertModel<typeof workforceAgents>

// ---------------------------------------------------------------------------
// appSettings — generic key/value store for app-wide settings and secrets.
// Used for the GitHub Personal Access Token (stored encrypted via lib/crypto.ts).
// ---------------------------------------------------------------------------
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
})

export type AppSetting = InferSelectModel<typeof appSettings>
export type NewAppSetting = InferInsertModel<typeof appSettings>

// ---------------------------------------------------------------------------
// taskQuestions
// ---------------------------------------------------------------------------
export const taskQuestions = pgTable(
  'task_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    suggestions: jsonb('suggestions').$type<string[]>().notNull().default([]),
    answer: text('answer'),
    // 'open'|'answered'
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    answeredAt: timestamp('answered_at', tsOpts),
    answeredBy: uuid('answered_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('task_questions_task_id_idx').on(t.taskId),
    index('task_questions_task_id_status_idx').on(t.taskId, t.status),
  ],
)

export type TaskQuestion = InferSelectModel<typeof taskQuestions>
export type NewTaskQuestion = InferInsertModel<typeof taskQuestions>
