import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getTableName } from 'drizzle-orm'
import {
  forgeEpic172EnablementState,
  forgeEpic172EnablementTransitionAudits,
  forgeEpic172ReleaseEvidence,
  forgeEpic172ReleaseEvidenceConsumptions,
  forgeEpic172TransitionAuthorizations,
  forgeReleaseSignerKeyLifecycleAudits,
  forgeReleaseSignerKeys,
} from '@/db/schema'

const migration = readFileSync(
  fileURLToPath(new URL('../db/migrations/0023_epic_172_release_substrate.sql', import.meta.url)),
  'utf8',
)

describe('Epic 172 Step 0 release substrate', () => {
  it('exports exactly the seven owned release and transition tables', () => {
    expect([
      forgeReleaseSignerKeys,
      forgeReleaseSignerKeyLifecycleAudits,
      forgeEpic172ReleaseEvidence,
      forgeEpic172TransitionAuthorizations,
      forgeEpic172ReleaseEvidenceConsumptions,
      forgeEpic172EnablementState,
      forgeEpic172EnablementTransitionAudits,
    ].map(getTableName)).toEqual([
      'forge_release_signer_keys',
      'forge_release_signer_key_lifecycle_audits',
      'forge_epic_172_release_evidence',
      'forge_epic_172_transition_authorizations',
      'forge_epic_172_release_evidence_consumptions',
      'forge_epic_172_enablement_state',
      'forge_epic_172_enablement_transition_audits',
    ])
  })

  it('retains signed evidence with strict identities and short-lived authorizations', () => {
    expect(migration).toContain('release_evidence_transition_identity_idx')
    expect(migration).toContain('release_evidence_consumptions_receipt_idx')
    expect(migration).toContain('release_evidence_consumptions_authorization_idx')
    expect(migration).toContain("octet_length(\"forge_epic_172_release_evidence\".\"detached_signature\") = 64")
    expect(migration).toContain("octet_length(\"forge_epic_172_transition_authorizations\".\"detached_signature\") = 64")
    expect(migration).toContain("interval '30 minutes'")
    expect(migration.match(/ON DELETE restrict/g)).toHaveLength(10)
  })

  it('installs append-only guards and leaves direct mutation ungranted', () => {
    expect(migration.match(/EXECUTE FUNCTION \"forge_epic_172_reject_mutation_v1\"\(\)/g)).toHaveLength(7)
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "forge_epic_172_release_evidence"')
    expect(migration).toContain('BEFORE DELETE ON "forge_epic_172_enablement_state"')
    expect(migration).toContain('forge_release_evidence_writer LOGIN NOINHERIT')
    expect(migration).toContain('forge_release_evidence_consumer LOGIN NOINHERIT')
    expect(migration).toContain('forge_release_transition LOGIN NOINHERIT')
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)/)
  })

  it('initializes the sole authoritative enablement row disabled', () => {
    expect(migration).toContain('INSERT INTO "forge_epic_172_enablement_state"')
    expect(migration).toContain("'epic-172',\n\t'disabled'")
    expect(migration).toContain('b0789177e07f4a9307f3397a938999b6fcc8c835a97e03d2770f83e4978c2585')
    expect(migration).toContain("in ('disabled', 'provisional', 'active')")
  })
})
