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
  defaultBranch: text('default_branch').notNull().default('main'),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', tsOpts),
})

export type Project = InferSelectModel<typeof projects>
export type NewProject = InferInsertModel<typeof projects>

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
// agentRuns
// ---------------------------------------------------------------------------
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // 'architect'|'backend'|'frontend'|'qa'|'reviewer'|'devops'
    agentType: text('agent_type').notNull(),
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
// agentConfigs
// ---------------------------------------------------------------------------
export const agentConfigs = pgTable(
  'agent_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 'architect'|'backend'|'frontend'|'qa'|'reviewer'|'devops'
    agentType: text('agent_type').notNull().unique(),
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
  (t) => [uniqueIndex('agent_configs_agent_type_idx').on(t.agentType)],
)

export type AgentConfig = InferSelectModel<typeof agentConfigs>
export type NewAgentConfig = InferInsertModel<typeof agentConfigs>

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
