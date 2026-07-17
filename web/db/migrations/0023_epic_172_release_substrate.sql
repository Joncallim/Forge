CREATE TABLE "forge_epic_172_enablement_state" (
	"singleton_id" text PRIMARY KEY DEFAULT 'epic-172' NOT NULL,
	"state" text DEFAULT 'disabled' NOT NULL,
	"owner_operation_id" text,
	"exact_builds" jsonb,
	"reviewed_sha" text,
	"epoch" bigint,
	"started_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"enablement_receipt_id" uuid,
	"final_readiness_receipt_id" uuid,
	"opening_authorization_id" uuid,
	"controller_login_id" text,
	"controller_run_id" text,
	"controller_token_digest" text,
	"lease_generation" bigint,
	"last_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"state_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_epic_172_enablement_singleton_chk" CHECK ("forge_epic_172_enablement_state"."singleton_id" = 'epic-172'),
	CONSTRAINT "forge_epic_172_enablement_state_chk" CHECK ("forge_epic_172_enablement_state"."state" in ('disabled', 'provisional', 'active')),
	CONSTRAINT "forge_epic_172_enablement_sha_chk" CHECK ("forge_epic_172_enablement_state"."reviewed_sha" is null or "forge_epic_172_enablement_state"."reviewed_sha" ~ '^[0-9a-f]{40,64}$'),
	CONSTRAINT "forge_epic_172_enablement_epoch_chk" CHECK ("forge_epic_172_enablement_state"."epoch" is null or "forge_epic_172_enablement_state"."epoch" > 0),
	CONSTRAINT "forge_epic_172_enablement_token_chk" CHECK ("forge_epic_172_enablement_state"."controller_token_digest" is null or "forge_epic_172_enablement_state"."controller_token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_enablement_lease_generation_chk" CHECK ("forge_epic_172_enablement_state"."lease_generation" is null or "forge_epic_172_enablement_state"."lease_generation" > 0),
	CONSTRAINT "forge_epic_172_enablement_fingerprint_chk" CHECK ("forge_epic_172_enablement_state"."state_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_enablement_disabled_chk" CHECK ("forge_epic_172_enablement_state"."state" <> 'disabled' or (
        "forge_epic_172_enablement_state"."owner_operation_id" is null and "forge_epic_172_enablement_state"."exact_builds" is null and "forge_epic_172_enablement_state"."reviewed_sha" is null and
        "forge_epic_172_enablement_state"."epoch" is null and "forge_epic_172_enablement_state"."started_at" is null and "forge_epic_172_enablement_state"."expires_at" is null and
        "forge_epic_172_enablement_state"."enablement_receipt_id" is null and "forge_epic_172_enablement_state"."final_readiness_receipt_id" is null and
        "forge_epic_172_enablement_state"."opening_authorization_id" is null and "forge_epic_172_enablement_state"."controller_login_id" is null and
        "forge_epic_172_enablement_state"."controller_run_id" is null and "forge_epic_172_enablement_state"."controller_token_digest" is null and
        "forge_epic_172_enablement_state"."lease_generation" is null and "forge_epic_172_enablement_state"."last_heartbeat_at" is null and "forge_epic_172_enablement_state"."lease_expires_at" is null
      )),
	CONSTRAINT "forge_epic_172_enablement_provisional_chk" CHECK ("forge_epic_172_enablement_state"."state" <> 'provisional' or (
        "forge_epic_172_enablement_state"."owner_operation_id" is not null and jsonb_typeof("forge_epic_172_enablement_state"."exact_builds") = 'array' and
        "forge_epic_172_enablement_state"."reviewed_sha" is not null and "forge_epic_172_enablement_state"."epoch" is not null and "forge_epic_172_enablement_state"."started_at" is not null and
        "forge_epic_172_enablement_state"."expires_at" is not null and "forge_epic_172_enablement_state"."expires_at" > "forge_epic_172_enablement_state"."started_at" and
        "forge_epic_172_enablement_state"."enablement_receipt_id" is not null and "forge_epic_172_enablement_state"."opening_authorization_id" is not null and
        "forge_epic_172_enablement_state"."controller_login_id" is not null and "forge_epic_172_enablement_state"."controller_run_id" is not null and
        "forge_epic_172_enablement_state"."controller_token_digest" is not null and "forge_epic_172_enablement_state"."lease_generation" is not null and
        "forge_epic_172_enablement_state"."last_heartbeat_at" is not null and "forge_epic_172_enablement_state"."lease_expires_at" is not null and
        "forge_epic_172_enablement_state"."lease_expires_at" <= "forge_epic_172_enablement_state"."expires_at"
      )),
	CONSTRAINT "forge_epic_172_enablement_active_chk" CHECK ("forge_epic_172_enablement_state"."state" <> 'active' or (
        "forge_epic_172_enablement_state"."owner_operation_id" is not null and jsonb_typeof("forge_epic_172_enablement_state"."exact_builds") = 'array' and
        "forge_epic_172_enablement_state"."reviewed_sha" is not null and "forge_epic_172_enablement_state"."epoch" is not null and
        "forge_epic_172_enablement_state"."enablement_receipt_id" is not null and "forge_epic_172_enablement_state"."final_readiness_receipt_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "forge_epic_172_enablement_transition_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"disposition" text NOT NULL,
	"prior_state_fingerprint" text NOT NULL,
	"new_state_fingerprint" text NOT NULL,
	"operation_id" text NOT NULL,
	"actor" text NOT NULL,
	"controller_run_id" text,
	"authorization_id" uuid,
	"evidence_receipt_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_epic_172_enablement_transition_disposition_chk" CHECK ("forge_epic_172_enablement_transition_audits"."disposition" in ('opened', 'heartbeat', 'failed_disabled', 'expired_disabled', 'manually_disabled', 'promoted_active')),
	CONSTRAINT "forge_epic_172_enablement_transition_prior_fingerprint_chk" CHECK ("forge_epic_172_enablement_transition_audits"."prior_state_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_enablement_transition_new_fingerprint_chk" CHECK ("forge_epic_172_enablement_transition_audits"."new_state_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_enablement_transition_operation_chk" CHECK (length(btrim("forge_epic_172_enablement_transition_audits"."operation_id")) between 1 and 200),
	CONSTRAINT "forge_epic_172_enablement_transition_actor_chk" CHECK (length(btrim("forge_epic_172_enablement_transition_audits"."actor")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "forge_epic_172_release_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manifest_version" integer DEFAULT 1 NOT NULL,
	"evidence_kind" text NOT NULL,
	"owner_issue" integer NOT NULL,
	"owner_slice" text NOT NULL,
	"exact_builds" jsonb NOT NULL,
	"required_evidence" jsonb NOT NULL,
	"reviewed_sha" text NOT NULL,
	"epoch" bigint,
	"predecessor_receipt_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"predecessor_set_digest" text NOT NULL,
	"transition_identity_digest" text NOT NULL,
	"signer_key_id" uuid NOT NULL,
	"signer_generation" bigint NOT NULL,
	"github_app_id" text NOT NULL,
	"controller_run_id" text NOT NULL,
	"controller_job_id" text NOT NULL,
	"signature_domain" text DEFAULT 'forge:epic-172-release-evidence:v1' NOT NULL,
	"envelope_version" integer DEFAULT 1 NOT NULL,
	"envelope_digest" text NOT NULL,
	"detached_signature" "bytea" NOT NULL,
	"nonce" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"envelope" jsonb NOT NULL,
	CONSTRAINT "forge_epic_172_release_evidence_manifest_chk" CHECK ("forge_epic_172_release_evidence"."manifest_version" = 1),
	CONSTRAINT "forge_epic_172_release_evidence_owner_issue_chk" CHECK ("forge_epic_172_release_evidence"."owner_issue" > 0),
	CONSTRAINT "forge_epic_172_release_evidence_owner_slice_chk" CHECK ("forge_epic_172_release_evidence"."owner_slice" in ('step0', 's3', 's4', 's5', 's6')),
	CONSTRAINT "forge_epic_172_release_evidence_builds_chk" CHECK (jsonb_typeof("forge_epic_172_release_evidence"."exact_builds") = 'array' and jsonb_array_length("forge_epic_172_release_evidence"."exact_builds") > 0),
	CONSTRAINT "forge_epic_172_release_evidence_required_evidence_chk" CHECK (jsonb_typeof("forge_epic_172_release_evidence"."required_evidence") = 'array' and jsonb_array_length("forge_epic_172_release_evidence"."required_evidence") > 0),
	CONSTRAINT "forge_epic_172_release_evidence_sha_chk" CHECK ("forge_epic_172_release_evidence"."reviewed_sha" ~ '^[0-9a-f]{40,64}$'),
	CONSTRAINT "forge_epic_172_release_evidence_epoch_chk" CHECK ("forge_epic_172_release_evidence"."epoch" is null or "forge_epic_172_release_evidence"."epoch" > 0),
	CONSTRAINT "forge_epic_172_release_evidence_predecessors_chk" CHECK (jsonb_typeof("forge_epic_172_release_evidence"."predecessor_receipt_ids") = 'array'),
	CONSTRAINT "forge_epic_172_release_evidence_predecessor_digest_chk" CHECK ("forge_epic_172_release_evidence"."predecessor_set_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_release_evidence_identity_digest_chk" CHECK ("forge_epic_172_release_evidence"."transition_identity_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_release_evidence_generation_chk" CHECK ("forge_epic_172_release_evidence"."signer_generation" > 0),
	CONSTRAINT "forge_epic_172_release_evidence_domain_chk" CHECK ("forge_epic_172_release_evidence"."signature_domain" = 'forge:epic-172-release-evidence:v1'),
	CONSTRAINT "forge_epic_172_release_evidence_envelope_version_chk" CHECK ("forge_epic_172_release_evidence"."envelope_version" = 1),
	CONSTRAINT "forge_epic_172_release_evidence_envelope_digest_chk" CHECK ("forge_epic_172_release_evidence"."envelope_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_release_evidence_signature_chk" CHECK (octet_length("forge_epic_172_release_evidence"."detached_signature") = 64),
	CONSTRAINT "forge_epic_172_release_evidence_time_chk" CHECK ("forge_epic_172_release_evidence"."recorded_at" >= "forge_epic_172_release_evidence"."issued_at"),
	CONSTRAINT "forge_epic_172_release_evidence_envelope_chk" CHECK (jsonb_typeof("forge_epic_172_release_evidence"."envelope") = 'object')
);
--> statement-breakpoint
CREATE TABLE "forge_epic_172_release_evidence_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"transition_identity_digest" text NOT NULL,
	"authorization_id" uuid NOT NULL,
	"consumer_node" text NOT NULL,
	"operation_id" text NOT NULL,
	"actor" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_epic_172_release_evidence_consumptions_identity_chk" CHECK ("forge_epic_172_release_evidence_consumptions"."transition_identity_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_release_evidence_consumptions_consumer_chk" CHECK (length(btrim("forge_epic_172_release_evidence_consumptions"."consumer_node")) between 1 and 100),
	CONSTRAINT "forge_epic_172_release_evidence_consumptions_operation_chk" CHECK (length(btrim("forge_epic_172_release_evidence_consumptions"."operation_id")) between 1 and 200),
	CONSTRAINT "forge_epic_172_release_evidence_consumptions_actor_chk" CHECK (length(btrim("forge_epic_172_release_evidence_consumptions"."actor")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "forge_epic_172_transition_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manifest_version" integer DEFAULT 1 NOT NULL,
	"target_node" text NOT NULL,
	"transition_identity_digest" text NOT NULL,
	"source_receipt_ids" jsonb NOT NULL,
	"source_receipt_set_digest" text NOT NULL,
	"owner_issue" integer NOT NULL,
	"owner_slice" text NOT NULL,
	"exact_builds" jsonb NOT NULL,
	"reviewed_sha" text NOT NULL,
	"epoch" bigint,
	"operation_id" text NOT NULL,
	"operation" text NOT NULL,
	"controller_login_id" text NOT NULL,
	"controller_run_id" text NOT NULL,
	"signer_key_id" uuid NOT NULL,
	"signer_generation" bigint NOT NULL,
	"signature_domain" text DEFAULT 'forge:epic-172-transition-authorization:v1' NOT NULL,
	"envelope_version" integer DEFAULT 1 NOT NULL,
	"envelope_digest" text NOT NULL,
	"detached_signature" "bytea" NOT NULL,
	"nonce" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"envelope" jsonb NOT NULL,
	CONSTRAINT "forge_epic_172_transition_authorizations_manifest_chk" CHECK ("forge_epic_172_transition_authorizations"."manifest_version" = 1),
	CONSTRAINT "forge_epic_172_transition_authorizations_identity_chk" CHECK ("forge_epic_172_transition_authorizations"."transition_identity_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_transition_authorizations_sources_chk" CHECK (jsonb_typeof("forge_epic_172_transition_authorizations"."source_receipt_ids") = 'array' and jsonb_array_length("forge_epic_172_transition_authorizations"."source_receipt_ids") > 0),
	CONSTRAINT "forge_epic_172_transition_authorizations_source_digest_chk" CHECK ("forge_epic_172_transition_authorizations"."source_receipt_set_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_transition_authorizations_owner_issue_chk" CHECK ("forge_epic_172_transition_authorizations"."owner_issue" > 0),
	CONSTRAINT "forge_epic_172_transition_authorizations_owner_slice_chk" CHECK ("forge_epic_172_transition_authorizations"."owner_slice" in ('step0', 's3', 's4', 's5', 's6')),
	CONSTRAINT "forge_epic_172_transition_authorizations_builds_chk" CHECK (jsonb_typeof("forge_epic_172_transition_authorizations"."exact_builds") = 'array' and jsonb_array_length("forge_epic_172_transition_authorizations"."exact_builds") > 0),
	CONSTRAINT "forge_epic_172_transition_authorizations_sha_chk" CHECK ("forge_epic_172_transition_authorizations"."reviewed_sha" ~ '^[0-9a-f]{40,64}$'),
	CONSTRAINT "forge_epic_172_transition_authorizations_epoch_chk" CHECK ("forge_epic_172_transition_authorizations"."epoch" is null or "forge_epic_172_transition_authorizations"."epoch" > 0),
	CONSTRAINT "forge_epic_172_transition_authorizations_generation_chk" CHECK ("forge_epic_172_transition_authorizations"."signer_generation" > 0),
	CONSTRAINT "forge_epic_172_transition_authorizations_domain_chk" CHECK ("forge_epic_172_transition_authorizations"."signature_domain" = 'forge:epic-172-transition-authorization:v1'),
	CONSTRAINT "forge_epic_172_transition_authorizations_envelope_version_chk" CHECK ("forge_epic_172_transition_authorizations"."envelope_version" = 1),
	CONSTRAINT "forge_epic_172_transition_authorizations_envelope_digest_chk" CHECK ("forge_epic_172_transition_authorizations"."envelope_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_epic_172_transition_authorizations_signature_chk" CHECK (octet_length("forge_epic_172_transition_authorizations"."detached_signature") = 64),
	CONSTRAINT "forge_epic_172_transition_authorizations_lifetime_chk" CHECK ("forge_epic_172_transition_authorizations"."expires_at" > "forge_epic_172_transition_authorizations"."issued_at" and "forge_epic_172_transition_authorizations"."expires_at" <= "forge_epic_172_transition_authorizations"."issued_at" + interval '30 minutes'),
	CONSTRAINT "forge_epic_172_transition_authorizations_recorded_chk" CHECK ("forge_epic_172_transition_authorizations"."recorded_at" >= "forge_epic_172_transition_authorizations"."issued_at"),
	CONSTRAINT "forge_epic_172_transition_authorizations_envelope_chk" CHECK (jsonb_typeof("forge_epic_172_transition_authorizations"."envelope") = 'object')
);
--> statement-breakpoint
CREATE TABLE "forge_release_signer_key_lifecycle_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signer_key_id" uuid NOT NULL,
	"signer_generation" bigint NOT NULL,
	"action" text NOT NULL,
	"prior_status" text,
	"new_status" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_release_signer_lifecycle_generation_chk" CHECK ("forge_release_signer_key_lifecycle_audits"."signer_generation" > 0),
	CONSTRAINT "forge_release_signer_lifecycle_action_chk" CHECK ("forge_release_signer_key_lifecycle_audits"."action" in ('installed', 'activated', 'retirement_started', 'retired')),
	CONSTRAINT "forge_release_signer_lifecycle_prior_status_chk" CHECK ("forge_release_signer_key_lifecycle_audits"."prior_status" is null or "forge_release_signer_key_lifecycle_audits"."prior_status" in ('active', 'retiring', 'retired')),
	CONSTRAINT "forge_release_signer_lifecycle_new_status_chk" CHECK ("forge_release_signer_key_lifecycle_audits"."new_status" in ('active', 'retiring', 'retired')),
	CONSTRAINT "forge_release_signer_lifecycle_actor_chk" CHECK (length(btrim("forge_release_signer_key_lifecycle_audits"."actor")) between 1 and 200),
	CONSTRAINT "forge_release_signer_lifecycle_reason_chk" CHECK (length("forge_release_signer_key_lifecycle_audits"."reason") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "forge_release_signer_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" text DEFAULT 'forge-epic-172-release-signing-v1' NOT NULL,
	"generation" bigint NOT NULL,
	"algorithm" text DEFAULT 'Ed25519' NOT NULL,
	"public_key_spki" "bytea" NOT NULL,
	"github_app_id" text NOT NULL,
	"ruleset_fingerprint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"retirement_started_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_release_signer_keys_policy_chk" CHECK ("forge_release_signer_keys"."policy_id" = 'forge-epic-172-release-signing-v1'),
	CONSTRAINT "forge_release_signer_keys_generation_chk" CHECK ("forge_release_signer_keys"."generation" > 0),
	CONSTRAINT "forge_release_signer_keys_algorithm_chk" CHECK ("forge_release_signer_keys"."algorithm" = 'Ed25519'),
	CONSTRAINT "forge_release_signer_keys_public_key_chk" CHECK (octet_length("forge_release_signer_keys"."public_key_spki") > 0),
	CONSTRAINT "forge_release_signer_keys_fingerprint_chk" CHECK ("forge_release_signer_keys"."ruleset_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forge_release_signer_keys_status_chk" CHECK ("forge_release_signer_keys"."status" in ('active', 'retiring', 'retired')),
	CONSTRAINT "forge_release_signer_keys_validity_chk" CHECK ("forge_release_signer_keys"."valid_until" > "forge_release_signer_keys"."valid_from"),
	CONSTRAINT "forge_release_signer_keys_lifecycle_chk" CHECK (("forge_release_signer_keys"."status" = 'active' and "forge_release_signer_keys"."retirement_started_at" is null and "forge_release_signer_keys"."retired_at" is null)
        or ("forge_release_signer_keys"."status" = 'retiring' and "forge_release_signer_keys"."retirement_started_at" is not null and "forge_release_signer_keys"."retired_at" is null)
        or ("forge_release_signer_keys"."status" = 'retired' and "forge_release_signer_keys"."retirement_started_at" is not null and "forge_release_signer_keys"."retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "forge_epic_172_enablement_state" ADD CONSTRAINT "forge_epic_172_enablement_state_enablement_receipt_id_forge_epic_172_release_evidence_id_fk" FOREIGN KEY ("enablement_receipt_id") REFERENCES "public"."forge_epic_172_release_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_enablement_state" ADD CONSTRAINT "forge_epic_172_enablement_state_final_readiness_receipt_id_forge_epic_172_release_evidence_id_fk" FOREIGN KEY ("final_readiness_receipt_id") REFERENCES "public"."forge_epic_172_release_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_enablement_state" ADD CONSTRAINT "forge_epic_172_enablement_state_opening_authorization_id_forge_epic_172_transition_authorizations_id_fk" FOREIGN KEY ("opening_authorization_id") REFERENCES "public"."forge_epic_172_transition_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_enablement_transition_audits" ADD CONSTRAINT "forge_epic_172_enablement_transition_audits_authorization_id_forge_epic_172_transition_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."forge_epic_172_transition_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_enablement_transition_audits" ADD CONSTRAINT "forge_epic_172_enablement_transition_audits_evidence_receipt_id_forge_epic_172_release_evidence_id_fk" FOREIGN KEY ("evidence_receipt_id") REFERENCES "public"."forge_epic_172_release_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_release_evidence" ADD CONSTRAINT "forge_epic_172_release_evidence_signer_key_id_forge_release_signer_keys_id_fk" FOREIGN KEY ("signer_key_id") REFERENCES "public"."forge_release_signer_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_release_evidence_consumptions" ADD CONSTRAINT "forge_epic_172_release_evidence_consumptions_receipt_id_forge_epic_172_release_evidence_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."forge_epic_172_release_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_release_evidence_consumptions" ADD CONSTRAINT "forge_epic_172_release_evidence_consumptions_authorization_id_forge_epic_172_transition_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."forge_epic_172_transition_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_epic_172_transition_authorizations" ADD CONSTRAINT "forge_epic_172_transition_authorizations_signer_key_id_forge_release_signer_keys_id_fk" FOREIGN KEY ("signer_key_id") REFERENCES "public"."forge_release_signer_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_release_signer_key_lifecycle_audits" ADD CONSTRAINT "forge_release_signer_key_lifecycle_audits_signer_key_id_forge_release_signer_keys_id_fk" FOREIGN KEY ("signer_key_id") REFERENCES "public"."forge_release_signer_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forge_epic_172_enablement_transition_operation_idx" ON "forge_epic_172_enablement_transition_audits" USING btree ("operation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "forge_epic_172_enablement_transition_disposition_idx" ON "forge_epic_172_enablement_transition_audits" USING btree ("disposition","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_release_evidence_transition_identity_idx" ON "forge_epic_172_release_evidence" USING btree ("transition_identity_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_release_evidence_nonce_idx" ON "forge_epic_172_release_evidence" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_release_evidence_envelope_digest_idx" ON "forge_epic_172_release_evidence" USING btree ("envelope_digest");--> statement-breakpoint
CREATE INDEX "forge_epic_172_release_evidence_kind_idx" ON "forge_epic_172_release_evidence" USING btree ("manifest_version","evidence_kind");--> statement-breakpoint
CREATE INDEX "forge_epic_172_release_evidence_signer_idx" ON "forge_epic_172_release_evidence" USING btree ("signer_key_id","signer_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_release_evidence_consumptions_receipt_idx" ON "forge_epic_172_release_evidence_consumptions" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_release_evidence_consumptions_authorization_idx" ON "forge_epic_172_release_evidence_consumptions" USING btree ("authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_release_evidence_consumptions_identity_consumer_idx" ON "forge_epic_172_release_evidence_consumptions" USING btree ("transition_identity_digest","consumer_node");--> statement-breakpoint
CREATE INDEX "forge_epic_172_release_evidence_consumptions_operation_idx" ON "forge_epic_172_release_evidence_consumptions" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_transition_authorizations_nonce_idx" ON "forge_epic_172_transition_authorizations" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_epic_172_transition_authorizations_envelope_digest_idx" ON "forge_epic_172_transition_authorizations" USING btree ("envelope_digest");--> statement-breakpoint
CREATE INDEX "forge_epic_172_transition_authorizations_target_idx" ON "forge_epic_172_transition_authorizations" USING btree ("manifest_version","target_node");--> statement-breakpoint
CREATE INDEX "forge_epic_172_transition_authorizations_expiry_idx" ON "forge_epic_172_transition_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "forge_epic_172_transition_authorizations_signer_idx" ON "forge_epic_172_transition_authorizations" USING btree ("signer_key_id","signer_generation");--> statement-breakpoint
CREATE INDEX "forge_release_signer_lifecycle_key_idx" ON "forge_release_signer_key_lifecycle_audits" USING btree ("signer_key_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_release_signer_keys_policy_generation_idx" ON "forge_release_signer_keys" USING btree ("policy_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_release_signer_keys_ruleset_fingerprint_idx" ON "forge_release_signer_keys" USING btree ("ruleset_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_release_signer_keys_one_active_policy_idx" ON "forge_release_signer_keys" USING btree ("policy_id") WHERE "forge_release_signer_keys"."status" = 'active';--> statement-breakpoint
CREATE INDEX "forge_release_signer_keys_status_validity_idx" ON "forge_release_signer_keys" USING btree ("status","valid_from","valid_until");
--> statement-breakpoint
INSERT INTO "forge_epic_172_enablement_state" (
	"singleton_id",
	"state",
	"state_fingerprint"
) VALUES (
	'epic-172',
	'disabled',
	'b0789177e07f4a9307f3397a938999b6fcc8c835a97e03d2770f83e4978c2585'
) ON CONFLICT ("singleton_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "forge_epic_172_reject_mutation_v1"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	RAISE EXCEPTION 'Forge Epic 172 retained evidence is append-only'
		USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "forge_release_signer_keys_no_delete"
BEFORE DELETE ON "forge_release_signer_keys"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_mutation_v1"();
--> statement-breakpoint
CREATE TRIGGER "forge_release_signer_lifecycle_append_only"
BEFORE UPDATE OR DELETE ON "forge_release_signer_key_lifecycle_audits"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_mutation_v1"();
--> statement-breakpoint
CREATE TRIGGER "forge_epic_172_release_evidence_append_only"
BEFORE UPDATE OR DELETE ON "forge_epic_172_release_evidence"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_mutation_v1"();
--> statement-breakpoint
CREATE TRIGGER "forge_epic_172_transition_authorizations_append_only"
BEFORE UPDATE OR DELETE ON "forge_epic_172_transition_authorizations"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_mutation_v1"();
--> statement-breakpoint
CREATE TRIGGER "forge_epic_172_release_consumptions_append_only"
BEFORE UPDATE OR DELETE ON "forge_epic_172_release_evidence_consumptions"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_mutation_v1"();
--> statement-breakpoint
CREATE TRIGGER "forge_epic_172_enablement_state_no_delete"
BEFORE DELETE ON "forge_epic_172_enablement_state"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_mutation_v1"();
--> statement-breakpoint
CREATE TRIGGER "forge_epic_172_enablement_audits_append_only"
BEFORE UPDATE OR DELETE ON "forge_epic_172_enablement_transition_audits"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_mutation_v1"();
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_release_evidence_writer') THEN
		CREATE ROLE forge_release_evidence_writer LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_release_transition') THEN
		CREATE ROLE forge_release_transition LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
	END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON TABLE
	"forge_release_signer_keys",
	"forge_release_signer_key_lifecycle_audits",
	"forge_epic_172_release_evidence",
	"forge_epic_172_transition_authorizations",
	"forge_epic_172_release_evidence_consumptions",
	"forge_epic_172_enablement_state",
	"forge_epic_172_enablement_transition_audits"
FROM PUBLIC, forge_release_evidence_writer, forge_release_transition;
--> statement-breakpoint
GRANT SELECT ON TABLE
	"forge_release_signer_keys",
	"forge_release_signer_key_lifecycle_audits",
	"forge_epic_172_release_evidence",
	"forge_epic_172_transition_authorizations"
TO forge_release_evidence_writer;
--> statement-breakpoint
GRANT SELECT ON TABLE
	"forge_release_signer_keys",
	"forge_epic_172_release_evidence",
	"forge_epic_172_transition_authorizations",
	"forge_epic_172_release_evidence_consumptions",
	"forge_epic_172_enablement_state",
	"forge_epic_172_enablement_transition_audits"
TO forge_release_transition;
