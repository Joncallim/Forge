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
  // S3 serializes this BIGINT as a canonical decimal string at every JSON/API
  // boundary. Database order, never timestamps, decides grant precedence.
  grantDecisionRevision: bigint('grant_decision_revision', { mode: 'bigint' })
    .notNull()
    .default(BigInt(0)),
  // Zero is the explicit unbound state. S4 binds a project root by advancing
  // this counter; S3 never upgrades a legacy decision implicitly.
  rootBindingRevision: bigint('root_binding_revision', { mode: 'bigint' })
    .notNull()
    .default(BigInt(0)),
  defaultBranch: text('default_branch').notNull().default('main'),
  createdAt: timestamp('created_at', tsOpts).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', tsOpts).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', tsOpts),
})

export type Project = InferSelectModel<typeof projects>
export type NewProject = InferInsertModel<typeof projects>

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

export type Task = InferSelectModel<typeof tasks>
export type NewTask = InferInsertModel<typeof tasks>

// Narrow mapping for the migration-0026 claimability boundary. Keeping this
// separate avoids making protocol-only upgrade metadata part of every Task DTO.
export const taskLocalProjectionScopes = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  localProjectionScopeState: text('local_projection_scope_state').notNull(),
  localProjectionOverlimitPackageCount: integer('local_projection_overlimit_package_count'),
})

// ---------------------------------------------------------------------------
// taskAttempts
// ---------------------------------------------------------------------------
export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
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
    pointerVersion: bigint('pointer_version', { mode: 'bigint' }).notNull().default(BigInt(0)),
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
    pointerGeneration: bigint('pointer_generation', { mode: 'bigint' }).notNull().default(BigInt(0)),
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
    headRevision: bigint('head_revision', { mode: 'bigint' }).notNull().default(BigInt(0)),
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
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
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
    index('repository_command_audits_work_package_id_idx').on(t.workPackageId),
    index('repository_command_audits_agent_run_id_idx').on(t.agentRunId),
    index('repository_command_audits_artifact_id_idx').on(t.artifactId),
    index('repository_command_audits_started_at_idx').on(t.startedAt),
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
export const taskQuestions = pgTable(
  'task_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
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
