import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(new URL('../db/migrations/0025_epic_172_release_routines.sql', import.meta.url)),
  'utf8',
)
const service = readFileSync(
  fileURLToPath(new URL('../lib/mcps/epic-172-release-recorder.ts', import.meta.url)),
  'utf8',
)
const bootstrap = readFileSync(
  fileURLToPath(new URL('../scripts/bootstrap-epic-172-release-roles.ts', import.meta.url)),
  'utf8',
)
const provisionApplicationRole = readFileSync(
  fileURLToPath(new URL('../scripts/provision-epic-172-application-role.ts', import.meta.url)),
  'utf8',
)
const operatorRunbook = readFileSync(
  fileURLToPath(new URL('../../docs/operators/epic-172-step0-retention-bridge.md', import.meta.url)),
  'utf8',
)
const webCi = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/web-ci.yml', import.meta.url)),
  'utf8',
)

describe('Epic 172 signed release recorder boundary', () => {
  it('moves release objects behind one non-login owner and removes bootstrap authority', () => {
    expect(bootstrap).toContain("const ROUTINES_OWNER = 'forge_release_routines_owner'")
    expect(bootstrap).toContain('create role forge_release_routines_owner nologin noinherit')
    expect(bootstrap).toContain('forge_finalize_epic_172_release_owner_bootstrap_v1')
    expect(bootstrap).toContain('membership.adminOption')
    expect(bootstrap).toContain('rolbypassrls as "bypassesRls"')
    expect(bootstrap).toContain('Dedicated release roles must not have role memberships or delegation paths.')
    expect(bootstrap).toContain('finalMemberships.length !== expectedMembershipCount')
    expect(bootstrap).not.toContain('with admin option')
    expect(migration.match(/OWNER TO forge_release_routines_owner/g)?.length).toBeGreaterThanOrEqual(12)
    expect(migration).toContain('SELECT public.forge_finalize_epic_172_release_owner_bootstrap_v1()')
    expect(migration).toContain('SET LOCAL ROLE forge_release_routines_owner')
    expect(migration).toContain('v_migration_role name := session_user')
    expect(migration.indexOf('RESET ROLE')).toBeLessThan(
      migration.indexOf('SELECT public.forge_finalize_epic_172_release_owner_bootstrap_v1()'),
    )
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)/i)
  })

  it('uses fixed-path, PUBLIC-revoked definer routines with principal-specific grants', () => {
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(13)
    expect(migration.match(/SET search_path = pg_catalog, public/g)).toHaveLength(13)
    expect(migration).toContain("session_user <> 'forge_release_evidence_writer'")
    expect(migration).toContain("session_user <> 'forge_release_transition'")
    expect(migration).toContain('TO forge_release_evidence_writer')
    expect(migration).toContain('TO forge_release_transition')
    expect(migration).toContain('REVOKE ALL ON FUNCTION forge.read_epic_172_enablement_state_v1()')
  })

  it('provisions the real ordinary app principal with exact fixed reader and projection grants', () => {
    expect(provisionApplicationRole).toContain("requiredConnectionUrl('FORGE_APPLICATION_DATABASE_URL')")
    expect(provisionApplicationRole).toContain('identity.currentUser !== identity.sessionUser')
    expect(provisionApplicationRole).toContain('applicationRoleIsUnsafe(role)')
    expect(provisionApplicationRole).toContain('membershipCount !== 0')
    expect(provisionApplicationRole).toContain('grant usage on schema forge')
    expect(provisionApplicationRole).toContain(
      'grant execute on function forge.read_epic_172_enablement_state_v1()',
    )
    expect(provisionApplicationRole).toContain(
      'grant execute on function forge.advance_local_projection_head_v1(',
    )
    expect(provisionApplicationRole).toContain('unexpectedTablePrivileges.length !== 0')
    expect(provisionApplicationRole).toContain('executableForgeFunctions.length !== 2')
    expect(provisionApplicationRole).toContain("!== 'advance_local_projection_head_v1'")
    expect(provisionApplicationRole).toContain("!== 'read_epic_172_enablement_state_v1'")
    expect(operatorRunbook).toContain('npm run protocol:provision-epic-172-application-role')
    expect(webCi).toContain('run: npm run protocol:provision-epic-172-application-role')
    expect(webCi).not.toContain(
      'GRANT EXECUTE ON FUNCTION forge.read_epic_172_enablement_state_v1() TO forge_app_test;',
    )
  })

  it('documents the immutable Step 0 build suffix required by the verifier', () => {
    expect(operatorRunbook).toContain(
      'exactBuilds:["issue_179_step0@<immutable-build-identity>"]',
    )
    expect(operatorRunbook).not.toContain('exactBuilds:["issue_179_step0"]')
  })

  it('locks exact signer, nonce, identity, predecessor, and authorization rows', () => {
    for (const lock of [
      'signer-policy',
      'evidence:identity:',
      'evidence:nonce:',
      'authorization:identity:',
      'authorization:nonce:',
      'consumption:receipt:',
      'consumption:identity:',
    ]) {
      expect(migration, lock).toContain(lock)
    }
    expect(migration).toContain("WHEN 'step0_retention_bridge' THEN ARRAY[]::text[]")
    expect(migration).toContain("WHEN 's3_issue_178' THEN ARRAY['step0_retention_bridge']")
    expect(migration).toContain("WHEN 's5_s6_release_ready' THEN ARRAY['enabled_build_tests_green', 'ingress_and_issuance_enabled']")
    expect(migration).toContain('FOR KEY SHARE OF e')
    expect(migration).toContain('lock_epic_172_transition_verification_v1')
    expect(migration).toContain('v_now >= v_authorization.expires_at')
  })

  it('verifies Ed25519 in Node while the database transaction locks remain held', () => {
    const lockIndex = service.indexOf('const signer = await lockSigner')
    const verifyIndex = service.indexOf('verifyEpic172ReleaseEvidence({')
    const insertIndex = service.indexOf('return insertVerifiedEvidence')
    expect(lockIndex).toBeGreaterThan(0)
    expect(verifyIndex).toBeGreaterThan(lockIndex)
    expect(insertIndex).toBeGreaterThan(verifyIndex)
    expect(service).toContain("if (key.asymmetricKeyType !== 'ed25519')")
    expect(service).toContain('forge.assert_epic_172_transition_authorization_live_v1')
  })

  it('uses audited compare-and-set rotation and generation-bound retirement', () => {
    expect(migration).toContain("status IN ('staged', 'active', 'retiring', 'retired')")
    expect(migration).toContain("'installed', NULL, 'staged'")
    expect(migration).toContain("'activated', 'staged', 'active'")
    expect(migration).toContain('p_expected_active_signer_key_id uuid')
    expect(migration).toContain('v_staged.generation <> p_expected_active_generation + 1')
    expect(migration).toContain("SET status = 'retiring', retirement_started_at = v_now")
    expect(migration).toContain('p_expected_generation bigint')
    expect(migration).toContain("SET status = 'retired', retired_at = v_now")
    expect(migration).toContain("active_key.generation > v_retiring.generation")
    expect(service).toContain('installEpic172ReleaseSigner')
    expect(service).toContain('activateEpic172ReleaseSigner')
    expect(service).toContain('retireEpic172ReleaseSigner')
  })

  it('allows a final authorization to cover both exact receipts without widening replay', () => {
    expect(migration).toContain('DROP INDEX public.forge_epic_172_release_evidence_consumptions_authorization_idx')
    expect(migration).toContain('forge_epic_172_release_evidence_consumptions_authorization_receipt_idx')
    expect(migration).toContain('UNIQUE INDEX forge_epic_172_release_evidence_consumptions_authorization_receipt_idx')
    expect(migration).toContain('lock_epic_172_transition_verification_v1(\n  p_receipt_ids uuid[]')
    expect(service).toContain('authorization.sourceReceiptIds.length !== input.receiptIds.length')
    expect(service).toContain('for (const receiptId of receiptIds)')
  })

  it('persists the exact ordered required-evidence measurement contract', () => {
    expect(migration).toContain('p_required_evidence jsonb')
    expect(migration).toContain("WHEN 'enabled_build_tests_green' THEN ARRAY[")
    expect(migration).toContain("claim.value ->> 'name' IS DISTINCT FROM v_expected_evidence_names")
    expect(migration).toContain("claim.value ->> 'measurementDigest' ~ '^[0-9a-f]{64}$'")
    expect(service).toContain('envelope.requiredEvidence.map')
  })

  it('stores and compares controller lease material as exact 32-byte values', () => {
    expect(migration).toContain('ALTER COLUMN controller_token_digest TYPE bytea')
    expect(migration).toContain('forge.epic_172_controller_lease_digest_v1')
    expect(migration).toContain('forge.constant_time_equal_32_v1')
    expect(migration).toContain('FOR v_index IN 0..31 LOOP')
    expect(migration).toContain('pg_catalog.get_byte(p_left, v_index) # pg_catalog.get_byte(p_right, v_index)')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION forge.epic_172_controller_lease_digest_v1(bytea)')
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION forge\.constant_time_equal_32_v1/)
  })
})
