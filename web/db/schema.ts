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
  check,
  foreignKey,
  index,
  primaryKey,
  unique,
  uniqueIndex,
  type AnyPgColumn,
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
    id: uuid('id').primaryKey().defaultRandom(),
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
    credentialDigestV1: bytea('credential_digest_v1'),
    expiresAt: timestamp('expires_at', tsOpts),
    credentialStorageVersion: integer('credential_storage_version').notNull().default(0),
    legacyRedisPurgePendingAt: timestamp('legacy_redis_purge_pending_at', tsOpts),
    legacyRedisInvalidatedAt: timestamp('legacy_redis_invalidated_at', tsOpts),
    cachePurgePendingAt: timestamp('cache_purge_pending_at', tsOpts),
    cachePurgeCredentialDigestV1: bytea('cache_purge_credential_digest_v1'),
    cachePurgeGeneration: uuid('cache_purge_generation'),
    cachePurgeClaimToken: uuid('cache_purge_claim_token'),
    cachePurgeClaimExpiresAt: timestamp('cache_purge_claim_expires_at', tsOpts),
    cachePurgeAttemptCount: integer('cache_purge_attempt_count').notNull().default(0),
    cachePurgeNextAttemptAt: timestamp('cache_purge_next_attempt_at', tsOpts),
    cachePurgeCompletedAt: timestamp('cache_purge_completed_at', tsOpts),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_revoked_at_idx').on(t.revokedAt),
    uniqueIndex('sessions_credential_digest_v1_idx')
      .on(t.credentialDigestV1)
      .where(sql`${t.credentialDigestV1} is not null`),
    index('sessions_cache_purge_due_idx')
      .on(t.cachePurgeNextAttemptAt, t.cachePurgePendingAt, t.id)
      .where(sql`${t.cachePurgePendingAt} is not null`),
    check('sessions_cache_purge_state_chk', sql`
      ${t.cachePurgeAttemptCount} >= 0
      and (
        (${t.cachePurgePendingAt} is null
          and ${t.cachePurgeCredentialDigestV1} is null
          and ${t.cachePurgeGeneration} is null
          and ${t.cachePurgeClaimToken} is null
          and ${t.cachePurgeClaimExpiresAt} is null
          and ${t.cachePurgeNextAttemptAt} is null
          and ${t.cachePurgeCompletedAt} is null)
        or
        (${t.cachePurgePendingAt} is not null
          and ${t.cachePurgeCredentialDigestV1} is not null
          and octet_length(${t.cachePurgeCredentialDigestV1}) = 32
          and ${t.cachePurgeGeneration} is not null
          and ${t.cachePurgeCompletedAt} is null)
        or
        (${t.cachePurgePendingAt} is null
          and ${t.cachePurgeCredentialDigestV1} is null
          and ${t.cachePurgeGeneration} is not null
          and ${t.cachePurgeClaimToken} is null
          and ${t.cachePurgeClaimExpiresAt} is null
          and ${t.cachePurgeNextAttemptAt} is null
          and ${t.cachePurgeCompletedAt} is not null)
      )
    `),
  ],
)

export type Session = InferSelectModel<typeof sessions>
export type NewSession = InferInsertModel<typeof sessions>

export const sessionCredentialReconciliation = pgTable('session_credential_reconciliation', {
  singleton: boolean('singleton').primaryKey().default(true),
  state: text('state').notNull().default('expansion'),
  rowsMigrated: bigint('rows_migrated', { mode: 'bigint' }).notNull().default(sql`0`),
  rowsRevoked: bigint('rows_revoked', { mode: 'bigint' }).notNull().default(sql`0`),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
})

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
    // Fine-grained readiness state. See lib/providers/health.ts for the enum.
    // `reachable` above is kept for wire/back-compat and is derived from this.
    status: text('status').notNull().default('unreachable'),
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
  grants?: Record<string, unknown>
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
  // The user who created the project. Nullable only so the migration can add
  // the column safely; pre-existing rows are backfilled to the oldest user so
  // upgraded installs keep deterministic ownership without shared null access.
  submittedBy: uuid('submitted_by').references(() => users.id, {
    onDelete: 'set null',
  }),
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
  // Opaque packet identity. It is random and never derived from localPath.
  // This remains nullable during the restartable 0027 expansion; a separately
  // gated cutover adds NOT NULL only after a durable zero-null scan.
  rootRef: uuid('root_ref').defaultRandom(),
  // S3 serializes this BIGINT as a canonical decimal string at every JSON/API
  // boundary. Database order, never timestamps, decides grant precedence.
  grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  // Zero is the explicit unbound state. S4 binds a project root by advancing
  // this counter; S3 never upgrades a legacy decision implicitly.
  rootBindingRevision: bigint('root_binding_revision', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  defaultBranch: text('default_branch').notNull().default('main'),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', tsOpts),
})

export type Project = InferSelectModel<typeof projects>
export type NewProject = InferInsertModel<typeof projects>

/** C5 compatibility tombstone; C6 never uses this singleton. */
export const projectRootRefReconciliation = pgTable('project_root_ref_reconciliation', {
  singleton: boolean('singleton').primaryKey().default(true),
  lastProjectId: uuid('last_project_id'),
  rowsUpdated: bigint('rows_updated', { mode: 'bigint' }).notNull().default(sql`0`),
  state: text('state').notNull().default('superseded'),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
})

export const projectRootChangeJournalCounter = pgTable('project_root_change_journal_counter', {
  singleton: boolean('singleton').primaryKey().default(true),
  lastGeneration: bigint('last_generation', { mode: 'bigint' }).notNull().default(sql`0`),
}, (t) => [
  check('project_root_change_journal_counter_generation_chk', sql`${t.lastGeneration} >= 0`),
])

export const projectRootChangeJournal = pgTable('project_root_change_journal', {
  generation: bigint('generation', { mode: 'bigint' }).primaryKey(),
  operationId: uuid('operation_id').notNull().defaultRandom().unique(),
  projectId: uuid('project_id').notNull().references(() => projects.id, {
    onDelete: 'restrict',
    onUpdate: 'restrict',
  }),
  outcome: text('outcome').notNull(),
  rootBindingRevision: bigint('root_binding_revision', { mode: 'bigint' }),
  grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' }),
  occurredAt: timestamp('occurred_at', tsOpts).defaultNow().notNull(),
}, (t) => [
  check('project_root_change_journal_generation_chk', sql`${t.generation} > 0`),
  check('project_root_change_journal_outcome_chk', sql`${t.outcome} in ('insert','root_update','archive')`),
  check('project_root_change_journal_root_binding_revision_chk', sql`${t.rootBindingRevision} is null or ${t.rootBindingRevision} > 0`),
  check('project_root_change_journal_grant_decision_revision_chk', sql`${t.grantDecisionRevision} is null or ${t.grantDecisionRevision} > 0`),
])

export const projectRootReconciliationOperations = pgTable('project_root_reconciliation_operations', {
  operationId: uuid('operation_id').primaryKey(),
  actorId: uuid('actor_id').notNull(),
  throughGeneration: bigint('through_generation', { mode: 'bigint' }).notNull(),
  lastProcessedGeneration: bigint('last_processed_generation', { mode: 'bigint' }).notNull().default(sql`0`),
  lastProjectId: uuid('last_project_id'),
  batchCount: bigint('batch_count', { mode: 'bigint' }).notNull().default(sql`0`),
  cumulativeCount: bigint('cumulative_count', { mode: 'bigint' }).notNull().default(sql`0`),
  state: text('state').notNull().default('running'),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  completedAt: timestamp('completed_at', tsOpts),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('project_root_reconciliation_one_live_idx').on(sql`(true)`).where(sql`${t.state} = 'running'`),
  check('project_root_reconciliation_operation_progress_chk', sql`
    ${t.throughGeneration} >= 0 and ${t.lastProcessedGeneration} >= 0
    and ${t.lastProcessedGeneration} <= ${t.throughGeneration}
    and ${t.cumulativeCount} = ${t.lastProcessedGeneration}
    and ${t.state} in ('running','complete')
    and ((${t.state} = 'running' and ${t.completedAt} is null) or (${t.state} = 'complete' and ${t.completedAt} is not null))
  `),
])

export const projectRootReconciliationCheckpoints = pgTable('project_root_reconciliation_checkpoints', {
  operationId: uuid('operation_id').notNull().references(() => projectRootReconciliationOperations.operationId, { onDelete: 'restrict' }),
  checkpointGeneration: bigint('checkpoint_generation', { mode: 'bigint' }).notNull(),
  actorId: uuid('actor_id').notNull(),
  throughGeneration: bigint('through_generation', { mode: 'bigint' }).notNull(),
  lastProcessedGeneration: bigint('last_processed_generation', { mode: 'bigint' }).notNull(),
  lastProjectId: uuid('last_project_id'),
  batchCount: bigint('batch_count', { mode: 'bigint' }).notNull(),
  cumulativeCount: bigint('cumulative_count', { mode: 'bigint' }).notNull(),
  state: text('state').notNull(),
  checkpointedAt: timestamp('checkpointed_at', tsOpts).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.operationId, t.checkpointGeneration] }),
  check('project_root_reconciliation_checkpoint_shape_chk', sql`
    ${t.checkpointGeneration} >= 0 and ${t.throughGeneration} >= 0
    and ${t.lastProcessedGeneration} >= 0 and ${t.lastProcessedGeneration} <= ${t.throughGeneration}
    and ${t.cumulativeCount} = ${t.lastProcessedGeneration} and ${t.state} in ('running','complete')
  `),
])

export const projectRootReconciliationOutcomes = pgTable('project_root_reconciliation_outcomes', {
  generation: bigint('generation', { mode: 'bigint' }).primaryKey().references(() => projectRootChangeJournal.generation, { onDelete: 'restrict' }),
  operationId: uuid('operation_id').notNull().references(() => projectRootReconciliationOperations.operationId, { onDelete: 'restrict' }),
  actorId: uuid('actor_id').notNull(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  outcome: text('outcome').notNull(),
  recordedAt: timestamp('recorded_at', tsOpts).defaultNow().notNull(),
}, (t) => [
  check('project_root_reconciliation_outcome_kind_chk', sql`${t.outcome} in ('insert','root_update','archive')`),
])

// ---------------------------------------------------------------------------
// Epic 172 release authentication and transition substrate
//
// These tables deliberately do not reference projects, tasks, or runs. Release
// evidence must outlive ordinary application records and remains valid after a
// signer stops accepting new signatures. The migration adds append-only guards
// and grants writes only to the dedicated release principals.
// ---------------------------------------------------------------------------
export const forgeReleaseSignerKeys = pgTable(
  'forge_release_signer_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: text('policy_id').notNull().default('forge-epic-172-release-signing-v1'),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    algorithm: text('algorithm').notNull().default('Ed25519'),
    publicKeySpki: bytea('public_key_spki').notNull(),
    githubAppId: text('github_app_id').notNull(),
    rulesetFingerprint: text('ruleset_fingerprint').notNull(),
    // Staged keys cannot sign; active keys may; retiring/retired keys verify only.
    status: text('status').notNull().default('staged'),
    validFrom: timestamp('valid_from', tsOpts).notNull(),
    validUntil: timestamp('valid_until', tsOpts).notNull(),
    activatedAt: timestamp('activated_at', tsOpts),
    retirementStartedAt: timestamp('retirement_started_at', tsOpts),
    retiredAt: timestamp('retired_at', tsOpts),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('forge_release_signer_keys_policy_generation_idx').on(t.policyId, t.generation),
    uniqueIndex('forge_release_signer_keys_ruleset_fingerprint_idx').on(t.rulesetFingerprint),
    uniqueIndex('forge_release_signer_keys_one_active_policy_idx')
      .on(t.policyId)
      .where(sql`${t.status} = 'active'`),
    index('forge_release_signer_keys_status_validity_idx').on(t.status, t.validFrom, t.validUntil),
    check('forge_release_signer_keys_policy_chk', sql`${t.policyId} = 'forge-epic-172-release-signing-v1'`),
    check('forge_release_signer_keys_generation_chk', sql`${t.generation} > 0`),
    check('forge_release_signer_keys_algorithm_chk', sql`${t.algorithm} = 'Ed25519'`),
    check('forge_release_signer_keys_public_key_chk', sql`octet_length(${t.publicKeySpki}) > 0`),
    check('forge_release_signer_keys_fingerprint_chk', sql`${t.rulesetFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('forge_release_signer_keys_status_chk', sql`${t.status} in ('staged', 'active', 'retiring', 'retired')`),
    check('forge_release_signer_keys_validity_chk', sql`${t.validUntil} > ${t.validFrom}`),
    check(
      'forge_release_signer_keys_lifecycle_chk',
      sql`(${t.status} = 'staged' and ${t.activatedAt} is null and ${t.retirementStartedAt} is null and ${t.retiredAt} is null)
        or (${t.status} = 'active' and ${t.activatedAt} is not null and ${t.retirementStartedAt} is null and ${t.retiredAt} is null)
        or (${t.status} = 'retiring' and ${t.activatedAt} is not null and ${t.retirementStartedAt} is not null and ${t.retiredAt} is null)
        or (${t.status} = 'retired' and ${t.activatedAt} is not null and ${t.retirementStartedAt} is not null and ${t.retiredAt} is not null)`,
    ),
  ],
)

export type ForgeReleaseSignerKey = InferSelectModel<typeof forgeReleaseSignerKeys>
export type NewForgeReleaseSignerKey = InferInsertModel<typeof forgeReleaseSignerKeys>

export const forgeReleaseSignerKeyLifecycleAudits = pgTable(
  'forge_release_signer_key_lifecycle_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signerKeyId: uuid('signer_key_id')
      .notNull()
      .references(() => forgeReleaseSignerKeys.id, { onDelete: 'restrict' }),
    signerGeneration: bigint('signer_generation', { mode: 'number' }).notNull(),
    action: text('action').notNull(),
    priorStatus: text('prior_status'),
    newStatus: text('new_status').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull().default(''),
    occurredAt: timestamp('occurred_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('forge_release_signer_lifecycle_key_idx').on(t.signerKeyId, t.occurredAt),
    check('forge_release_signer_lifecycle_generation_chk', sql`${t.signerGeneration} > 0`),
    check(
      'forge_release_signer_lifecycle_action_chk',
      sql`${t.action} in ('installed', 'activated', 'retirement_started', 'retired')`,
    ),
    check(
      'forge_release_signer_lifecycle_prior_status_chk',
      sql`${t.priorStatus} is null or ${t.priorStatus} in ('staged', 'active', 'retiring', 'retired')`,
    ),
    check(
      'forge_release_signer_lifecycle_new_status_chk',
      sql`${t.newStatus} in ('staged', 'active', 'retiring', 'retired')`,
    ),
    check('forge_release_signer_lifecycle_actor_chk', sql`length(btrim(${t.actor})) between 1 and 200`),
    check('forge_release_signer_lifecycle_reason_chk', sql`length(${t.reason}) <= 1000`),
  ],
)

export type ForgeReleaseSignerKeyLifecycleAudit = InferSelectModel<typeof forgeReleaseSignerKeyLifecycleAudits>
export type NewForgeReleaseSignerKeyLifecycleAudit = InferInsertModel<typeof forgeReleaseSignerKeyLifecycleAudits>

export const forgeEpic172ReleaseEvidence = pgTable(
  'forge_epic_172_release_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    manifestVersion: integer('manifest_version').notNull().default(1),
    evidenceKind: text('evidence_kind').notNull(),
    ownerIssue: integer('owner_issue').notNull(),
    ownerSlice: text('owner_slice').notNull(),
    exactBuilds: jsonb('exact_builds').$type<string[]>().notNull(),
    requiredEvidence: jsonb('required_evidence').$type<Array<{ name: string; measurementDigest: string }>>().notNull(),
    reviewedSha: text('reviewed_sha').notNull(),
    epoch: bigint('epoch', { mode: 'number' }),
    predecessorReceiptIds: jsonb('predecessor_receipt_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    predecessorSetDigest: text('predecessor_set_digest').notNull(),
    transitionIdentityDigest: text('transition_identity_digest').notNull(),
    signerKeyId: uuid('signer_key_id')
      .notNull()
      .references(() => forgeReleaseSignerKeys.id, { onDelete: 'restrict' }),
    signerGeneration: bigint('signer_generation', { mode: 'number' }).notNull(),
    githubAppId: text('github_app_id').notNull(),
    controllerRunId: text('controller_run_id').notNull(),
    controllerJobId: text('controller_job_id').notNull(),
    signatureDomain: text('signature_domain').notNull().default('forge:epic-172-release-evidence:v1'),
    envelopeVersion: integer('envelope_version').notNull().default(1),
    envelopeDigest: text('envelope_digest').notNull(),
    detachedSignature: bytea('detached_signature').notNull(),
    nonce: uuid('nonce').notNull(),
    issuedAt: timestamp('issued_at', tsOpts).notNull(),
    recordedAt: timestamp('recorded_at', tsOpts).defaultNow().notNull(),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    uniqueIndex('forge_epic_172_release_evidence_transition_identity_idx').on(t.transitionIdentityDigest),
    uniqueIndex('forge_epic_172_release_evidence_nonce_idx').on(t.nonce),
    uniqueIndex('forge_epic_172_release_evidence_envelope_digest_idx').on(t.envelopeDigest),
    index('forge_epic_172_release_evidence_kind_idx').on(t.manifestVersion, t.evidenceKind),
    index('forge_epic_172_release_evidence_signer_idx').on(t.signerKeyId, t.signerGeneration),
    check('forge_epic_172_release_evidence_manifest_chk', sql`${t.manifestVersion} = 1`),
    check('forge_epic_172_release_evidence_owner_issue_chk', sql`${t.ownerIssue} > 0`),
    check('forge_epic_172_release_evidence_owner_slice_chk', sql`${t.ownerSlice} in ('step0', 's3', 's4', 's5', 's6')`),
    check('forge_epic_172_release_evidence_builds_chk', sql`jsonb_typeof(${t.exactBuilds}) = 'array' and jsonb_array_length(${t.exactBuilds}) > 0`),
    check('forge_epic_172_release_evidence_required_evidence_chk', sql`jsonb_typeof(${t.requiredEvidence}) = 'array' and jsonb_array_length(${t.requiredEvidence}) > 0`),
    check('forge_epic_172_release_evidence_sha_chk', sql`${t.reviewedSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check('forge_epic_172_release_evidence_epoch_chk', sql`${t.epoch} is null or ${t.epoch} > 0`),
    check('forge_epic_172_release_evidence_predecessors_chk', sql`jsonb_typeof(${t.predecessorReceiptIds}) = 'array'`),
    check('forge_epic_172_release_evidence_predecessor_digest_chk', sql`${t.predecessorSetDigest} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_release_evidence_identity_digest_chk', sql`${t.transitionIdentityDigest} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_release_evidence_generation_chk', sql`${t.signerGeneration} > 0`),
    check('forge_epic_172_release_evidence_domain_chk', sql`${t.signatureDomain} = 'forge:epic-172-release-evidence:v1'`),
    check('forge_epic_172_release_evidence_envelope_version_chk', sql`${t.envelopeVersion} = 1`),
    check('forge_epic_172_release_evidence_envelope_digest_chk', sql`${t.envelopeDigest} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_release_evidence_signature_chk', sql`octet_length(${t.detachedSignature}) = 64`),
    check('forge_epic_172_release_evidence_time_chk', sql`${t.recordedAt} >= ${t.issuedAt}`),
    check('forge_epic_172_release_evidence_envelope_chk', sql`jsonb_typeof(${t.envelope}) = 'object'`),
  ],
)

export type ForgeEpic172ReleaseEvidence = InferSelectModel<typeof forgeEpic172ReleaseEvidence>
export type NewForgeEpic172ReleaseEvidence = InferInsertModel<typeof forgeEpic172ReleaseEvidence>

export const forgeEpic172TransitionAuthorizations = pgTable(
  'forge_epic_172_transition_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    manifestVersion: integer('manifest_version').notNull().default(1),
    targetNode: text('target_node').notNull(),
    transitionIdentityDigest: text('transition_identity_digest').notNull(),
    sourceReceiptIds: jsonb('source_receipt_ids').$type<string[]>().notNull(),
    sourceReceiptSetDigest: text('source_receipt_set_digest').notNull(),
    ownerIssue: integer('owner_issue').notNull(),
    ownerSlice: text('owner_slice').notNull(),
    exactBuilds: jsonb('exact_builds').$type<string[]>().notNull(),
    reviewedSha: text('reviewed_sha').notNull(),
    epoch: bigint('epoch', { mode: 'number' }),
    operationId: text('operation_id').notNull(),
    operation: text('operation').notNull(),
    controllerLoginId: text('controller_login_id').notNull(),
    controllerRunId: text('controller_run_id').notNull(),
    signerKeyId: uuid('signer_key_id')
      .notNull()
      .references(() => forgeReleaseSignerKeys.id, { onDelete: 'restrict' }),
    signerGeneration: bigint('signer_generation', { mode: 'number' }).notNull(),
    signatureDomain: text('signature_domain').notNull().default('forge:epic-172-transition-authorization:v1'),
    envelopeVersion: integer('envelope_version').notNull().default(1),
    envelopeDigest: text('envelope_digest').notNull(),
    detachedSignature: bytea('detached_signature').notNull(),
    nonce: uuid('nonce').notNull(),
    issuedAt: timestamp('issued_at', tsOpts).notNull(),
    expiresAt: timestamp('expires_at', tsOpts).notNull(),
    recordedAt: timestamp('recorded_at', tsOpts).defaultNow().notNull(),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    uniqueIndex('forge_epic_172_transition_authorizations_nonce_idx').on(t.nonce),
    uniqueIndex('forge_epic_172_transition_authorizations_envelope_digest_idx').on(t.envelopeDigest),
    index('forge_epic_172_transition_authorizations_target_idx').on(t.manifestVersion, t.targetNode),
    index('forge_epic_172_transition_authorizations_expiry_idx').on(t.expiresAt),
    index('forge_epic_172_transition_authorizations_signer_idx').on(t.signerKeyId, t.signerGeneration),
    check('forge_epic_172_transition_authorizations_manifest_chk', sql`${t.manifestVersion} = 1`),
    check('forge_epic_172_transition_authorizations_identity_chk', sql`${t.transitionIdentityDigest} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_transition_authorizations_sources_chk', sql`jsonb_typeof(${t.sourceReceiptIds}) = 'array' and jsonb_array_length(${t.sourceReceiptIds}) > 0`),
    check('forge_epic_172_transition_authorizations_source_digest_chk', sql`${t.sourceReceiptSetDigest} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_transition_authorizations_owner_issue_chk', sql`${t.ownerIssue} > 0`),
    check('forge_epic_172_transition_authorizations_owner_slice_chk', sql`${t.ownerSlice} in ('step0', 's3', 's4', 's5', 's6')`),
    check('forge_epic_172_transition_authorizations_builds_chk', sql`jsonb_typeof(${t.exactBuilds}) = 'array' and jsonb_array_length(${t.exactBuilds}) > 0`),
    check('forge_epic_172_transition_authorizations_sha_chk', sql`${t.reviewedSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check('forge_epic_172_transition_authorizations_epoch_chk', sql`${t.epoch} is null or ${t.epoch} > 0`),
    check('forge_epic_172_transition_authorizations_generation_chk', sql`${t.signerGeneration} > 0`),
    check('forge_epic_172_transition_authorizations_domain_chk', sql`${t.signatureDomain} = 'forge:epic-172-transition-authorization:v1'`),
    check('forge_epic_172_transition_authorizations_envelope_version_chk', sql`${t.envelopeVersion} = 1`),
    check('forge_epic_172_transition_authorizations_envelope_digest_chk', sql`${t.envelopeDigest} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_transition_authorizations_signature_chk', sql`octet_length(${t.detachedSignature}) = 64`),
    check('forge_epic_172_transition_authorizations_lifetime_chk', sql`${t.expiresAt} > ${t.issuedAt} and ${t.expiresAt} <= ${t.issuedAt} + interval '30 minutes'`),
    check('forge_epic_172_transition_authorizations_recorded_chk', sql`${t.recordedAt} >= ${t.issuedAt}`),
    check('forge_epic_172_transition_authorizations_envelope_chk', sql`jsonb_typeof(${t.envelope}) = 'object'`),
  ],
)

export type ForgeEpic172TransitionAuthorization = InferSelectModel<typeof forgeEpic172TransitionAuthorizations>
export type NewForgeEpic172TransitionAuthorization = InferInsertModel<typeof forgeEpic172TransitionAuthorizations>

export const forgeEpic172ReleaseEvidenceConsumptions = pgTable(
  'forge_epic_172_release_evidence_consumptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => forgeEpic172ReleaseEvidence.id, { onDelete: 'restrict' }),
    transitionIdentityDigest: text('transition_identity_digest').notNull(),
    authorizationId: uuid('authorization_id')
      .notNull()
      .references(() => forgeEpic172TransitionAuthorizations.id, { onDelete: 'restrict' }),
    consumerNode: text('consumer_node').notNull(),
    operationId: text('operation_id').notNull(),
    actor: text('actor').notNull(),
    consumedAt: timestamp('consumed_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('forge_epic_172_release_evidence_consumptions_receipt_idx').on(t.receiptId),
    uniqueIndex('forge_epic_172_release_evidence_consumptions_authorization_receipt_idx')
      .on(t.authorizationId, t.receiptId),
    uniqueIndex('forge_epic_172_release_evidence_consumptions_identity_consumer_idx')
      .on(t.transitionIdentityDigest, t.consumerNode),
    index('forge_epic_172_release_evidence_consumptions_operation_idx').on(t.operationId),
    check('forge_epic_172_release_evidence_consumptions_identity_chk', sql`${t.transitionIdentityDigest} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_release_evidence_consumptions_consumer_chk', sql`length(btrim(${t.consumerNode})) between 1 and 100`),
    check('forge_epic_172_release_evidence_consumptions_operation_chk', sql`length(btrim(${t.operationId})) between 1 and 200`),
    check('forge_epic_172_release_evidence_consumptions_actor_chk', sql`length(btrim(${t.actor})) between 1 and 200`),
  ],
)

export type ForgeEpic172ReleaseEvidenceConsumption = InferSelectModel<typeof forgeEpic172ReleaseEvidenceConsumptions>
export type NewForgeEpic172ReleaseEvidenceConsumption = InferInsertModel<typeof forgeEpic172ReleaseEvidenceConsumptions>

export const forgeEpic172S3ReleaseState = pgTable(
  'forge_epic_172_s3_release_state',
  {
    singletonId: text('singleton_id').primaryKey(),
    state: text('state').notNull(),
    stateFingerprint: text('state_fingerprint').notNull(),
    predecessorReceiptId: uuid('predecessor_receipt_id')
      .references(() => forgeEpic172ReleaseEvidence.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    authorizationId: uuid('authorization_id')
      .references(() => forgeEpic172TransitionAuthorizations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    evidenceReceiptId: uuid('evidence_receipt_id')
      .references(() => forgeEpic172ReleaseEvidence.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    transitionIdentityDigest: text('transition_identity_digest'),
    completedAt: timestamp('completed_at', tsOpts),
  },
  (t) => [
    check('forge_epic_172_s3_release_state_singleton_chk', sql`${t.singletonId} = 's3_issue_178'`),
    check('forge_epic_172_s3_release_state_state_chk', sql`${t.state} in ('pending', 'complete')`),
    check('forge_epic_172_s3_release_state_fingerprint_chk', sql`${t.stateFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_s3_release_state_tuple_chk', sql`
      (
        ${t.state} = 'pending'
        and ${t.stateFingerprint} = '7a97eed28629c7d0d7c11a48d3509f1c479d614882dc61a7e2c1891f32c3a5dc'
        and ${t.predecessorReceiptId} is null
        and ${t.authorizationId} is null
        and ${t.evidenceReceiptId} is null
        and ${t.transitionIdentityDigest} is null
        and ${t.completedAt} is null
      ) or (
        ${t.state} = 'complete'
        and ${t.predecessorReceiptId} is not null
        and ${t.authorizationId} is not null
        and ${t.evidenceReceiptId} is not null
        and ${t.evidenceReceiptId} <> ${t.predecessorReceiptId}
        and ${t.transitionIdentityDigest} ~ '^[0-9a-f]{64}$'
        and ${t.stateFingerprint} = ${t.transitionIdentityDigest}
        and ${t.completedAt} is not null
      )
    `),
  ],
)

export type ForgeEpic172S3ReleaseState = InferSelectModel<typeof forgeEpic172S3ReleaseState>
export type NewForgeEpic172S3ReleaseState = InferInsertModel<typeof forgeEpic172S3ReleaseState>

export const forgeEpic172EnablementState = pgTable(
  'forge_epic_172_enablement_state',
  {
    singletonId: text('singleton_id').primaryKey().default('epic-172'),
    state: text('state').notNull().default('disabled'),
    ownerOperationId: text('owner_operation_id'),
    exactBuilds: jsonb('exact_builds').$type<string[]>(),
    reviewedSha: text('reviewed_sha'),
    epoch: bigint('epoch', { mode: 'number' }),
    startedAt: timestamp('started_at', tsOpts),
    expiresAt: timestamp('expires_at', tsOpts),
    enablementReceiptId: uuid('enablement_receipt_id')
      .references(() => forgeEpic172ReleaseEvidence.id, { onDelete: 'restrict' }),
    finalReadinessReceiptId: uuid('final_readiness_receipt_id')
      .references(() => forgeEpic172ReleaseEvidence.id, { onDelete: 'restrict' }),
    openingAuthorizationId: uuid('opening_authorization_id')
      .references(() => forgeEpic172TransitionAuthorizations.id, { onDelete: 'restrict' }),
    controllerLoginId: text('controller_login_id'),
    controllerRunId: text('controller_run_id'),
    controllerTokenDigest: bytea('controller_token_digest'),
    leaseGeneration: bigint('lease_generation', { mode: 'number' }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', tsOpts),
    leaseExpiresAt: timestamp('lease_expires_at', tsOpts),
    stateFingerprint: text('state_fingerprint').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    check('forge_epic_172_enablement_singleton_chk', sql`${t.singletonId} = 'epic-172'`),
    check('forge_epic_172_enablement_state_chk', sql`${t.state} in ('disabled', 'provisional', 'active')`),
    check('forge_epic_172_enablement_sha_chk', sql`${t.reviewedSha} is null or ${t.reviewedSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check('forge_epic_172_enablement_epoch_chk', sql`${t.epoch} is null or ${t.epoch} > 0`),
    check('forge_epic_172_enablement_token_chk', sql`${t.controllerTokenDigest} is null or octet_length(${t.controllerTokenDigest}) = 32`),
    check('forge_epic_172_enablement_lease_generation_chk', sql`${t.leaseGeneration} is null or ${t.leaseGeneration} > 0`),
    check('forge_epic_172_enablement_fingerprint_chk', sql`${t.stateFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'forge_epic_172_enablement_disabled_chk',
      sql`${t.state} <> 'disabled' or (
        ${t.ownerOperationId} is null and ${t.exactBuilds} is null and ${t.reviewedSha} is null and
        ${t.epoch} is null and ${t.startedAt} is null and ${t.expiresAt} is null and
        ${t.enablementReceiptId} is null and ${t.finalReadinessReceiptId} is null and
        ${t.openingAuthorizationId} is null and ${t.controllerLoginId} is null and
        ${t.controllerRunId} is null and ${t.controllerTokenDigest} is null and
        ${t.leaseGeneration} is null and ${t.lastHeartbeatAt} is null and ${t.leaseExpiresAt} is null
      )`,
    ),
    check(
      'forge_epic_172_enablement_provisional_chk',
      sql`${t.state} <> 'provisional' or (
        ${t.ownerOperationId} is not null and jsonb_typeof(${t.exactBuilds}) = 'array' and
        ${t.reviewedSha} is not null and ${t.epoch} is not null and ${t.startedAt} is not null and
        ${t.expiresAt} is not null and ${t.expiresAt} > ${t.startedAt} and
        ${t.enablementReceiptId} is not null and ${t.openingAuthorizationId} is not null and
        ${t.controllerLoginId} is not null and ${t.controllerRunId} is not null and
        ${t.controllerTokenDigest} is not null and ${t.leaseGeneration} is not null and
        ${t.lastHeartbeatAt} is not null and ${t.leaseExpiresAt} is not null and
        ${t.leaseExpiresAt} <= ${t.expiresAt}
      )`,
    ),
    check(
      'forge_epic_172_enablement_active_chk',
      sql`${t.state} <> 'active' or (
        ${t.ownerOperationId} is not null and jsonb_typeof(${t.exactBuilds}) = 'array' and
        ${t.reviewedSha} is not null and ${t.epoch} is not null and
        ${t.enablementReceiptId} is not null and ${t.finalReadinessReceiptId} is not null
      )`,
    ),
  ],
)

export type ForgeEpic172EnablementState = InferSelectModel<typeof forgeEpic172EnablementState>
export type NewForgeEpic172EnablementState = InferInsertModel<typeof forgeEpic172EnablementState>

export const forgeEpic172EnablementTransitionAudits = pgTable(
  'forge_epic_172_enablement_transition_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    disposition: text('disposition').notNull(),
    priorStateFingerprint: text('prior_state_fingerprint').notNull(),
    newStateFingerprint: text('new_state_fingerprint').notNull(),
    operationId: text('operation_id').notNull(),
    actor: text('actor').notNull(),
    controllerRunId: text('controller_run_id'),
    authorizationId: uuid('authorization_id')
      .references(() => forgeEpic172TransitionAuthorizations.id, { onDelete: 'restrict' }),
    evidenceReceiptId: uuid('evidence_receipt_id')
      .references(() => forgeEpic172ReleaseEvidence.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('forge_epic_172_enablement_transition_operation_idx').on(t.operationId, t.occurredAt),
    index('forge_epic_172_enablement_transition_disposition_idx').on(t.disposition, t.occurredAt),
    check(
      'forge_epic_172_enablement_transition_disposition_chk',
      sql`${t.disposition} in ('opened', 'heartbeat', 'failed_disabled', 'expired_disabled', 'manually_disabled', 'promoted_active')`,
    ),
    check('forge_epic_172_enablement_transition_prior_fingerprint_chk', sql`${t.priorStateFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_enablement_transition_new_fingerprint_chk', sql`${t.newStateFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('forge_epic_172_enablement_transition_operation_chk', sql`length(btrim(${t.operationId})) between 1 and 200`),
    check('forge_epic_172_enablement_transition_actor_chk', sql`length(btrim(${t.actor})) between 1 and 200`),
  ],
)

export type ForgeEpic172EnablementTransitionAudit = InferSelectModel<typeof forgeEpic172EnablementTransitionAudits>
export type NewForgeEpic172EnablementTransitionAudit = InferInsertModel<typeof forgeEpic172EnablementTransitionAudits>

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
      .references(() => projects.id, { onDelete: 'restrict' }),
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
      .references(() => projects.id, { onDelete: 'restrict' }),
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
    localProjectionScopeState: text('local_projection_scope_state').notNull().default('active'),
    localProjectionOverlimitPackageCount: integer('local_projection_overlimit_package_count'),
    localProjectionSourceTaskId: uuid('local_projection_source_task_id'),
    localProjectionReplacementState: text('local_projection_replacement_state'),
    localProjectionReplacementVersion: bigint('local_projection_replacement_version', { mode: 'bigint' }),
    localProjectionReplacementFingerprint: text('local_projection_replacement_fingerprint'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
    completedAt: timestamp('completed_at', tsOpts),
  },
  (t) => [
    index('tasks_project_id_status_idx').on(t.projectId, t.status),
    index('tasks_submitted_by_idx').on(t.submittedBy),
    index('tasks_created_at_desc_idx').on(t.createdAt),
    index('tasks_status_updated_at_idx').on(t.status, t.updatedAt),
  ],
)

type TaskRow = InferSelectModel<typeof tasks>
type NewTaskRow = InferInsertModel<typeof tasks>
type TaskProjectionScopeFields = 'localProjectionScopeState' | 'localProjectionOverlimitPackageCount'

export type Task = Omit<TaskRow, TaskProjectionScopeFields>
export type NewTask = Omit<NewTaskRow, TaskProjectionScopeFields>

// Keep the focused protocol query surface without registering a second,
// partial Drizzle definition for the same physical table. Duplicate table
// definitions make migration snapshot generation discard one of the shapes.
export const taskLocalProjectionScopes = tasks

// ---------------------------------------------------------------------------
// taskAttempts
// ---------------------------------------------------------------------------
export type TaskAttemptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'dead_lettered'
  | 'indeterminate'

export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    queueName: text('queue_name').notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    // Terminal `indeterminate` means the business attempt failed but Redis retry
    // scheduling could not be confirmed. This remains text in PostgreSQL.
    status: text('status').$type<TaskAttemptStatus>().notNull().default('running'),
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
      .references(() => tasks.id, { onDelete: 'restrict' }),
    harnessId: uuid('harness_id').references(() => agentHarnesses.id, {
      onDelete: 'set null',
    }),
    assignedRole: text('assigned_role').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    // 'pending'|'ready'|'running'|'awaiting_review'|'needs_rework'|'blocked'|'completed'|'failed'|'cancelled'
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
    // 'none'|'qa_only'|'reviewer_only'|'both' - set by the Architect plan, consumed by review-gates
    reviewRequirement: text('review_requirement').notNull().default('both'),
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
// filesystemMcpGrantApprovals
// ---------------------------------------------------------------------------
export const filesystemMcpGrantApprovals = pgTable(
  'filesystem_mcp_grant_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id')
      .references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id')
      .references(() => workPackages.id, { onDelete: 'restrict' }),
    decisionScope: text('decision_scope').notNull().default('package'),
    decidedBy: uuid('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    // 'approved'|'denied'
    decision: text('decision').notNull().default('denied'),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    reason: text('reason').notNull().default(''),
    effectiveGrant: jsonb('effective_grant')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' }),
    rootBindingRevision: bigint('root_binding_revision', { mode: 'bigint' }),
    // Fresh only for allow_once approvals. It is immutable with the decision
    // row and may never be reused after an S4 consumer records issuance.
    grantNonce: uuid('grant_nonce'),
    pointerFingerprint: text('pointer_fingerprint'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('filesystem_mcp_grant_approvals_work_package_id_idx').on(t.workPackageId),
    index('filesystem_mcp_grant_approvals_project_id_idx').on(t.projectId),
    uniqueIndex('filesystem_mcp_grant_approvals_grant_nonce_idx').on(t.grantNonce),
    index('filesystem_mcp_grant_approvals_task_id_idx').on(t.taskId),
    index('filesystem_mcp_grant_approvals_decision_idx').on(t.decision),
    index('filesystem_mcp_grant_approvals_revision_idx').on(t.grantDecisionRevision),
    uniqueIndex('filesystem_mcp_grant_approvals_pointer_parent_idx').on(
      t.id,
      t.taskId,
      t.workPackageId,
      t.grantDecisionRevision,
      t.pointerFingerprint,
    ),
  ],
)

export type FilesystemMcpGrantApproval = InferSelectModel<typeof filesystemMcpGrantApprovals>
export type NewFilesystemMcpGrantApproval = InferInsertModel<typeof filesystemMcpGrantApprovals>

// ---------------------------------------------------------------------------
// filesystemMcpCurrentDecisionPointers
// ---------------------------------------------------------------------------
// Exactly one authority slot is preallocated for each package. Immutable
// decisions are appended above; this pointer advances with an exact compare and
// set, so concurrent reapprovals have one winner.
export const filesystemMcpCurrentDecisionPointers = pgTable(
  'filesystem_mcp_current_decision_pointers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    workPackageId: uuid('work_package_id')
      .notNull()
      .references(() => workPackages.id, { onDelete: 'cascade' }),
    currentDecisionId: uuid('current_decision_id'),
    currentDecisionTaskId: uuid('current_decision_task_id'),
    currentDecisionWorkPackageId: uuid('current_decision_work_package_id'),
    currentDecisionRevision: bigint('current_decision_revision', { mode: 'bigint' }),
    currentDecisionFingerprint: text('current_decision_fingerprint'),
    pointerFingerprint: text('pointer_fingerprint').notNull(),
    pointerVersion: bigint('pointer_version', { mode: 'bigint' }).notNull().default(sql`0`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('filesystem_mcp_current_decision_pointers_work_package_idx').on(t.workPackageId),
    index('filesystem_mcp_current_decision_pointers_task_idx').on(t.taskId),
    uniqueIndex('filesystem_mcp_current_decision_pointers_current_decision_idx').on(t.currentDecisionId),
    foreignKey({
      columns: [
        t.currentDecisionId,
        t.currentDecisionTaskId,
        t.currentDecisionWorkPackageId,
        t.currentDecisionRevision,
        t.currentDecisionFingerprint,
      ],
      foreignColumns: [
        filesystemMcpGrantApprovals.id,
        filesystemMcpGrantApprovals.taskId,
        filesystemMcpGrantApprovals.workPackageId,
        filesystemMcpGrantApprovals.grantDecisionRevision,
        filesystemMcpGrantApprovals.pointerFingerprint,
      ],
      name: 'filesystem_mcp_current_decision_pointers_parent_fk',
    }),
  ],
)

export type FilesystemMcpCurrentDecisionPointer = InferSelectModel<typeof filesystemMcpCurrentDecisionPointers>
export type NewFilesystemMcpCurrentDecisionPointer = InferInsertModel<typeof filesystemMcpCurrentDecisionPointers>

// ---------------------------------------------------------------------------
// projectFilesystemGrantDecisions / projectFilesystemCurrentDecisionPointers
// ---------------------------------------------------------------------------
// Project always-allow authority is not stored in projects.mcp_config. Every
// decision is immutable; exactly one preallocated project-owned pointer names
// the current retained decision through an exact compare-and-set boundary.
export const projectFilesystemGrantDecisions = pgTable(
  'project_filesystem_grant_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    decision: text('decision').notNull(),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' }).notNull(),
    rootBindingRevision: bigint('root_binding_revision', { mode: 'bigint' }).notNull(),
    decisionFingerprint: text('decision_fingerprint').notNull(),
    decisionGeneration: bigint('decision_generation', { mode: 'bigint' }).notNull(),
    priorDecisionId: uuid('prior_decision_id'),
    priorDecisionProjectId: uuid('prior_decision_project_id'),
    priorDecisionRevision: bigint('prior_decision_revision', { mode: 'bigint' }),
    priorRootBindingRevision: bigint('prior_root_binding_revision', { mode: 'bigint' }),
    priorDecisionFingerprint: text('prior_decision_fingerprint'),
    priorDecisionGeneration: bigint('prior_decision_generation', { mode: 'bigint' }),
    revocationReason: text('revocation_reason'),
    reason: text('reason').notNull().default(''),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('project_filesystem_grant_decisions_project_revision_idx')
      .on(t.projectId, t.grantDecisionRevision),
    uniqueIndex('project_filesystem_grant_decisions_project_generation_idx')
      .on(t.projectId, t.decisionGeneration),
    uniqueIndex('project_filesystem_grant_decisions_parent_tuple_idx')
      .on(
        t.id,
        t.projectId,
        t.grantDecisionRevision,
        t.rootBindingRevision,
        t.decisionFingerprint,
        t.decisionGeneration,
      ),
    foreignKey({
      columns: [
        t.priorDecisionId,
        t.priorDecisionProjectId,
        t.priorDecisionRevision,
        t.priorRootBindingRevision,
        t.priorDecisionFingerprint,
        t.priorDecisionGeneration,
      ],
      foreignColumns: [
        t.id,
        t.projectId,
        t.grantDecisionRevision,
        t.rootBindingRevision,
        t.decisionFingerprint,
        t.decisionGeneration,
      ],
      name: 'project_filesystem_grant_decisions_prior_fk',
    }),
  ],
)

export type ProjectFilesystemGrantDecision = InferSelectModel<typeof projectFilesystemGrantDecisions>
export type NewProjectFilesystemGrantDecision = InferInsertModel<typeof projectFilesystemGrantDecisions>

export const projectFilesystemCurrentDecisionPointers = pgTable(
  'project_filesystem_current_decision_pointers',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    currentDecisionId: uuid('current_decision_id'),
    currentDecisionProjectId: uuid('current_decision_project_id'),
    currentDecisionRevision: bigint('current_decision_revision', { mode: 'bigint' }),
    currentRootBindingRevision: bigint('current_root_binding_revision', { mode: 'bigint' }),
    currentDecisionFingerprint: text('current_decision_fingerprint'),
    currentDecisionGeneration: bigint('current_decision_generation', { mode: 'bigint' }),
    pointerGeneration: bigint('pointer_generation', { mode: 'bigint' }).notNull().default(sql`0`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('project_filesystem_current_decision_pointers_decision_idx').on(t.currentDecisionId),
  ],
)

export type ProjectFilesystemCurrentDecisionPointer = InferSelectModel<typeof projectFilesystemCurrentDecisionPointers>
export type NewProjectFilesystemCurrentDecisionPointer = InferInsertModel<typeof projectFilesystemCurrentDecisionPointers>

// ---------------------------------------------------------------------------
// workPackageLocalProjectionSources / workPackageLocalProjectionHeads
// ---------------------------------------------------------------------------
// Preallocated per-package projection heads for the S3→S4 protocol surface.
// Eight immutable heads are created on work_package INSERT. The package limit
// of 256 ensures at most 2,048 heads. Sources are append-only; heads may advance
// only through the fixed compare-and-set routine installed by migration 0026.
export const workPackageLocalProjectionSources = pgTable(
  'work_package_local_projection_sources',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id')
      .notNull()
      .references(() => workPackages.id, { onDelete: 'restrict' }),
    sourceKind: text('source_kind').notNull(),
    sourceRevision: bigint('source_revision', { mode: 'bigint' }).notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    contribution: jsonb('contribution').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('work_package_local_projection_sources_identity_idx').on(
      t.id,
      t.taskId,
      t.workPackageId,
      t.sourceKind,
      t.sourceRevision,
      t.sourceFingerprint,
    ),
    uniqueIndex('work_package_local_projection_sources_package_kind_revision_idx').on(
      t.workPackageId,
      t.sourceKind,
      t.sourceRevision,
    ),
    check('work_package_projection_source_revision_chk', sql`${t.sourceRevision} > 0`),
    check('work_package_projection_source_fingerprint_chk', sql`
      ${t.sourceFingerprint} ~ '^sha256:[0-9a-f]{64}$'
    `),
    check('work_package_projection_source_contribution_chk', sql`
      jsonb_typeof(${t.contribution}) = 'object'
      and octet_length(${t.contribution}::text) <= 4096
    `),
  ],
)

export type WorkPackageLocalProjectionSource = InferSelectModel<typeof workPackageLocalProjectionSources>
export type NewWorkPackageLocalProjectionSource = InferInsertModel<typeof workPackageLocalProjectionSources>

export const workPackageLocalProjectionHeads = pgTable(
  'work_package_local_projection_heads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id')
      .notNull()
      .references(() => workPackages.id, { onDelete: 'restrict' }),
    headKind: text('head_kind').notNull(),
    headIndex: bigint('head_index', { mode: 'bigint' }).notNull(),
    headFingerprint: text('head_fingerprint').notNull(),
    headRevision: bigint('head_revision', { mode: 'bigint' }).notNull().default(sql`0`),
    compareAndSetFingerprint: text('compare_and_set_fingerprint').notNull(),
    currentSourceId: uuid('current_source_id'),
    currentSourceTaskId: uuid('current_source_task_id'),
    currentSourceWorkPackageId: uuid('current_source_work_package_id'),
    currentSourceKind: text('current_source_kind'),
    currentSourceRevision: bigint('current_source_revision', { mode: 'bigint' }),
    currentSourceFingerprint: text('current_source_fingerprint'),
    contribution: jsonb('contribution').notNull().default({}),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('work_package_local_projection_heads_package_kind_idx')
      .on(t.workPackageId, t.headKind),
    index('work_package_local_projection_heads_kind_idx').on(t.headKind),
    index('work_package_local_projection_heads_task_id_idx').on(t.taskId),
    uniqueIndex('work_package_local_projection_heads_fingerprint_idx')
      .on(t.headFingerprint),
    uniqueIndex('work_package_local_projection_heads_cas_fingerprint_idx')
      .on(t.compareAndSetFingerprint),
    foreignKey({
      columns: [
        t.currentSourceId,
        t.currentSourceTaskId,
        t.currentSourceWorkPackageId,
        t.currentSourceKind,
        t.currentSourceRevision,
        t.currentSourceFingerprint,
      ],
      foreignColumns: [
        workPackageLocalProjectionSources.id,
        workPackageLocalProjectionSources.taskId,
        workPackageLocalProjectionSources.workPackageId,
        workPackageLocalProjectionSources.sourceKind,
        workPackageLocalProjectionSources.sourceRevision,
        workPackageLocalProjectionSources.sourceFingerprint,
      ],
      name: 'work_package_projection_heads_current_source_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('work_package_projection_head_kind_chk', sql`
      ${t.headKind} in (
        'local_run',
        'local_recovery',
        'packet_recovery',
        'repository_review',
        'host_apply_review',
        'operator_hold',
        'integrity',
        'terminal_disposition'
      )
    `),
    check('work_package_projection_head_index_chk', sql`
      ${t.headIndex} >= 0 and ${t.headIndex} < 8
    `),
    check('work_package_projection_head_revision_chk', sql`
      ${t.headRevision} >= 0
    `),
    check('work_package_projection_head_fingerprint_chk', sql`
      ${t.headFingerprint} ~ '^head:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z_]+:[0-7]$'
    `),
    check('work_package_projection_head_cas_fingerprint_chk', sql`
      ${t.compareAndSetFingerprint} ~ '^(head:v1:[0-9a-f:-]+:[a-z_]+:[0-7]|sha256:[0-9a-f]{64})$'
    `),
    check('work_package_projection_head_contribution_chk', sql`
      jsonb_typeof(${t.contribution}) = 'object'
      and octet_length(${t.contribution}::text) <= 4096
    `),
    check('work_package_projection_head_source_tuple_chk', sql`
      (
        ${t.headRevision} = 0
        and ${t.currentSourceId} is null
        and ${t.currentSourceTaskId} is null
        and ${t.currentSourceWorkPackageId} is null
        and ${t.currentSourceKind} is null
        and ${t.currentSourceRevision} is null
        and ${t.currentSourceFingerprint} is null
        and ${t.contribution} = '{}'::jsonb
        and ${t.compareAndSetFingerprint} = ${t.headFingerprint}
      ) or (
        ${t.headRevision} > 0
        and ${t.currentSourceId} is not null
        and ${t.currentSourceTaskId} = ${t.taskId}
        and ${t.currentSourceWorkPackageId} = ${t.workPackageId}
        and ${t.currentSourceKind} = ${t.headKind}
        and ${t.currentSourceRevision} = ${t.headRevision}
        and ${t.currentSourceFingerprint} is not null
        and ${t.compareAndSetFingerprint} ~ '^sha256:[0-9a-f]{64}$'
      )
    `),
  ],
)

export type WorkPackageLocalProjectionHead = InferSelectModel<typeof workPackageLocalProjectionHeads>
export type NewWorkPackageLocalProjectionHead = InferInsertModel<typeof workPackageLocalProjectionHeads>

// ---------------------------------------------------------------------------
// workPackageDependencies
// ---------------------------------------------------------------------------
export const workPackageDependencies = pgTable(
  'work_package_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workPackageId: uuid('work_package_id')
      .notNull()
      .references(() => workPackages.id, { onDelete: 'restrict' }),
    dependsOnWorkPackageId: uuid('depends_on_work_package_id')
      .notNull()
      .references(() => workPackages.id, { onDelete: 'restrict' }),
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
      .references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'restrict',
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
    providerTypeUsed: text('provider_type_used'),
    providerIsLocalUsed: boolean('provider_is_local_used'),
    providerConfigUpdatedAtUsed: timestamp('provider_config_updated_at_used', tsOpts),
    acpExecutionMode: text('acp_execution_mode').notNull().default('not_applicable'),
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
// executionOutcomes
// ---------------------------------------------------------------------------
// Canonical, append-compatible outcome ledger. Existing task/package/run rows
// remain the authority for lifecycle state; this table records the normalized
// interpretation of one attempted execution.
export const executionOutcomes = pgTable(
  'execution_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Exactly one of taskId or verificationGoalRunId must be set. A row is
    // either a legacy task-owned outcome (schema v1) or a goal-owned outcome
    // (schema v2) with the goal-run foreign key populated.
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'restrict' }),
    verificationGoalRunId: uuid('verification_goal_run_id').references(() => verificationGoalRuns.id, { onDelete: 'restrict' }),
    // Admission may stop before a run or queue-attempt row exists.
    workPackageId: uuid('work_package_id').references(() => workPackages.id, { onDelete: 'set null' }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    taskAttemptId: uuid('task_attempt_id').references(() => taskAttempts.id, { onDelete: 'set null' }),
    attemptKey: text('attempt_key').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    transportStatus: text('transport_status').notNull(),
    result: text('result').notNull(),
    failureClass: text('failure_class'),
    stopReasonCode: text('stop_reason_code'),
    stopReasonSummary: text('stop_reason_summary'),
    retryable: boolean('retryable').notNull(),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    verifierRequired: boolean('verifier_required').notNull().default(false),
    verificationStatus: text('verification_status').notNull().default('not_required'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('execution_outcomes_task_attempt_key_idx').on(t.taskId, t.attemptKey),
    uniqueIndex('execution_outcomes_goal_attempt_key_idx')
      .on(t.verificationGoalRunId, t.attemptKey)
      .where(sql`${t.verificationGoalRunId} is not null`),
    index('execution_outcomes_verification_goal_run_id_idx').on(t.verificationGoalRunId),
    index('execution_outcomes_work_package_id_idx').on(t.workPackageId),
    index('execution_outcomes_agent_run_id_idx').on(t.agentRunId),
    index('execution_outcomes_task_attempt_id_idx').on(t.taskAttemptId),
    check('execution_outcomes_schema_version_check', sql`${t.schemaVersion} IN (1, 2)`),
    check('execution_outcomes_transport_status_check', sql`${t.transportStatus} IN ('ok', 'error')`),
    check('execution_outcomes_result_check', sql`${t.result} IN ('completed', 'partial', 'refused', 'blocked', 'needs_attention', 'failed', 'cancelled')`),
    check('execution_outcomes_failure_class_check', sql`${t.failureClass} IS NULL OR ${t.failureClass} IN ('functional', 'policy', 'authority', 'infrastructure', 'evidence', 'cancelled')`),
    check('execution_outcomes_stop_reason_code_check', sql`${t.stopReasonCode} IS NULL OR ${t.stopReasonCode} IN ('provider_transport_failure', 'model_refusal', 'invalid_output', 'validation_failed', 'missing_capability', 'admission_denied', 'policy_blocked', 'security_blocked', 'missing_repository_context', 'timeout', 'context_limit', 'output_limit', 'retry_exhausted', 'human_cancelled', 'unknown')`),
    check('execution_outcomes_verification_status_check', sql`${t.verificationStatus} IN ('not_required', 'pending', 'passed', 'failed', 'inconclusive')`),
    check('execution_outcomes_verifier_consistency_check', sql`(${t.verifierRequired} AND ${t.verificationStatus} IN ('pending', 'passed', 'failed', 'inconclusive')) OR (NOT ${t.verifierRequired} AND ${t.verificationStatus} = 'not_required')`),
    check('execution_outcomes_subject_check', sql`
      (
        ${t.taskId} is not null
        and ${t.verificationGoalRunId} is null
        and ${t.schemaVersion} = 1
      ) or (
        ${t.taskId} is null
        and ${t.verificationGoalRunId} is not null
        and ${t.schemaVersion} = 2
        and ${t.workPackageId} is null
        and ${t.agentRunId} is null
        and ${t.taskAttemptId} is null
      )
    `),
  ],
)

export type ExecutionOutcomeRow = InferSelectModel<typeof executionOutcomes>
export type NewExecutionOutcomeRow = InferInsertModel<typeof executionOutcomes>

// ---------------------------------------------------------------------------
// operationRuns and operationRunEvents
// ---------------------------------------------------------------------------
// A run has one immutable identity/idempotency tuple and is terminalized once.
// Detailed phase history is kept in the append-only event table below.
export const operationRuns = pgTable(
  'operation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Exactly one of taskId or verificationGoalRunId must be set. Goal rows
    // additionally store the canonical ordinal from the resolved run policy.
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'restrict' }),
    verificationGoalRunId: uuid('verification_goal_run_id').references(() => verificationGoalRuns.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, { onDelete: 'set null' }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    taskAttemptId: uuid('task_attempt_id').references(() => taskAttempts.id, { onDelete: 'set null' }),
    executionOutcomeId: uuid('execution_outcome_id').references(() => executionOutcomes.id, { onDelete: 'restrict' }),
    definitionSchemaVersion: integer('definition_schema_version').notNull().default(1),
    goalOperationOrdinal: integer('goal_operation_ordinal'),
    operationId: text('operation_id').notNull(),
    operationVersion: integer('operation_version').notNull(),
    capability: text('capability').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    definitionDigest: text('definition_digest').notNull(),
    scopeFingerprint: text('scope_fingerprint').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    inputsFingerprint: text('inputs_fingerprint').notNull(),
    reasonFingerprint: text('reason_fingerprint').notNull(),
    policyDecision: jsonb('policy_decision').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('running'),
    verificationStatus: text('verification_status').notNull().default('not_started'),
    outputFingerprint: text('output_fingerprint'),
    outcomeFingerprint: text('outcome_fingerprint'),
    startedAt: timestamp('started_at', tsOpts).defaultNow().notNull(),
    completedAt: timestamp('completed_at', tsOpts),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('operation_runs_task_idempotency_key_idx').on(t.taskId, t.idempotencyKey),
    uniqueIndex('operation_runs_goal_ordinal_idx')
      .on(t.verificationGoalRunId, t.goalOperationOrdinal)
      .where(sql`${t.verificationGoalRunId} is not null`),
    index('operation_runs_verification_goal_run_id_idx').on(t.verificationGoalRunId),
    index('operation_runs_project_id_created_at_idx').on(t.projectId, t.createdAt),
    index('operation_runs_operation_version_idx').on(t.operationId, t.operationVersion),
    index('operation_runs_execution_outcome_id_idx').on(t.executionOutcomeId),
    check('operation_runs_definition_schema_check', sql`${t.definitionSchemaVersion} = 1`),
    check('operation_runs_operation_version_check', sql`${t.operationVersion} > 0`),
    check('operation_runs_status_check', sql`${t.status} IN ('running', 'completed', 'blocked', 'failed')`),
    check('operation_runs_verification_status_check', sql`${t.verificationStatus} IN ('not_started', 'passed', 'failed', 'not_required', 'inconclusive')`),
    check('operation_runs_fingerprints_check', sql`
      ${t.idempotencyKey} ~ '^[0-9a-f]{64}$' AND
      ${t.definitionDigest} ~ '^[0-9a-f]{64}$' AND
      ${t.scopeFingerprint} ~ '^[0-9a-f]{64}$' AND
      ${t.requestFingerprint} ~ '^[0-9a-f]{64}$' AND
      ${t.inputsFingerprint} ~ '^[0-9a-f]{64}$' AND
      ${t.reasonFingerprint} ~ '^[0-9a-f]{64}$' AND
      (${t.outputFingerprint} IS NULL OR ${t.outputFingerprint} ~ '^[0-9a-f]{64}$')
      AND (${t.outcomeFingerprint} IS NULL OR ${t.outcomeFingerprint} ~ '^[0-9a-f]{64}$')
    `),
    check('operation_runs_terminal_shape_check', sql`
      (${t.status} = 'running' AND ${t.completedAt} IS NULL AND ${t.executionOutcomeId} IS NULL AND ${t.outcomeFingerprint} IS NULL) OR
      (${t.status} <> 'running' AND ${t.completedAt} IS NOT NULL AND ${t.executionOutcomeId} IS NOT NULL AND ${t.outcomeFingerprint} IS NOT NULL)
    `),
    check('operation_runs_subject_check', sql`
      (
        ${t.taskId} is not null
        and ${t.verificationGoalRunId} is null
        and ${t.goalOperationOrdinal} is null
      ) or (
        ${t.taskId} is null
        and ${t.verificationGoalRunId} is not null
        and ${t.goalOperationOrdinal} is not null
        and ${t.workPackageId} is null
        and ${t.agentRunId} is null
        and ${t.taskAttemptId} is null
      )
    `),
  ],
)

export type OperationRun = InferSelectModel<typeof operationRuns>
export type NewOperationRun = InferInsertModel<typeof operationRuns>

export const operationRunEvents = pgTable(
  'operation_run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationRunId: uuid('operation_run_id')
      .notNull()
      .references(() => operationRuns.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    phase: text('phase').notNull(),
    status: text('status').notNull(),
    detailCode: text('detail_code').notNull(),
    detailFingerprint: text('detail_fingerprint').notNull(),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('operation_run_events_run_sequence_idx').on(t.operationRunId, t.sequence),
    index('operation_run_events_run_created_at_idx').on(t.operationRunId, t.createdAt),
    check('operation_run_events_status_check', sql`${t.status} IN ('passed', 'blocked', 'failed')`),
    check('operation_run_events_detail_fingerprint_check', sql`${t.detailFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('operation_run_events_evidence_refs_check', sql`jsonb_typeof(${t.evidenceRefs}) = 'array'`),
    check('operation_run_events_phase_sequence_check', sql`
      (${t.phase} = 'request_validation' AND ${t.sequence} = 0) OR
      (${t.phase} = 'policy' AND ${t.sequence} = 1) OR
      (${t.phase} = 'preflight' AND ${t.sequence} = 2) OR
      (${t.phase} = 'execution' AND ${t.sequence} = 3) OR
      (${t.phase} = 'verification' AND ${t.sequence} = 4) OR
      (${t.phase} = 'outcome' AND ${t.sequence} = 5)
    `),
  ],
)

export type OperationRunEvent = InferSelectModel<typeof operationRunEvents>
export type NewOperationRunEvent = InferInsertModel<typeof operationRunEvents>

// ---------------------------------------------------------------------------
// capabilityAttempts and capabilityAttemptAdjudications
// ---------------------------------------------------------------------------
// Immutable, append-only capability reliability ledger (ADR 0012, issue #186).
// Attempts are one row per (execution_outcome_id, capability_key); later
// evidence (verification, human decisions, rollback, override, drift) is
// appended to the adjudications table rather than rewriting the attempt.
export const capabilityAttempts = pgTable(
  'capability_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptGroupId: uuid('attempt_group_id').notNull(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    // Exactly one of taskId or verificationGoalRunId must be set. Goal rows
    // use reliability contract v2 and keep task-only links null.
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'restrict' }),
    verificationGoalRunId: uuid('verification_goal_run_id').references(() => verificationGoalRuns.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, { onDelete: 'set null' }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    taskAttemptId: uuid('task_attempt_id').references(() => taskAttempts.id, { onDelete: 'set null' }),
    executionOutcomeId: uuid('execution_outcome_id').notNull().references(() => executionOutcomes.id, { onDelete: 'restrict' }),
    operationRunId: uuid('operation_run_id').references(() => operationRuns.id, { onDelete: 'set null' }),
    contractVersion: integer('contract_version').notNull().default(1),
    capabilityKey: text('capability_key').notNull(),
    classificationState: text('classification_state').notNull(),
    capabilityMultiplicity: integer('capability_multiplicity').notNull(),
    cohortFingerprint: text('cohort_fingerprint').notNull(),
    scopeFingerprint: text('scope_fingerprint').notNull(),
    runtimeFingerprint: text('runtime_fingerprint').notNull(),
    policyFingerprint: text('policy_fingerprint').notNull(),
    outcomeDigest: text('outcome_digest').notNull(),
    transportStatus: text('transport_status').notNull(),
    result: text('result').notNull(),
    stopReasonCode: text('stop_reason_code'),
    retryable: boolean('retryable').notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    severityClass: text('severity_class').notNull(),
    verifierRequired: boolean('verifier_required').notNull(),
    verificationMode: text('verification_mode').notNull(),
    verificationStatus: text('verification_status').notNull(),
    acceptanceCriteriaTotal: integer('acceptance_criteria_total').notNull().default(0),
    validationCommandTotal: integer('validation_command_total').notNull().default(0),
    validationCommandFailed: integer('validation_command_failed').notNull().default(0),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    observedAt: timestamp('observed_at', tsOpts).notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('capability_attempts_outcome_capability_idx').on(t.executionOutcomeId, t.capabilityKey),
    index('capability_attempts_cohort_observed_at_idx').on(t.cohortFingerprint, t.observedAt),
    index('capability_attempts_project_capability_idx').on(t.projectId, t.capabilityKey),
    index('capability_attempts_attempt_group_idx').on(t.attemptGroupId),
    index('capability_attempts_execution_outcome_idx').on(t.executionOutcomeId),
    index('capability_attempts_verification_goal_run_id_idx').on(t.verificationGoalRunId),
    check('capability_attempts_contract_version_check', sql`${t.contractVersion} IN (1, 2)`),
    check('capability_attempts_capability_key_check', sql`length(${t.capabilityKey}) <= 120 AND ${t.capabilityKey} ~ '^(workpackage:[a-z][a-z0-9-]{0,39}/[a-z][a-z0-9-]{0,39}|operation:[a-z][a-z0-9]*([._-][a-z0-9]+)+@[1-9][0-9]{0,3})$'`),
    check('capability_attempts_classification_state_check', sql`${t.classificationState} IN ('classified', 'missing', 'overflow')`),
    check('capability_attempts_capability_multiplicity_check', sql`${t.capabilityMultiplicity} BETWEEN 1 AND 12`),
    check('capability_attempts_cohort_fingerprint_check', sql`${t.cohortFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('capability_attempts_scope_fingerprint_check', sql`${t.scopeFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('capability_attempts_runtime_fingerprint_check', sql`${t.runtimeFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('capability_attempts_policy_fingerprint_check', sql`${t.policyFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('capability_attempts_outcome_digest_check', sql`${t.outcomeDigest} ~ '^[0-9a-f]{64}$'`),
    check('capability_attempts_transport_status_check', sql`${t.transportStatus} IN ('ok', 'error')`),
    check('capability_attempts_result_check', sql`${t.result} IN ('completed', 'partial', 'refused', 'blocked', 'needs_attention', 'failed', 'cancelled')`),
    check('capability_attempts_stop_reason_code_check', sql`${t.stopReasonCode} IS NULL OR ${t.stopReasonCode} IN ('provider_transport_failure', 'model_refusal', 'invalid_output', 'validation_failed', 'missing_capability', 'admission_denied', 'policy_blocked', 'security_blocked', 'missing_repository_context', 'timeout', 'context_limit', 'output_limit', 'retry_exhausted', 'human_cancelled', 'unknown')`),
    check('capability_attempts_attempt_number_check', sql`${t.attemptNumber} >= 1`),
    check('capability_attempts_severity_class_check', sql`${t.severityClass} IN ('normal', 'critical')`),
    check('capability_attempts_verification_mode_value_check', sql`${t.verificationMode} IN ('none', 'self_reported', 'human_review', 'deterministic_adapter', 'independent_agent')`),
    check('capability_attempts_verification_status_check', sql`${t.verificationStatus} IN ('not_required', 'pending', 'passed', 'failed', 'inconclusive')`),
    check('capability_attempts_acceptance_criteria_total_check', sql`${t.acceptanceCriteriaTotal} >= 0`),
    check('capability_attempts_validation_command_total_check', sql`${t.validationCommandTotal} >= 0`),
    check('capability_attempts_validation_command_failed_check', sql`${t.validationCommandFailed} >= 0 AND ${t.validationCommandFailed} <= ${t.validationCommandTotal}`),
    check('capability_attempts_evidence_refs_check', sql`pg_catalog.jsonb_typeof(${t.evidenceRefs}) = 'array' AND pg_catalog.jsonb_array_length(${t.evidenceRefs}) <= 128 AND ${t.evidenceRefs}::text ~ '^\\[\\]$|^\\["[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89a-bA-B][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"(, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89a-bA-B][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")*\\]$'`),
    check('capability_attempts_verifier_consistency_check', sql`(${t.verifierRequired} AND ${t.verificationStatus} IN ('pending', 'passed', 'failed', 'inconclusive')) OR (NOT ${t.verifierRequired} AND ${t.verificationStatus} = 'not_required')`),
    check('capability_attempts_verification_mode_check', sql`(${t.verificationMode} = 'none') = (NOT ${t.verifierRequired})`),
    check('capability_attempts_unclassified_check', sql`(${t.classificationState} = 'classified') OR ${t.capabilityKey} LIKE 'workpackage:%/unclassified'`),
    check('capability_attempts_operation_runtime_check', sql`${t.operationRunId} IS NULL OR ${t.verificationMode} IN ('none', 'deterministic_adapter')`),
    check('capability_attempts_subject_check', sql`
      (
        ${t.taskId} is not null
        and ${t.verificationGoalRunId} is null
        and ${t.contractVersion} = 1
      ) or (
        ${t.taskId} is null
        and ${t.verificationGoalRunId} is not null
        and ${t.contractVersion} = 2
        and ${t.workPackageId} is null
        and ${t.agentRunId} is null
        and ${t.taskAttemptId} is null
      )
    `),
  ],
)

export type CapabilityAttempt = InferSelectModel<typeof capabilityAttempts>
export type NewCapabilityAttempt = InferInsertModel<typeof capabilityAttempts>

export const capabilityAttemptAdjudications = pgTable(
  'capability_attempt_adjudications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capabilityAttemptId: uuid('capability_attempt_id').notNull().references(() => capabilityAttempts.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    verificationMode: text('verification_mode'),
    verificationResult: text('verification_result'),
    humanDecision: text('human_decision'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    approvalGateId: uuid('approval_gate_id').references(() => approvalGates.id, { onDelete: 'set null' }),
    observedOutcomeDigest: text('observed_outcome_digest'),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    observedAt: timestamp('observed_at', tsOpts).notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('capability_attempt_adjudications_attempt_sequence_idx').on(t.capabilityAttemptId, t.sequence),
    index('capability_attempt_adjudications_attempt_observed_at_idx').on(t.capabilityAttemptId, t.observedAt),
    check('capability_attempt_adjudications_sequence_check', sql`${t.sequence} >= 0`),
    check('capability_attempt_adjudications_kind_check', sql`${t.kind} IN ('verification_recorded', 'human_decision', 'rollback_recorded', 'override_recorded', 'evidence_drift_detected')`),
    check('capability_attempt_adjudications_verification_mode_check', sql`${t.verificationMode} IS NULL OR ${t.verificationMode} IN ('none', 'self_reported', 'human_review', 'deterministic_adapter', 'independent_agent')`),
    check('capability_attempt_adjudications_verification_result_check', sql`${t.verificationResult} IS NULL OR ${t.verificationResult} IN ('passed', 'failed', 'inconclusive')`),
    check('capability_attempt_adjudications_human_decision_check', sql`${t.humanDecision} IS NULL OR ${t.humanDecision} IN ('accepted', 'rejected', 'cancelled')`),
    check('capability_attempt_adjudications_observed_outcome_digest_check', sql`${t.observedOutcomeDigest} IS NULL OR ${t.observedOutcomeDigest} ~ '^[0-9a-f]{64}$'`),
    check('capability_attempt_adjudications_evidence_refs_check', sql`pg_catalog.jsonb_typeof(${t.evidenceRefs}) = 'array' AND pg_catalog.jsonb_array_length(${t.evidenceRefs}) <= 128 AND ${t.evidenceRefs}::text ~ '^\\[\\]$|^\\["[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89a-bA-B][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"(, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89a-bA-B][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")*\\]$'`),
    check('capability_attempt_adjudications_kind_shape_check', sql`
      (${t.kind} = 'verification_recorded'
        AND ${t.verificationMode} IS NOT NULL AND ${t.verificationResult} IS NOT NULL
        AND ${t.humanDecision} IS NULL AND ${t.observedOutcomeDigest} IS NULL)
      OR (${t.kind} = 'human_decision'
        AND ${t.humanDecision} IS NOT NULL
        AND ${t.verificationMode} IS NULL AND ${t.verificationResult} IS NULL
        AND ${t.observedOutcomeDigest} IS NULL)
      OR (${t.kind} IN ('rollback_recorded', 'override_recorded')
        AND ${t.verificationMode} IS NULL AND ${t.verificationResult} IS NULL
        AND ${t.humanDecision} IS NULL AND ${t.observedOutcomeDigest} IS NULL)
      OR (${t.kind} = 'evidence_drift_detected'
        AND ${t.observedOutcomeDigest} IS NOT NULL
        AND ${t.verificationMode} IS NULL AND ${t.verificationResult} IS NULL AND ${t.humanDecision} IS NULL)
    `),
  ],
)

export type CapabilityAttemptAdjudication = InferSelectModel<typeof capabilityAttemptAdjudications>
export type NewCapabilityAttemptAdjudication = InferInsertModel<typeof capabilityAttemptAdjudications>

// ---------------------------------------------------------------------------
// verificationGoalSnapshots
// ---------------------------------------------------------------------------
// Repository-backed verification goals are imported as immutable snapshots.
// This table records definitions only; a row does not mean a goal ran, passed,
// or produced evidence.
export const verificationGoalSnapshots = pgTable(
  'verification_goal_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    goalId: text('goal_id').notNull(),
    definitionVersion: integer('definition_version').notNull(),
    canonicalDefinition: jsonb('canonical_definition').$type<Record<string, unknown>>().notNull(),
    definitionDigest: text('definition_digest').notNull(),
    sourcePath: text('source_path').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_snapshots_project_goal_version_idx')
      .on(t.projectId, t.goalId, t.definitionVersion),
    uniqueIndex('verification_goal_snapshots_id_project_idx')
      .on(t.id, t.projectId),
    uniqueIndex('verification_goal_snapshots_registry_entry_identity_idx')
      .on(t.id, t.projectId, t.goalId, t.definitionVersion, t.definitionDigest),
    index('verification_goal_snapshots_project_goal_created_at_idx')
      .on(t.projectId, t.goalId, t.createdAt),
    check('verification_goal_snapshots_goal_id_check', sql`
      length(${t.goalId}) BETWEEN 1 AND 64
      AND ${t.goalId} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    `),
    check('verification_goal_snapshots_definition_version_check', sql`
      ${t.definitionVersion} BETWEEN 1 AND 1000000
    `),
    check('verification_goal_snapshots_definition_digest_check', sql`
      ${t.definitionDigest} ~ '^[0-9a-f]{64}$'
    `),
    check('verification_goal_snapshots_source_path_check', sql`
      length(${t.sourcePath}) <= 256
      AND ${t.sourcePath} ~ '^\\.forge/verification-goals/[A-Za-z0-9][A-Za-z0-9._-]{0,126}\\.json$'
    `),
    check('verification_goal_snapshots_canonical_definition_check', sql`
      pg_catalog.jsonb_typeof(${t.canonicalDefinition}) = 'object'
      AND pg_catalog.octet_length(${t.canonicalDefinition}::text) <= 32768
      AND ${t.canonicalDefinition} ?& ARRAY[
        'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
        'capability', 'severity', 'enabled', 'operations'
      ]
      AND (${t.canonicalDefinition} - ARRAY[
        'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
        'capability', 'severity', 'enabled', 'operations'
      ]) = '{}'::jsonb
      AND ${t.canonicalDefinition} @> pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'goalId', ${t.goalId},
        'definitionVersion', ${t.definitionVersion}
      )
      AND pg_catalog.jsonb_typeof(${t.canonicalDefinition} -> 'enabled') = 'boolean'
      AND (${t.canonicalDefinition} ->> 'severity') IN ('low', 'medium', 'high', 'critical')
      AND pg_catalog.jsonb_typeof(${t.canonicalDefinition} -> 'operations') = 'array'
      AND pg_catalog.jsonb_array_length(${t.canonicalDefinition} -> 'operations') BETWEEN 1 AND 16
    `),
  ],
)

export type VerificationGoalSnapshot = InferSelectModel<typeof verificationGoalSnapshots>
export type NewVerificationGoalSnapshot = InferInsertModel<typeof verificationGoalSnapshots>

// ---------------------------------------------------------------------------
// verificationGoalRegistryRevisions / Entries / Heads
// ---------------------------------------------------------------------------
// Revisions and entries are immutable descriptions of one complete repository
// registry. The head is the sole mutable projection and only moves to a higher
// per-project sequence. None of these rows authorizes execution.
export const verificationGoalRegistryRevisions = pgTable(
  'verification_goal_registry_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    revisionSequence: bigint('revision_sequence', { mode: 'bigint' }).notNull(),
    manifestSchemaVersion: integer('manifest_schema_version').notNull().default(1),
    manifestDigest: text('manifest_digest').notNull(),
    applicationAssertedActorUserId: uuid('application_asserted_actor_user_id').notNull().references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    projectSubmittedBy: uuid('project_submitted_by').notNull().references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    projectArchivedAt: timestamp('project_archived_at', tsOpts),
    projectLocalPath: text('project_local_path').notNull(),
    rootRef: uuid('root_ref').notNull(),
    rootBindingRevision: bigint('root_binding_revision', { mode: 'bigint' }).notNull(),
    grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' }).notNull(),
    projectRevision: timestamp('project_revision', tsOpts).notNull(),
    predecessorRevisionId: uuid('predecessor_revision_id'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_registry_revisions_project_sequence_idx')
      .on(t.projectId, t.revisionSequence),
    uniqueIndex('verification_goal_registry_revisions_id_project_idx')
      .on(t.id, t.projectId),
    uniqueIndex('verification_goal_registry_revisions_id_project_sequence_idx')
      .on(t.id, t.projectId, t.revisionSequence),
    unique('verification_goal_registry_revisions_transition_identity_unique').on(
      t.projectId,
      t.predecessorRevisionId,
      t.rootRef,
      t.rootBindingRevision,
      t.grantDecisionRevision,
      t.projectRevision,
      t.manifestDigest,
    ).nullsNotDistinct(),
    foreignKey({
      columns: [t.predecessorRevisionId, t.projectId],
      foreignColumns: [t.id, t.projectId],
      name: 'verification_goal_registry_revisions_predecessor_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('verification_goal_registry_revisions_sequence_check', sql`${t.revisionSequence} > 0`),
    check('verification_goal_registry_revisions_manifest_schema_check', sql`${t.manifestSchemaVersion} in (1, 2)`),
    check('verification_goal_registry_revisions_manifest_digest_check', sql`
      ${t.manifestDigest} ~ '^[0-9a-f]{64}$'
    `),
    check('verification_goal_registry_revisions_asserted_actor_check', sql`
      ${t.applicationAssertedActorUserId} = ${t.projectSubmittedBy}
    `),
    check('verification_goal_registry_revisions_archived_check', sql`
      ${t.projectArchivedAt} is null
    `),
    check('verification_goal_registry_revisions_local_path_check', sql`
      length(${t.projectLocalPath}) between 1 and 4096
    `),
    check('verification_goal_registry_revisions_authority_revision_check', sql`
      ${t.rootBindingRevision} >= 0 and ${t.grantDecisionRevision} >= 0
    `),
  ],
)

export const verificationGoalRegistryEntries = pgTable(
  'verification_goal_registry_entries',
  {
    registryRevisionId: uuid('registry_revision_id').notNull(),
    projectId: uuid('project_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    goalId: text('goal_id').notNull(),
    definitionVersion: integer('definition_version').notNull(),
    definitionDigest: text('definition_digest').notNull(),
    sourcePath: text('source_path').notNull(),
    entrySchemaVersion: integer('entry_schema_version').notNull().default(1),
    executionBinding: jsonb('execution_binding').$type<Record<string, unknown>>(),
    executionBindingDigest: text('execution_binding_digest'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.registryRevisionId, t.ordinal],
      name: 'verification_goal_registry_entries_pk',
    }),
    uniqueIndex('verification_goal_registry_entries_revision_goal_idx')
      .on(t.registryRevisionId, t.goalId),
    index('verification_goal_registry_entries_project_goal_idx')
      .on(t.projectId, t.goalId),
    foreignKey({
      columns: [t.registryRevisionId, t.projectId],
      foreignColumns: [verificationGoalRegistryRevisions.id, verificationGoalRegistryRevisions.projectId],
      name: 'verification_goal_registry_entries_revision_project_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    foreignKey({
      columns: [
        t.snapshotId,
        t.projectId,
        t.goalId,
        t.definitionVersion,
        t.definitionDigest,
      ],
      foreignColumns: [
        verificationGoalSnapshots.id,
        verificationGoalSnapshots.projectId,
        verificationGoalSnapshots.goalId,
        verificationGoalSnapshots.definitionVersion,
        verificationGoalSnapshots.definitionDigest,
      ],
      name: 'verification_goal_registry_entries_snapshot_project_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('verification_goal_registry_entries_ordinal_check', sql`${t.ordinal} >= 0`),
    check('verification_goal_registry_entries_goal_id_check', sql`
      length(${t.goalId}) between 1 and 64
      and ${t.goalId} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    `),
    check('verification_goal_registry_entries_definition_version_check', sql`
      ${t.definitionVersion} between 1 and 1000000
    `),
    check('verification_goal_registry_entries_definition_digest_check', sql`
      ${t.definitionDigest} ~ '^[0-9a-f]{64}$'
    `),
    check('verification_goal_registry_entries_source_path_check', sql`
      length(${t.sourcePath}) <= 256
      and ${t.sourcePath} ~ '^\\.forge/verification-goals/[A-Za-z0-9][A-Za-z0-9._-]{0,126}\\.json$'
    `),
    check('verification_goal_registry_entries_schema_binding_check', sql`
      (
        ${t.entrySchemaVersion} = 1
        and ${t.executionBinding} is null
        and ${t.executionBindingDigest} is null
      ) or (
        ${t.entrySchemaVersion} = 2
        and pg_catalog.jsonb_typeof(${t.executionBinding}) = 'object'
        and pg_catalog.octet_length(${t.executionBinding}::text) <= 32768
        and ${t.executionBindingDigest} ~ '^[0-9a-f]{64}$'
        and ${t.executionBinding} ->> 'executionBindingDigest' = ${t.executionBindingDigest}
        and ${t.executionBinding} ->> 'schemaVersion' = '1'
        and ${t.executionBinding} ->> 'eligibilityPolicyVersion' = '1'
        and pg_catalog.jsonb_typeof(${t.executionBinding} -> 'operations') = 'array'
        and pg_catalog.jsonb_array_length(${t.executionBinding} -> 'operations') between 1 and 16
      )
    `),
  ],
)

export const verificationGoalRegistryHeads = pgTable(
  'verification_goal_registry_heads',
  {
    projectId: uuid('project_id').primaryKey().references(() => projects.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    registryRevisionId: uuid('registry_revision_id').notNull(),
    revisionSequence: bigint('revision_sequence', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_registry_heads_revision_idx').on(t.registryRevisionId),
    foreignKey({
      columns: [t.registryRevisionId, t.projectId, t.revisionSequence],
      foreignColumns: [
        verificationGoalRegistryRevisions.id,
        verificationGoalRegistryRevisions.projectId,
        verificationGoalRegistryRevisions.revisionSequence,
      ],
      name: 'verification_goal_registry_heads_revision_project_sequence_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('verification_goal_registry_heads_sequence_check', sql`${t.revisionSequence} > 0`),
  ],
)

export type VerificationGoalRegistryRevision = InferSelectModel<typeof verificationGoalRegistryRevisions>
export type NewVerificationGoalRegistryRevision = InferInsertModel<typeof verificationGoalRegistryRevisions>
export type VerificationGoalRegistryEntry = InferSelectModel<typeof verificationGoalRegistryEntries>
export type NewVerificationGoalRegistryEntry = InferInsertModel<typeof verificationGoalRegistryEntries>
export type VerificationGoalRegistryHead = InferSelectModel<typeof verificationGoalRegistryHeads>
export type NewVerificationGoalRegistryHead = InferInsertModel<typeof verificationGoalRegistryHeads>

// ---------------------------------------------------------------------------
// verificationGoalPolicyRevisions / verificationGoalPolicyHeads
// ---------------------------------------------------------------------------
// Per-project verification execution policy. Revisions are immutable; the head
// moves forward only through the protected compare-and-set routine. A missing
// head means execution is denied for that project.
export const verificationGoalPolicyRevisions = pgTable(
  'verification_goal_policy_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    revisionSequence: bigint('revision_sequence', { mode: 'bigint' }).notNull(),
    policyDigest: text('policy_digest').notNull(),
    manualEnabled: boolean('manual_enabled').notNull().default(false),
    schedulingEnabled: boolean('scheduling_enabled').notNull().default(false),
    minScheduleIntervalSeconds: bigint('min_schedule_interval_seconds', { mode: 'bigint' }).notNull(),
    maxRunDeadlineSeconds: bigint('max_run_deadline_seconds', { mode: 'bigint' }).notNull(),
    maxQueueAgeSeconds: bigint('max_queue_age_seconds', { mode: 'bigint' }).notNull(),
    maxOperationsPerRun: integer('max_operations_per_run').notNull(),
    maxConcurrentRuns: integer('max_concurrent_runs').notNull(),
    maxQueuedRuns: integer('max_queued_runs').notNull(),
    maxActiveRuns: integer('max_active_runs').notNull(),
    startBudgetWindowSeconds: bigint('start_budget_window_seconds', { mode: 'bigint' }).notNull(),
    maxStartsPerWindow: bigint('max_starts_per_window', { mode: 'bigint' }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    predecessorRevisionId: uuid('predecessor_revision_id'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_policy_revisions_project_sequence_idx')
      .on(t.projectId, t.revisionSequence),
    uniqueIndex('verification_goal_policy_revisions_id_project_idx')
      .on(t.id, t.projectId),
    uniqueIndex('verification_goal_policy_revisions_id_project_sequence_idx')
      .on(t.id, t.projectId, t.revisionSequence),
    foreignKey({
      columns: [t.predecessorRevisionId, t.projectId],
      foreignColumns: [t.id, t.projectId],
      name: 'verification_goal_policy_revisions_predecessor_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('verification_goal_policy_revisions_sequence_check', sql`${t.revisionSequence} > 0`),
    check('verification_goal_policy_revisions_policy_digest_check', sql`
      ${t.policyDigest} ~ '^[0-9a-f]{64}$'
    `),
    check('verification_goal_policy_revisions_actor_kind_check', sql`
      ${t.actorKind} in ('migration_seed', 'system_default', 'human')
    `),
    check('verification_goal_policy_revisions_actor_shape_check', sql`
      (
        ${t.actorKind} in ('migration_seed', 'system_default')
        and ${t.actorUserId} is null
      ) or (
        ${t.actorKind} = 'human'
        and ${t.actorUserId} is not null
      )
    `),
    check('verification_goal_policy_revisions_positive_bounds_check', sql`
      ${t.minScheduleIntervalSeconds} > 0
      and ${t.maxRunDeadlineSeconds} > 0
      and ${t.maxQueueAgeSeconds} > 0
      and ${t.maxOperationsPerRun} > 0
      and ${t.maxConcurrentRuns} > 0
      and ${t.maxQueuedRuns} > 0
      and ${t.maxActiveRuns} > 0
      and ${t.startBudgetWindowSeconds} > 0
      and ${t.maxStartsPerWindow} > 0
    `),
  ],
)

export type VerificationGoalPolicyRevision = InferSelectModel<typeof verificationGoalPolicyRevisions>
export type NewVerificationGoalPolicyRevision = InferInsertModel<typeof verificationGoalPolicyRevisions>

export const verificationGoalPolicyHeads = pgTable(
  'verification_goal_policy_heads',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    policyRevisionId: uuid('policy_revision_id').notNull(),
    revisionSequence: bigint('revision_sequence', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_policy_heads_revision_idx').on(t.policyRevisionId),
    foreignKey({
      columns: [t.policyRevisionId, t.projectId, t.revisionSequence],
      foreignColumns: [
        verificationGoalPolicyRevisions.id,
        verificationGoalPolicyRevisions.projectId,
        verificationGoalPolicyRevisions.revisionSequence,
      ],
      name: 'verification_goal_policy_heads_revision_project_sequence_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('verification_goal_policy_heads_sequence_check', sql`${t.revisionSequence} > 0`),
  ],
)

export type VerificationGoalPolicyHead = InferSelectModel<typeof verificationGoalPolicyHeads>
export type NewVerificationGoalPolicyHead = InferInsertModel<typeof verificationGoalPolicyHeads>

// ---------------------------------------------------------------------------
// verificationGoalRuns / verificationGoalEvents
// ---------------------------------------------------------------------------
// A verification goal run binds an exact registry entry, exact project policy,
// and immutable resolved policy snapshot. Its lifecycle is managed through
// protected routines; completed evidence is append-only.
export const verificationGoalRuns = pgTable(
  'verification_goal_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    registryRevisionId: uuid('registry_revision_id').notNull(),
    registryEntryOrdinal: integer('registry_entry_ordinal').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    goalId: text('goal_id').notNull(),
    definitionVersion: integer('definition_version').notNull(),
    definitionDigest: text('definition_digest').notNull(),
    sourcePath: text('source_path').notNull(),
    executionBindingDigest: text('execution_binding_digest'),
    policyRevisionId: uuid('policy_revision_id').notNull(),
    policyRevisionSequence: bigint('policy_revision_sequence', { mode: 'bigint' }).notNull(),
    resolvedPolicy: jsonb('resolved_policy').$type<Record<string, unknown>>().notNull(),
    resolvedPolicyFingerprint: text('resolved_policy_fingerprint').notNull(),
    triggerKind: text('trigger_kind').notNull(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    manualIdempotencyKey: uuid('manual_idempotency_key'),
    manualRequestFingerprint: text('manual_request_fingerprint'),
    scheduleBindingId: uuid('schedule_binding_id').references(() => verificationGoalScheduleBindings.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    scheduleSlotId: uuid('schedule_slot_id'),
    admissionExpiry: timestamp('admission_expiry', tsOpts).notNull(),
    authorityFingerprint: text('authority_fingerprint').notNull(),
    status: text('status').notNull().default('queued'),
    result: text('result'),
    terminalCode: text('terminal_code'),
    overallOutcomeId: uuid('overall_outcome_id'),
    goalEvidenceSetDigest: text('goal_evidence_set_digest'),
    goalEvidenceUnitFingerprint: text('goal_evidence_unit_fingerprint'),
    leaseGeneration: bigint('lease_generation', { mode: 'bigint' }),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', tsOpts),
    startedAt: timestamp('started_at', tsOpts),
    finishedAt: timestamp('finished_at', tsOpts),
    recoveryNotBefore: timestamp('recovery_not_before', tsOpts),
    redisDispatchedAt: timestamp('redis_dispatched_at', tsOpts),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_runs_active_project_goal_idx')
      .on(t.projectId, t.goalId)
      .where(sql`${t.status} in ('queued', 'running', 'recovery_required')`),
    uniqueIndex('verification_goal_runs_manual_idempotency_idx')
      .on(t.requestedByUserId, t.manualIdempotencyKey)
      .where(sql`${t.manualIdempotencyKey} is not null`),
    index('verification_goal_runs_project_status_created_idx')
      .on(t.projectId, t.status, t.createdAt),
    index('verification_goal_runs_project_goal_finished_idx')
      .on(t.projectId, t.goalId, t.finishedAt),
    index('verification_goal_runs_project_created_idx')
      .on(t.projectId, t.createdAt),
    index('verification_goal_runs_status_expiries_recovery_idx')
      .on(t.status, t.leaseExpiresAt, t.recoveryNotBefore),
    index('verification_goal_runs_redis_dispatch_idx')
      .on(t.status, t.redisDispatchedAt)
      .where(sql`${t.status} = 'queued'`),
    index('verification_goal_runs_snapshot_history_idx')
      .on(t.snapshotId, t.createdAt),
    foreignKey({
      columns: [t.registryRevisionId, t.registryEntryOrdinal],
      foreignColumns: [verificationGoalRegistryEntries.registryRevisionId, verificationGoalRegistryEntries.ordinal],
      name: 'verification_goal_runs_registry_entry_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    foreignKey({
      columns: [
        t.snapshotId,
        t.projectId,
        t.goalId,
        t.definitionVersion,
        t.definitionDigest,
      ],
      foreignColumns: [
        verificationGoalSnapshots.id,
        verificationGoalSnapshots.projectId,
        verificationGoalSnapshots.goalId,
        verificationGoalSnapshots.definitionVersion,
        verificationGoalSnapshots.definitionDigest,
      ],
      name: 'verification_goal_runs_snapshot_identity_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    foreignKey({
      columns: [t.policyRevisionId, t.projectId, t.policyRevisionSequence],
      foreignColumns: [
        verificationGoalPolicyRevisions.id,
        verificationGoalPolicyRevisions.projectId,
        verificationGoalPolicyRevisions.revisionSequence,
      ],
      name: 'verification_goal_runs_policy_revision_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('verification_goal_runs_status_check', sql`
      ${t.status} in ('queued', 'running', 'recovery_required', 'completed', 'expired')
    `),
    check('verification_goal_runs_result_check', sql`
      ${t.result} is null or ${t.result} in ('passed', 'failed', 'inconclusive')
    `),
    check('verification_goal_runs_terminal_code_check', sql`
      ${t.terminalCode} is null
      or ${t.terminalCode} in (
        'passed', 'functional_operation_failed', 'functional_verification_failed',
        'repository_dirty', 'repository_changed', 'root_changed',
        'registry_content_changed', 'registry_superseded', 'registry_authority_changed',
        'policy_changed', 'filesystem_authority_changed', 'operation_contract_changed',
        'required_verifier_unavailable', 'linked_worktree_unsupported',
        'unsupported_git_metadata_layout', 'unsupported_git_config',
        'partial_clone_unsupported', 'incomplete_object_store',
        'sparse_checkout_unsupported', 'split_index_unsupported',
        'grafts_unsupported', 'goal_definition_untracked', 'git_version_unsupported',
        'git_executable_untrusted', 'submodule_repository_unsupported',
        'unsupported_repository_identity', 'missing_required_evidence',
        'operation_infrastructure_failed', 'operation_evidence_failed',
        'execution_deadline_exceeded', 'lease_lost', 'system_execution_disabled',
        'internal_infrastructure_error', 'dispatch_expired'
      )
    `),
    check('verification_goal_runs_trigger_kind_check', sql`${t.triggerKind} in ('manual', 'scheduled')`),
    check('verification_goal_runs_manual_shape_check', sql`
      (${t.triggerKind} <> 'manual')
      or (
        ${t.requestedByUserId} is not null
        and ${t.manualIdempotencyKey} is not null
        and ${t.manualRequestFingerprint} is not null
        and ${t.scheduleBindingId} is null
        and ${t.scheduleSlotId} is null
      )
    `),
    check('verification_goal_runs_scheduled_shape_check', sql`
      (${t.triggerKind} <> 'scheduled')
      or (
        ${t.requestedByUserId} is null
        and ${t.manualIdempotencyKey} is null
        and ${t.manualRequestFingerprint} is null
        and ${t.scheduleBindingId} is not null
        and ${t.scheduleSlotId} is not null
      )
    `),
    check('verification_goal_runs_queued_shape_check', sql`
      (${t.status} <> 'queued')
      or (
        ${t.startedAt} is null
        and ${t.result} is null
        and ${t.terminalCode} is null
        and ${t.overallOutcomeId} is null
        and ${t.goalEvidenceSetDigest} is null
        and ${t.goalEvidenceUnitFingerprint} is null
        and ${t.leaseGeneration} is null
        and ${t.leaseToken} is null
        and ${t.leaseExpiresAt} is null
        and ${t.finishedAt} is null
        and ${t.recoveryNotBefore} is null
      )
    `),
    check('verification_goal_runs_running_shape_check', sql`
      (${t.status} <> 'running')
      or (
        ${t.startedAt} is not null
        and ${t.result} is null
        and ${t.terminalCode} is null
        and ${t.overallOutcomeId} is null
        and ${t.goalEvidenceSetDigest} is null
        and ${t.goalEvidenceUnitFingerprint} is null
        and ${t.leaseGeneration} is not null
        and ${t.leaseToken} is not null
        and ${t.leaseExpiresAt} is not null
        and ${t.finishedAt} is null
        and ${t.recoveryNotBefore} is null
      )
    `),
    check('verification_goal_runs_recovery_shape_check', sql`
      (${t.status} <> 'recovery_required')
      or (
        ${t.startedAt} is not null
        and ${t.result} is null
        and ${t.terminalCode} is null
        and ${t.overallOutcomeId} is null
        and ${t.goalEvidenceSetDigest} is null
        and ${t.goalEvidenceUnitFingerprint} is null
        and ${t.leaseGeneration} is null
        and ${t.leaseToken} is null
        and ${t.leaseExpiresAt} is null
        and ${t.recoveryNotBefore} is not null
      )
    `),
    check('verification_goal_runs_completed_shape_check', sql`
      (${t.status} <> 'completed')
      or (
        ${t.startedAt} is not null
        and ${t.finishedAt} is not null
        and ${t.result} is not null
        and ${t.terminalCode} is not null
        and ${t.overallOutcomeId} is not null
        and ${t.goalEvidenceSetDigest} is not null
        and ${t.goalEvidenceUnitFingerprint} is not null
        and ${t.leaseGeneration} is null
        and ${t.leaseToken} is null
        and ${t.leaseExpiresAt} is null
      )
    `),
    check('verification_goal_runs_expired_shape_check', sql`
      (${t.status} <> 'expired')
      or (
        ${t.startedAt} is null
        and ${t.finishedAt} is not null
        and ${t.result} is null
        and ${t.terminalCode} = 'dispatch_expired'
        and ${t.overallOutcomeId} is null
        and ${t.goalEvidenceSetDigest} is null
        and ${t.goalEvidenceUnitFingerprint} is null
        and ${t.leaseGeneration} is null
        and ${t.leaseToken} is null
        and ${t.leaseExpiresAt} is null
      )
    `),
  ],
)

export type VerificationGoalRun = InferSelectModel<typeof verificationGoalRuns>
export type NewVerificationGoalRun = InferInsertModel<typeof verificationGoalRuns>

export const verificationGoalEvents = pgTable(
  'verification_goal_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verificationGoalRunId: uuid('verification_goal_run_id')
      .notNull()
      .references(() => verificationGoalRuns.id, { onDelete: 'restrict' }),
    eventSequence: integer('event_sequence').notNull(),
    phase: text('phase').notNull(),
    status: text('status').notNull(),
    code: text('code'),
    operationRunId: uuid('operation_run_id').references(() => operationRuns.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    repositorySnapshotId: uuid('repository_snapshot_id').references(() => verificationGoalRepositorySnapshots.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    environmentSnapshotId: uuid('environment_snapshot_id').references(() => verificationGoalEnvironmentSnapshots.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    evidenceRef: uuid('evidence_ref'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_events_run_sequence_idx')
      .on(t.verificationGoalRunId, t.eventSequence),
    index('verification_goal_events_run_created_idx')
      .on(t.verificationGoalRunId, t.createdAt),
    check('verification_goal_events_phase_check', sql`
      ${t.phase} in (
        'admitted', 'claimed', 'repository_captured', 'environment_captured',
        'child_begun', 'child_completed', 'terminalized', 'expired', 'recovered'
      )
    `),
    check('verification_goal_events_status_check', sql`
      ${t.status} in ('ok', 'blocked', 'failed', 'inconclusive')
    `),
    check('verification_goal_events_code_check', sql`
      ${t.code} is null or length(${t.code}) between 1 and 64
    `),
  ],
)

export type VerificationGoalEvent = InferSelectModel<typeof verificationGoalEvents>
export type NewVerificationGoalEvent = InferInsertModel<typeof verificationGoalEvents>

// ---------------------------------------------------------------------------
// verificationGoalRepositorySnapshots / verificationGoalEnvironmentSnapshots
// ---------------------------------------------------------------------------
// Immutable evidence captured during a run. Each run has at most one of each
// snapshot. Raw repository config and local paths are never stored here.
export const verificationGoalRepositorySnapshots = pgTable(
  'verification_goal_repository_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verificationGoalRunId: uuid('verification_goal_run_id')
      .notNull()
      .references(() => verificationGoalRuns.id, { onDelete: 'restrict' })
      .unique(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    projectSubmittedBy: uuid('project_submitted_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    projectRevision: timestamp('project_revision', tsOpts).notNull(),
    rootBindingRevision: bigint('root_binding_revision', { mode: 'bigint' }).notNull(),
    grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' }).notNull(),
    objectFormat: text('object_format'),
    headOid: text('head_oid'),
    strictGitClean: boolean('strict_git_clean').notNull().default(false),
    gitMetadataFingerprint: text('git_metadata_fingerprint'),
    indexFingerprint: text('index_fingerprint'),
    configFingerprint: text('config_fingerprint'),
    repositorySnapshotFingerprint: text('repository_snapshot_fingerprint').notNull(),
    capturedAt: timestamp('captured_at', tsOpts).notNull(),
  },
  (t) => [
    index('verification_goal_repository_snapshots_project_captured_idx')
      .on(t.projectId, t.capturedAt),
    check('verification_goal_repository_snapshots_object_format_check', sql`
      ${t.objectFormat} is null or ${t.objectFormat} in ('sha1', 'sha256')
    `),
    check('verification_goal_repository_snapshots_head_oid_check', sql`
      ${t.headOid} is null
      or ${t.headOid} ~ '^[0-9a-f]{40}$'
      or ${t.headOid} ~ '^[0-9a-f]{64}$'
    `),
    check('verification_goal_repository_snapshots_fingerprints_check', sql`
      (${t.gitMetadataFingerprint} is null or ${t.gitMetadataFingerprint} ~ '^[0-9a-f]{64}$')
      and (${t.indexFingerprint} is null or ${t.indexFingerprint} ~ '^[0-9a-f]{64}$')
      and (${t.configFingerprint} is null or ${t.configFingerprint} ~ '^[0-9a-f]{64}$')
      and ${t.repositorySnapshotFingerprint} ~ '^[0-9a-f]{64}$'
    `),
  ],
)

export type VerificationGoalRepositorySnapshot = InferSelectModel<typeof verificationGoalRepositorySnapshots>
export type NewVerificationGoalRepositorySnapshot = InferInsertModel<typeof verificationGoalRepositorySnapshots>

export const verificationGoalEnvironmentSnapshots = pgTable(
  'verification_goal_environment_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verificationGoalRunId: uuid('verification_goal_run_id')
      .notNull()
      .references(() => verificationGoalRuns.id, { onDelete: 'restrict' })
      .unique(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    schemaVersion: integer('schema_version').notNull(),
    runnerContractVersion: integer('runner_contract_version').notNull(),
    forgeBuildIdentity: text('forge_build_identity').notNull(),
    releaseStateClass: text('release_state_class').notNull(),
    rootLauncherContractVersion: integer('root_launcher_contract_version').notNull(),
    rootLauncherDigest: text('root_launcher_digest').notNull(),
    trustedNodeIdentityDigest: text('trusted_node_identity_digest').notNull(),
    trustedNodeVersion: text('trusted_node_version').notNull(),
    trustedGitIdentityDigest: text('trusted_git_identity_digest').notNull(),
    trustedGitVersion: text('trusted_git_version').notNull(),
    gitSafetyProfileVersion: integer('git_safety_profile_version').notNull(),
    gitSafetyProfileDigest: text('git_safety_profile_digest').notNull(),
    platform: text('platform').notNull(),
    architecture: text('architecture').notNull(),
    operationExecutionBindingDigest: text('operation_execution_binding_digest').notNull(),
    eligibilityVersion: integer('eligibility_version').notNull(),
    eligibilityDigest: text('eligibility_digest').notNull(),
    environmentFingerprint: text('environment_fingerprint').notNull(),
    capturedAt: timestamp('captured_at', tsOpts).notNull(),
  },
  (t) => [
    index('verification_goal_environment_snapshots_project_captured_idx')
      .on(t.projectId, t.capturedAt),
    check('verification_goal_environment_snapshots_positive_versions_check', sql`
      ${t.schemaVersion} > 0
      and ${t.runnerContractVersion} > 0
      and ${t.rootLauncherContractVersion} > 0
      and ${t.gitSafetyProfileVersion} > 0
      and ${t.eligibilityVersion} > 0
    `),
    check('verification_goal_environment_snapshots_digests_check', sql`
      ${t.rootLauncherDigest} ~ '^[0-9a-f]{64}$'
      and ${t.trustedNodeIdentityDigest} ~ '^[0-9a-f]{64}$'
      and ${t.trustedGitIdentityDigest} ~ '^[0-9a-f]{64}$'
      and ${t.gitSafetyProfileDigest} ~ '^[0-9a-f]{64}$'
      and ${t.operationExecutionBindingDigest} ~ '^[0-9a-f]{64}$'
      and ${t.eligibilityDigest} ~ '^[0-9a-f]{64}$'
      and ${t.environmentFingerprint} ~ '^[0-9a-f]{64}$'
    `),
  ],
)

export type VerificationGoalEnvironmentSnapshot = InferSelectModel<typeof verificationGoalEnvironmentSnapshots>
export type NewVerificationGoalEnvironmentSnapshot = InferInsertModel<typeof verificationGoalEnvironmentSnapshots>

// ---------------------------------------------------------------------------
// verificationGoalScheduleBindings / Heads / Slots
// ---------------------------------------------------------------------------
// Scheduling state is deliberately separate from execution. Bindings are
// immutable; only the current head is advanced by a protected routine.
export const verificationGoalScheduleBindings = pgTable(
  'verification_goal_schedule_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    registryRevisionId: uuid('registry_revision_id').notNull(),
    registryEntryOrdinal: integer('registry_entry_ordinal').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    goalId: text('goal_id').notNull(),
    definitionVersion: integer('definition_version').notNull(),
    definitionDigest: text('definition_digest').notNull(),
    executionBindingDigest: text('execution_binding_digest').notNull(),
    policyRevisionId: uuid('policy_revision_id').notNull(),
    policyRevisionSequence: bigint('policy_revision_sequence', { mode: 'bigint' }).notNull(),
    intervalSeconds: bigint('interval_seconds', { mode: 'bigint' }).notNull(),
    anchorAt: timestamp('anchor_at', tsOpts).notNull(),
    bindingFingerprint: text('binding_fingerprint').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('verification_goal_schedule_bindings_project_created_idx')
      .on(t.projectId, t.createdAt),
    foreignKey({
      columns: [t.registryRevisionId, t.registryEntryOrdinal],
      foreignColumns: [verificationGoalRegistryEntries.registryRevisionId, verificationGoalRegistryEntries.ordinal],
      name: 'verification_goal_schedule_bindings_registry_entry_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    foreignKey({
      columns: [
        t.snapshotId,
        t.projectId,
        t.goalId,
        t.definitionVersion,
        t.definitionDigest,
      ],
      foreignColumns: [
        verificationGoalSnapshots.id,
        verificationGoalSnapshots.projectId,
        verificationGoalSnapshots.goalId,
        verificationGoalSnapshots.definitionVersion,
        verificationGoalSnapshots.definitionDigest,
      ],
      name: 'verification_goal_schedule_bindings_snapshot_identity_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    foreignKey({
      columns: [t.policyRevisionId, t.projectId, t.policyRevisionSequence],
      foreignColumns: [
        verificationGoalPolicyRevisions.id,
        verificationGoalPolicyRevisions.projectId,
        verificationGoalPolicyRevisions.revisionSequence,
      ],
      name: 'verification_goal_schedule_bindings_policy_revision_fk',
    }).onDelete('restrict').onUpdate('restrict'),
    check('verification_goal_schedule_bindings_interval_check', sql`${t.intervalSeconds} > 0`),
    check('verification_goal_schedule_bindings_fingerprint_check', sql`
      ${t.bindingFingerprint} ~ '^[0-9a-f]{64}$'
      and ${t.executionBindingDigest} ~ '^[0-9a-f]{64}$'
      and ${t.definitionDigest} ~ '^[0-9a-f]{64}$'
    `),
  ],
)

export type VerificationGoalScheduleBinding = InferSelectModel<typeof verificationGoalScheduleBindings>
export type NewVerificationGoalScheduleBinding = InferInsertModel<typeof verificationGoalScheduleBindings>

export const verificationGoalScheduleHeads = pgTable(
  'verification_goal_schedule_heads',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    goalId: text('goal_id').notNull(),
    scheduleBindingId: uuid('schedule_binding_id').references(() => verificationGoalScheduleBindings.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    bindingFingerprint: text('binding_fingerprint'),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.goalId] }),
    check('verification_goal_schedule_heads_shape_check', sql`
      (
        ${t.scheduleBindingId} is null
        and ${t.bindingFingerprint} is null
      ) or (
        ${t.scheduleBindingId} is not null
        and ${t.bindingFingerprint} is not null
        and ${t.bindingFingerprint} ~ '^[0-9a-f]{64}$'
      )
    `),
  ],
)

export type VerificationGoalScheduleHead = InferSelectModel<typeof verificationGoalScheduleHeads>
export type NewVerificationGoalScheduleHead = InferInsertModel<typeof verificationGoalScheduleHeads>

export const verificationGoalScheduleSlots = pgTable(
  'verification_goal_schedule_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleBindingId: uuid('schedule_binding_id')
      .notNull()
      .references(() => verificationGoalScheduleBindings.id, { onDelete: 'restrict' }),
    slotSequence: bigint('slot_sequence', { mode: 'bigint' }).notNull(),
    dueAt: timestamp('due_at', tsOpts).notNull(),
    runId: uuid('run_id').references(() => verificationGoalRuns.id, {
      onDelete: 'set null',
      onUpdate: 'restrict',
    }),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('verification_goal_schedule_slots_binding_sequence_idx')
      .on(t.scheduleBindingId, t.slotSequence),
    index('verification_goal_schedule_slots_due_idx')
      .on(t.dueAt),
    check('verification_goal_schedule_slots_sequence_check', sql`${t.slotSequence} >= 0`),
  ],
)

export type VerificationGoalScheduleSlot = InferSelectModel<typeof verificationGoalScheduleSlots>
export type NewVerificationGoalScheduleSlot = InferInsertModel<typeof verificationGoalScheduleSlots>

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'restrict' }),
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
// S4 protected Architect history and task-bound execution references
// ---------------------------------------------------------------------------
export const architectPlanVersions = pgTable(
  'architect_plan_versions',
  {
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    planArtifactId: uuid('plan_artifact_id').notNull().references(() => artifacts.id, { onDelete: 'restrict' }),
    planVersion: bigint('plan_version', { mode: 'bigint' }).notNull(),
    digestKeyId: text('digest_key_id').notNull(),
    entryCount: integer('entry_count').notNull(),
    entrySetDigest: text('entry_set_digest').notNull(),
    structuralSetDigest: text('structural_set_digest').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('architect_plan_versions_task_version_idx').on(t.taskId, t.planVersion),
    uniqueIndex('architect_plan_versions_artifact_version_idx').on(t.planArtifactId, t.planVersion),
  ],
)

export const architectPlanEntries = pgTable(
  'architect_plan_entries',
  {
    taskId: uuid('task_id').notNull(),
    planArtifactId: uuid('plan_artifact_id').notNull(),
    planVersion: bigint('plan_version', { mode: 'bigint' }).notNull(),
    entryId: text('entry_id').notNull(),
    entryKind: text('entry_kind').notNull(),
    agent: text('agent'),
    requirementKey: text('requirement_key'),
    bindingFingerprint: text('binding_fingerprint'),
    content: text('content').notNull(),
    contentDigest: text('content_digest').notNull(),
    digestKeyId: text('digest_key_id').notNull(),
    projectionEligible: boolean('projection_eligible').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('architect_plan_entries_version_entry_idx').on(t.taskId, t.planVersion, t.entryId),
    index('architect_plan_entries_artifact_version_idx').on(t.planArtifactId, t.planVersion),
  ],
)

function executionReferenceAnswerColumns(): [AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn] {
  return [
    architectClarificationAnswers.taskId,
    architectClarificationAnswers.sourcePlanArtifactId,
    architectClarificationAnswers.sourcePlanVersion,
    architectClarificationAnswers.id,
  ]
}

export const architectPlanExecutionReferences = pgTable(
  'architect_plan_execution_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: text('purpose').notNull().default('package_specialist'),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, { onDelete: 'restrict' }),
    agentRunId: uuid('agent_run_id').notNull().references(() => agentRuns.id, { onDelete: 'restrict' }),
    planArtifactId: uuid('plan_artifact_id').notNull(),
    planVersion: bigint('plan_version', { mode: 'bigint' }).notNull(),
    entryId: text('entry_id').notNull(),
    sourceKind: text('source_kind').notNull().default('architect_plan_entry'),
    architectPlanEntryId: text('architect_plan_entry_id'),
    clarificationAnswerId: uuid('clarification_answer_id'),
    agent: text('agent').notNull(),
    requirementKey: text('requirement_key'),
    bindingFingerprint: text('binding_fingerprint'),
    contentDigest: text('content_digest').notNull(),
    digestKeyId: text('digest_key_id').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', tsOpts),
  },
  (t) => [
    uniqueIndex('architect_plan_execution_references_run_entry_idx').on(t.agentRunId, t.entryId),
    index('architect_plan_execution_references_package_idx').on(t.workPackageId, t.agentRunId),
    check(
      'architect_plan_execution_references_purpose_chk',
      sql`${t.purpose} in ('package_specialist', 'architect_replan')`,
    ),
    check(
      'architect_plan_execution_references_purpose_shape_chk',
      sql`(${t.purpose} = 'package_specialist' and ${t.workPackageId} is not null)
        or (${t.purpose} = 'architect_replan' and ${t.workPackageId} is null
          and ${t.agent} = 'architect')`,
    ),
    check(
      'architect_plan_execution_references_source_kind_chk',
      sql`(${t.sourceKind} = 'architect_plan_entry'
          and ${t.architectPlanEntryId} is not null
          and ${t.architectPlanEntryId} = ${t.entryId}
          and ${t.clarificationAnswerId} is null)
        or (${t.sourceKind} = 'clarification_answer'
          and ${t.architectPlanEntryId} is null
          and ${t.clarificationAnswerId} is not null
          and ${t.entryId} = 'clarification_answer:' || ${t.clarificationAnswerId}::text
          and ${t.purpose} = 'architect_replan'
          and ${t.workPackageId} is null
          and ${t.agent} = 'architect')`,
    ),
    foreignKey({
      name: 'architect_plan_execution_references_plan_source_fk',
      columns: [t.taskId, t.planVersion, t.architectPlanEntryId],
      foreignColumns: [architectPlanEntries.taskId, architectPlanEntries.planVersion, architectPlanEntries.entryId],
    }).onUpdate('restrict').onDelete('restrict'),
    foreignKey({
      name: 'architect_plan_execution_references_answer_source_fk',
      columns: [t.taskId, t.planArtifactId, t.planVersion, t.clarificationAnswerId],
      foreignColumns: executionReferenceAnswerColumns(),
    }).onUpdate('restrict').onDelete('restrict'),
  ],
)

export const protectedPackageEntryRegistrations = pgTable(
  'protected_package_entry_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').notNull().references(() => workPackages.id, { onDelete: 'restrict' }),
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: bigint('source_version', { mode: 'bigint' }).notNull(),
    entryId: text('entry_id').notNull(),
    entryKind: text('entry_kind').notNull(),
    bindingSetDigest: text('binding_set_digest').notNull(),
    contentDigest: text('content_digest').notNull(),
    digestKeyId: text('digest_key_id').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('protected_package_entry_registrations_identity_idx').on(
      t.taskId, t.workPackageId, t.sourceKind, t.sourceId, t.sourceVersion, t.entryId,
    ),
  ],
)

export const protectedEntryCapabilityBindings = pgTable(
  'protected_entry_capability_bindings',
  {
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: bigint('source_version', { mode: 'bigint' }).notNull(),
    entryId: text('entry_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    capability: text('capability').notNull(),
    requirementKey: text('requirement_key').notNull(),
    routingFingerprint: text('routing_fingerprint').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceKind, t.sourceId, t.sourceVersion, t.entryId, t.ordinal] }),
  ],
)

export const mcpOperatorReviewVersions = pgTable(
  'mcp_operator_review_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    approvalGateId: uuid('approval_gate_id').notNull(),
    sourceArtifactId: uuid('source_artifact_id').notNull(),
    sourcePlanVersion: bigint('source_plan_version', { mode: 'bigint' }).notNull(),
    revision: integer('revision').notNull(),
    previousReviewSetDigest: text('previous_review_set_digest'),
    reviewSetDigest: text('review_set_digest').notNull(),
    itemCount: integer('item_count').notNull(),
    entryCount: integer('entry_count').notNull(),
    approvedCount: integer('approved_count').notNull(),
    deniedCount: integer('denied_count').notNull(),
    blockerCodes: text('blocker_codes').array().notNull().default(sql`ARRAY[]::text[]`),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('mcp_operator_review_versions_gate_revision_idx').on(t.approvalGateId, t.revision),
  ],
)

export const mcpOperatorReviewEntries = pgTable(
  'mcp_operator_review_entries',
  {
    reviewVersionId: uuid('review_version_id').notNull().references(() => mcpOperatorReviewVersions.id, { onDelete: 'restrict' }),
    entryId: text('entry_id').notNull(),
    entryKind: text('entry_kind').notNull(),
    agent: text('agent').notNull(),
    requirementKey: text('requirement_key').notNull(),
    content: text('content').notNull(),
    contentDigest: text('content_digest').notNull(),
    digestKeyId: text('digest_key_id').notNull(),
    projectionEligible: boolean('projection_eligible').notNull(),
  },
  (t) => [primaryKey({ columns: [t.reviewVersionId, t.entryId] })],
)

export const architectPlanHistoryReads = pgTable(
  'architect_plan_history_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').notNull().unique(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id').notNull(),
    planVersion: bigint('plan_version', { mode: 'bigint' }).notNull(),
    returnedEntryCount: integer('returned_entry_count').notNull(),
    entrySetDigest: text('entry_set_digest').notNull(),
    readAt: timestamp('read_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('architect_plan_history_reads_task_version_idx').on(t.taskId, t.planVersion),
    check(
      'architect_plan_history_reads_count_chk',
      sql`${t.returnedEntryCount} between 0 and 256`,
    ),
    check(
      'architect_plan_history_reads_digest_chk',
      sql`${t.entrySetDigest} ~ '^(hmac-sha256|sha256):[0-9a-f]{64}$'`,
    ),
  ],
)

export const workPackageLocalRunEvidence = pgTable(
  'work_package_local_run_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').notNull().references(() => workPackages.id, { onDelete: 'restrict' }),
    agentRunId: uuid('agent_run_id').notNull().references(() => agentRuns.id, { onDelete: 'restrict' }).unique(),
    claimToken: uuid('claim_token').notNull().unique(),
    claimGeneration: bigint('claim_generation', { mode: 'bigint' }).notNull().default(sql`1`),
    lastHeartbeatAt: timestamp('last_heartbeat_at', tsOpts).defaultNow().notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', tsOpts).notNull(),
    state: text('state').notNull().default('claimed'),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    terminal: jsonb('terminal').$type<Record<string, unknown>>(),
    completionArtifactId: uuid('completion_artifact_id').references(() => artifacts.id, {
      onDelete: 'restrict',
    }),
    terminalAt: timestamp('terminal_at', tsOpts),
  },
  (t) => [index('work_package_local_run_evidence_package_idx').on(t.workPackageId, t.agentRunId)],
)

// ---------------------------------------------------------------------------
// filesystemMcpRuntimeAudits
// ---------------------------------------------------------------------------
export const filesystemMcpRuntimeAudits = pgTable(
  'filesystem_mcp_runtime_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'restrict',
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'restrict',
    }),
    grantApprovalId: uuid('grant_approval_id').references(() => filesystemMcpGrantApprovals.id, {
      onDelete: 'restrict',
    }),
    operation: text('operation').notNull().default('context_packet'),
    // 'issued'|'blocked'|'not_issued_optional'|'failed'
    status: text('status').notNull(),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    requestedCapabilities: jsonb('requested_capabilities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    root: text('root').notNull().default(''),
    fileCount: integer('file_count').notNull().default(0),
    byteCount: integer('byte_count').notNull().default(0),
    omittedCount: integer('omitted_count').notNull().default(0),
    redactionApplied: boolean('redaction_applied').notNull().default(false),
    redactionSummary: jsonb('redaction_summary')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    omittedSummary: jsonb('omitted_summary')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    reason: text('reason').notNull().default(''),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    protocolVersion: integer('protocol_version'),
    localRunEvidenceId: uuid('local_run_evidence_id').references(() => workPackageLocalRunEvidence.id, {
      onDelete: 'restrict',
    }),
    claimToken: uuid('claim_token'),
    claimGeneration: bigint('claim_generation', { mode: 'bigint' }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', tsOpts),
    leaseExpiresAt: timestamp('lease_expires_at', tsOpts),
    authorizationSnapshot: jsonb('authorization_snapshot').$type<Record<string, unknown>>(),
    authorizationSource: text('authorization_source'),
    grantMode: text('grant_mode'),
    grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' }),
    grantDecisionNonce: uuid('grant_decision_nonce'),
    authorizationRootBindingRevision: bigint('authorization_root_binding_revision', { mode: 'bigint' }),
    projectDecisionId: uuid('project_decision_id').references(() => projectFilesystemGrantDecisions.id, {
      onDelete: 'restrict',
    }),
    completionArtifactId: uuid('completion_artifact_id').references(() => artifacts.id, {
      onDelete: 'restrict',
    }),
    assembly: jsonb('assembly').$type<Record<string, unknown>>(),
    delivery: jsonb('delivery').$type<Record<string, unknown>>(),
    terminal: jsonb('terminal').$type<Record<string, unknown>>(),
    terminalAt: timestamp('terminal_at', tsOpts),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('filesystem_mcp_runtime_audits_task_id_idx').on(t.taskId),
    index('filesystem_mcp_runtime_audits_work_package_id_idx').on(t.workPackageId),
    index('filesystem_mcp_runtime_audits_agent_run_id_idx').on(t.agentRunId),
    index('filesystem_mcp_runtime_audits_grant_approval_id_idx').on(t.grantApprovalId),
    index('filesystem_mcp_runtime_audits_status_idx').on(t.status),
    index('filesystem_mcp_runtime_audits_created_at_idx').on(t.createdAt),
  ],
)

export type FilesystemMcpRuntimeAudit = InferSelectModel<typeof filesystemMcpRuntimeAudits>
export type NewFilesystemMcpRuntimeAudit = InferInsertModel<typeof filesystemMcpRuntimeAudits>

export const filesystemMcpDecisionNonceClaims = pgTable(
  'filesystem_mcp_decision_nonce_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    grantApprovalId: uuid('grant_approval_id').notNull().references(() => filesystemMcpGrantApprovals.id, {
      onDelete: 'restrict',
    }),
    grantDecisionNonce: uuid('grant_decision_nonce').notNull().unique(),
    runtimeAuditId: uuid('runtime_audit_id').notNull().references(() => filesystemMcpRuntimeAudits.id, {
      onDelete: 'restrict',
    }).unique(),
    claimedAt: timestamp('claimed_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [index('filesystem_mcp_decision_nonce_claims_approval_idx').on(t.grantApprovalId)],
)

// ---------------------------------------------------------------------------
// approvalGates
// ---------------------------------------------------------------------------
export const approvalGates = pgTable(
  'approval_gates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'restrict',
    }),
    gateType: text('gate_type').notNull(),
    // gate_type: 'plan_approval'|'qa_review'|'reviewer_review'|'security_review'
    // status: 'pending'|'approved'|'rejected'|'completed'|'needs_rework'|'cancelled'
    status: text('status').notNull().default('pending'),
    sourceAgentRunId: uuid('source_agent_run_id').references(() => agentRuns.id, {
      onDelete: 'restrict',
    }),
    sourceArtifactId: uuid('source_artifact_id').references(() => artifacts.id, {
      onDelete: 'restrict',
    }),
    title: text('title').notNull(),
    instructions: text('instructions').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    protectedReviewRevision: integer('protected_review_revision'),
    protectedReviewSetDigest: text('protected_review_set_digest'),
    protectedReviewItemCount: integer('protected_review_item_count'),
    protectedReviewApprovedCount: integer('protected_review_approved_count'),
    protectedReviewDeniedCount: integer('protected_review_denied_count'),
    protectedReviewBlockerCodes: text('protected_review_blocker_codes').array(),
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

export const s4CompletionHandoffs = pgTable(
  's4_completion_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').notNull().references(() => workPackages.id, { onDelete: 'restrict' }),
    agentRunId: uuid('agent_run_id').notNull().references(() => agentRuns.id, { onDelete: 'restrict' }).unique(),
    localRunEvidenceId: uuid('local_run_evidence_id').notNull().references(() => workPackageLocalRunEvidence.id, { onDelete: 'restrict' }).unique(),
    runtimeAuditId: uuid('runtime_audit_id').references(() => filesystemMcpRuntimeAudits.id, { onDelete: 'restrict' }).unique(),
    completionArtifactId: uuid('completion_artifact_id').notNull().references(() => artifacts.id, { onDelete: 'restrict' }).unique(),
    state: text('state').notNull().default('pending'),
    requiredGateTypes: text('required_gate_types').array(),
    reconciliationClaimToken: uuid('reconciliation_claim_token'),
    reconciliationClaimedBy: text('reconciliation_claimed_by'),
    reconciliationClaimGeneration: bigint('reconciliation_claim_generation', { mode: 'bigint' }).notNull().default(sql`0`),
    reconciliationLeaseExpiresAt: timestamp('reconciliation_lease_expires_at', tsOpts),
    reconcileAttemptCount: integer('reconcile_attempt_count').notNull().default(0),
    nextReconcileAt: timestamp('next_reconcile_at', tsOpts).defaultNow().notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    materializedAt: timestamp('materialized_at', tsOpts),
  },
  (t) => [index('s4_completion_handoffs_package_state_idx').on(t.workPackageId, t.state)],
)

export const s4ProtectedReviewSources = pgTable('s4_protected_review_sources', {
  sourceArtifactId: uuid('source_artifact_id').primaryKey().references(() => artifacts.id, { onDelete: 'restrict' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
  workPackageId: uuid('work_package_id').notNull().references(() => workPackages.id, { onDelete: 'restrict' }),
  sourceAgentRunId: uuid('source_agent_run_id').notNull().references(() => agentRuns.id, { onDelete: 'restrict' }).unique(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
  contentFingerprint: text('content_fingerprint').notNull().unique(),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
})

export const projectRootReconciliationWriteContexts = pgTable('project_root_reconciliation_write_contexts', {
  operationId: uuid('operation_id').notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
  actorId: uuid('actor_id').notNull(),
  projectId: uuid('project_id').notNull(),
  backendPid: integer('backend_pid').notNull(),
  transactionId: bigint('transaction_id', { mode: 'bigint' }).notNull(),
  // Match the protected write-context DDL: this is wall-clock entry time,
  // rather than PostgreSQL's transaction-start timestamp.
  enteredAt: timestamp('entered_at', tsOpts).default(sql`pg_catalog.clock_timestamp()`).notNull(),
  completedAt: timestamp('completed_at', tsOpts),
}, (t) => [
  primaryKey({ name: 'project_root_reconciliation_write_contexts_pkey', columns: [t.operationId, t.generation] }),
  unique('project_root_reconciliation_write_context_generation_unique').on(t.generation),
  check('project_root_reconciliation_write_context_backend_pid_chk', sql`${t.backendPid} > 0`),
  check('project_root_reconciliation_write_context_transaction_id_chk', sql`${t.transactionId} > 0`),
  check('project_root_reconciliation_write_context_shape_chk', sql`${t.completedAt} is null or ${t.completedAt} >= ${t.enteredAt}`),
  foreignKey({
    name: 'project_root_reconciliation_write_contexts_operation_id_fkey',
    columns: [t.operationId],
    foreignColumns: [projectRootReconciliationOperations.operationId],
  }).onDelete('restrict'),
  foreignKey({
    name: 'project_root_reconciliation_write_contexts_generation_fkey',
    columns: [t.generation],
    foreignColumns: [projectRootChangeJournal.generation],
  }).onDelete('restrict'),
  foreignKey({
    name: 'project_root_reconciliation_write_contexts_project_id_fkey',
    columns: [t.projectId],
    foreignColumns: [projects.id],
  }).onDelete('restrict'),
])

export const s4ProtectedReviewSourceReads = pgTable(
  's4_protected_review_source_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalGateId: uuid('approval_gate_id').notNull().references(() => approvalGates.id, { onDelete: 'restrict' }),
    sourceArtifactId: uuid('source_artifact_id').notNull().references(() => s4ProtectedReviewSources.sourceArtifactId, { onDelete: 'restrict' }),
    sourceAgentRunId: uuid('source_agent_run_id').notNull().references(() => agentRuns.id, { onDelete: 'restrict' }),
    contentFingerprint: text('content_fingerprint').notNull(),
    readAt: timestamp('read_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [index('s4_protected_review_source_reads_gate_idx').on(t.approvalGateId, t.readAt)],
)

export const filesystemMcpIssuanceRecoveryActions = pgTable(
  'filesystem_mcp_issuance_recovery_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').notNull().references(() => workPackages.id, { onDelete: 'restrict' }),
    priorRuntimeAuditId: uuid('prior_runtime_audit_id').notNull().references(() => filesystemMcpRuntimeAudits.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    expectedMarkerFingerprint: text('expected_marker_fingerprint').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    authorizingDecisionId: uuid('authorizing_decision_id').references(() => filesystemMcpGrantApprovals.id, { onDelete: 'restrict' }),
    authorizingProjectDecisionId: uuid('authorizing_project_decision_id').references(
      () => projectFilesystemGrantDecisions.id,
      { onDelete: 'restrict', onUpdate: 'restrict' },
    ),
    result: text('result').notNull(),
    resultMarkerFingerprint: text('result_marker_fingerprint'),
    packageStatus: text('package_status').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [index('filesystem_mcp_issuance_recovery_actions_audit_idx').on(t.priorRuntimeAuditId, t.createdAt)],
)

export const localEffectRecoveryActions = pgTable(
  'local_effect_recovery_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').notNull().references(() => workPackages.id, { onDelete: 'restrict' }),
    localRunEvidenceId: uuid('local_run_evidence_id').notNull().references(() => workPackageLocalRunEvidence.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    expectedMarkerFingerprint: text('expected_marker_fingerprint').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    result: text('result').notNull(),
    resultMarkerFingerprint: text('result_marker_fingerprint'),
    packageStatus: text('package_status').notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [index('local_effect_recovery_actions_evidence_idx').on(t.localRunEvidenceId, t.createdAt)],
)

export const s4MaxAttemptFinalizations = pgTable('s4_max_attempt_finalizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
  workPackageId: uuid('work_package_id').notNull().references(() => workPackages.id, { onDelete: 'restrict' }).unique(),
  transitionCode: text('transition_code').notNull(),
  maxAttempts: integer('max_attempts').notNull(),
  nextAttemptNumber: integer('next_attempt_number').notNull(),
  expectedPackageUpdatedAt: timestamp('expected_package_updated_at', tsOpts).notNull(),
  packageUpdatedAt: timestamp('package_updated_at', tsOpts).notNull(),
  taskDisposition: text('task_disposition').notNull(),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
})

export const localProjectionArchiveOperations = pgTable(
  'local_projection_archive_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceTaskId: uuid('source_task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    replacementTaskId: uuid('replacement_task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    state: text('state').notNull(),
    sourceScopeVersion: bigint('source_scope_version', { mode: 'bigint' }).notNull(),
    replacementVersion: bigint('replacement_version', { mode: 'bigint' }).notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    replacementFingerprint: text('replacement_fingerprint').notNull(),
    operationFingerprint: text('operation_fingerprint').notNull().unique(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
    completedAt: timestamp('completed_at', tsOpts),
  },
  (t) => [uniqueIndex('local_projection_archive_operations_task_pair_idx').on(t.sourceTaskId, t.replacementTaskId)],
)

export const localProjectionArchiveOperationCheckpoints = pgTable(
  'local_projection_archive_operation_checkpoints',
  {
    operationId: uuid('operation_id').notNull().references(() => localProjectionArchiveOperations.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    state: text('state').notNull(),
    operationFingerprint: text('operation_fingerprint').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    recordedAt: timestamp('recorded_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('local_projection_archive_operation_checkpoints_ordinal_idx').on(t.operationId, t.ordinal),
    uniqueIndex('local_projection_archive_operation_checkpoints_state_idx').on(t.operationId, t.state),
  ],
)

// ---------------------------------------------------------------------------
// taskLogs
// ---------------------------------------------------------------------------
export const taskLogs = pgTable(
  'task_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    taskAttemptId: uuid('task_attempt_id').references(() => taskAttempts.id, {
      onDelete: 'restrict',
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'restrict',
    }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'restrict',
    }),
    artifactId: uuid('artifact_id').references(() => artifacts.id, {
      onDelete: 'restrict',
    }),
    approvalGateId: uuid('approval_gate_id').references(() => approvalGates.id, {
      onDelete: 'restrict',
    }),
    // 'info'|'success'|'warning'|'error'
    level: text('level').notNull().default('info'),
    eventType: text('event_type').notNull(),
    source: text('source').notNull().default('system'),
    title: text('title').notNull(),
    message: text('message').notNull(),
    frontMatter: jsonb('front_matter')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', tsOpts).defaultNow().notNull(),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('task_logs_task_id_occurred_at_idx').on(t.taskId, t.occurredAt, t.sequence),
    index('task_logs_task_id_sequence_idx').on(t.taskId, t.sequence),
    index('task_logs_task_id_level_idx').on(t.taskId, t.level),
    index('task_logs_task_id_event_type_idx').on(t.taskId, t.eventType),
    index('task_logs_level_idx').on(t.level),
    index('task_logs_event_type_idx').on(t.eventType),
    index('task_logs_agent_run_id_idx').on(t.agentRunId),
    index('task_logs_task_attempt_id_idx').on(t.taskAttemptId),
    index('task_logs_work_package_id_idx').on(t.workPackageId),
  ],
)

export type TaskLog = InferSelectModel<typeof taskLogs>
export type NewTaskLog = InferInsertModel<typeof taskLogs>

// ---------------------------------------------------------------------------
// vcsChanges
// ---------------------------------------------------------------------------
export const vcsChanges = pgTable(
  'vcs_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'restrict',
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'restrict',
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
// repositoryCommandAudits
// ---------------------------------------------------------------------------
export const repositoryCommandAudits = pgTable(
  'repository_command_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Exactly one of taskId or verificationGoalRunId must be set. Goal rows
    // are linked to the exact child operation run that produced the audit.
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'restrict' }),
    verificationGoalRunId: uuid('verification_goal_run_id').references(() => verificationGoalRuns.id, { onDelete: 'restrict' }),
    operationRunId: uuid('operation_run_id').references(() => operationRuns.id, { onDelete: 'restrict' }),
    workPackageId: uuid('work_package_id').references(() => workPackages.id, {
      onDelete: 'restrict',
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'restrict',
    }),
    artifactId: uuid('artifact_id').references(() => artifacts.id, {
      onDelete: 'restrict',
    }),
    cwd: text('cwd').notNull(),
    command: text('command').notNull(),
    argv: jsonb('argv').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // 'read_only'
    riskClass: text('risk_class').notNull(),
    startedAt: timestamp('started_at', tsOpts).notNull(),
    finishedAt: timestamp('finished_at', tsOpts).notNull(),
    exitCode: integer('exit_code').notNull(),
    outputSummary: text('output_summary').notNull().default(''),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    index('repository_command_audits_task_id_idx').on(t.taskId),
    index('repository_command_audits_verification_goal_run_id_idx').on(t.verificationGoalRunId),
    index('repository_command_audits_operation_run_id_idx').on(t.operationRunId),
    index('repository_command_audits_work_package_id_idx').on(t.workPackageId),
    index('repository_command_audits_agent_run_id_idx').on(t.agentRunId),
    index('repository_command_audits_artifact_id_idx').on(t.artifactId),
    index('repository_command_audits_started_at_idx').on(t.startedAt),
    check('repository_command_audits_subject_check', sql`
      (
        ${t.taskId} is not null
        and ${t.verificationGoalRunId} is null
        and ${t.operationRunId} is null
      ) or (
        ${t.taskId} is null
        and ${t.verificationGoalRunId} is not null
        and ${t.operationRunId} is not null
      )
    `),
  ],
)

export type RepositoryCommandAudit = InferSelectModel<typeof repositoryCommandAudits>
export type NewRepositoryCommandAudit = InferInsertModel<typeof repositoryCommandAudits>

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
    uniqueIndex('agent_configs_display_name_normalized_idx').on(sql`lower(regexp_replace(btrim(${t.displayName}), '\\s+', ' ', 'g'))`),
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
    uniqueIndex('workforces_display_name_normalized_idx').on(sql`lower(regexp_replace(btrim(${t.displayName}), '\\s+', ' ', 'g'))`),
    index('workforces_is_active_idx').on(t.isActive),
    index('workforces_is_default_idx').on(t.isDefault),
    check('workforces_slug_safe_chk', sql`${t.slug} ~ '^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$'`),
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
const clarificationAnswerReferenceColumns = (): [AnyPgColumn, AnyPgColumn, AnyPgColumn] => [
  architectClarificationAnswers.taskId,
  architectClarificationAnswers.questionId,
  architectClarificationAnswers.id,
]

export const taskQuestions = pgTable(
  'task_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    // Dormant B2A opaque bindings. Existing routes do not use these yet.
    questionEntryId: text('question_entry_id'),
    sourcePlanArtifactId: uuid('source_plan_artifact_id'),
    sourcePlanVersion: bigint('source_plan_version', { mode: 'number' }),
    answerReferenceId: uuid('answer_reference_id'),
    // 'open'|'answered'|'legacy_unavailable'
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
    unique('task_questions_task_id_id_key').on(t.taskId, t.id),
    foreignKey({
      name: 'task_questions_answer_reference_task_question_fk',
      columns: [t.taskId, t.id, t.answerReferenceId],
      foreignColumns: clarificationAnswerReferenceColumns(),
    }).onUpdate('restrict').onDelete('restrict'),
  ],
)

export type TaskQuestion = InferSelectModel<typeof taskQuestions>
export type NewTaskQuestion = InferInsertModel<typeof taskQuestions>

/** Protected append-only text for answered clarifications. */
export const architectClarificationAnswers = pgTable(
  'architect_clarification_answers',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'restrict' }),
    questionId: uuid('question_id').notNull(),
    sourcePlanArtifactId: uuid('source_plan_artifact_id').notNull(),
    sourcePlanVersion: bigint('source_plan_version', { mode: 'number' }).notNull(),
    answer: text('answer').notNull(),
    contentDigest: text('content_digest').notNull(),
    digestKeyId: text('digest_key_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'architect_clarification_answers_task_question_fk',
      columns: [t.taskId, t.questionId],
      foreignColumns: [taskQuestions.taskId, taskQuestions.id],
    }).onUpdate('restrict').onDelete('restrict'),
    unique('architect_clarification_answers_task_question_id_key').on(t.taskId, t.questionId, t.id),
    unique('architect_clarification_answers_task_source_id_key').on(
      t.taskId, t.sourcePlanArtifactId, t.sourcePlanVersion, t.id,
    ),
  ],
)
