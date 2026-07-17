# Epic 172 Step 0 retention bridge

## What this checkpoint does

Step 0 makes later MCP admission upgrades safe to install. It closes every
project-management write path, archives projects instead of deleting their files
or history, and keeps task and execution evidence in PostgreSQL. It also installs
the signed release ledger used by the later S3–S6 checkpoints.

This checkpoint does **not** enable bounded context packet issuance. The singleton
release state must remain `disabled`. A successful workstation test is not release
evidence, and the external signer private key must never enter Forge.

## Before the maintenance window

- Prepare separate PostgreSQL certificates and connection URLs for
  `forge_release_evidence_writer` and `forge_release_transition`. These roles are
  `LOGIN NOINHERIT`; do not give them
  passwords, role memberships, or the normal Forge application URL.
- Keep a short-lived administrator URL available for role creation and inspection.
- Prepare an external Ed25519 signer. Forge receives its public key and detached
  signatures only.
- Record the exact reviewed commit and build identity. Step 0 uses
  `exactBuilds:["issue_179_step0"]`, `owner:{"issue":179,"slice":"step0"}`, and
  `epoch:null`.

## Deploy and prove the bridge

1. Stop the web and worker processes. Stop queue intake and every script or service
   that can create, update, or delete a project.
2. Drain old database sessions. Before continuing, an administrator should confirm
   that no pre-bridge Forge web, worker, or maintenance session remains in
   `pg_stat_activity`.
3. Create the least-privilege roles and temporary migration-owner handoff:

   ```bash
   cd web
   FORGE_DATABASE_ADMIN_URL='postgresql://…' \
   DATABASE_URL='postgresql://forge-migration@…' \
   npm run protocol:bootstrap-epic-172-release-roles
   ```

4. Run the normal migration as the migration login. Migration 0025 transfers the
   seven release tables and fixed-path routines to the `NOLOGIN NOINHERIT`
   `forge_release_routines_owner`, then removes the migration login's temporary
   membership before the transaction commits.

   ```bash
   DATABASE_URL='postgresql://forge-migration@…' npm run db:migrate
   ```

5. Deploy the Step 0 web and worker build. Keep project ingress and release
   enablement closed. Do not start an older binary against the migrated database.
6. Inspect the live database using a short-lived administrator URL:

   ```bash
   FORGE_EPIC_172_ADMIN_DATABASE_URL='postgresql://…' \
   npm run protocol:epic-172-release -- inspect
   ```

   The command exits nonzero unless the enablement row is disabled, the project
   hard-delete trigger is enabled, the exact 43 release/retention foreign keys use
   `RESTRICT` or `NO ACTION`, and all three release role identities have the expected login
   and inheritance settings. `step0ReceiptCount` may still be zero at this point.

7. Install and activate the external signer's public key through the certificate-
   authenticated evidence-writer URL. The example timestamps must be replaced by
   the reviewed validity window.

   ```bash
   export FORGE_EPIC_172_EVIDENCE_DATABASE_URL='postgresql://forge_release_evidence_writer@…'
   npm run protocol:epic-172-release -- install-signer \
     --key-id 00000000-0000-4000-8000-000000000001 \
     --generation 1 \
     --public-key /outside-forge/release-public-key.pem \
     --github-app-id 172179 \
     --ruleset-fingerprint 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
     --valid-from 2026-07-17T00:00:00.000Z \
     --valid-until 2026-08-17T00:00:00.000Z \
     --actor release-operator \
     --reason 'Epic 172 reviewed release signer'

   npm run protocol:epic-172-release -- activate-signer \
     --key-id 00000000-0000-4000-8000-000000000001 \
     --actor release-operator \
     --reason 'Activate the first reviewed signer generation'
   ```

8. Outside Forge, build the closed `Epic172ReleaseEvidenceEnvelope` for
   `step0_retention_bridge`. It must use an empty sorted predecessor list and the
   empty-set digest
   `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
   Its `requiredEvidence` array must contain every Step 0 postcondition from the
   release-order manifest, in that exact order. Each entry has only `name` and
   `measurementDigest`; the digest is the lowercase SHA-256 digest of the
   separately retained, bounded measurement artifact that proves that one
   postcondition. Do not put raw logs, secrets, or an unbounded transcript in the
   envelope. Digests shown in automated test fixtures are deterministic test data,
   not production evidence.
   Fill `transitionIdentityDigest` with the shared
   `epic172TransitionIdentityDigest` algorithm. Only do this after a human has
   verified the route, ingress closure, drain, retention constraints, hard-delete
   guard, release substrate, and disabled state.
9. Ask Forge to validate the unsigned envelope and print the exact domain-separated
   bytes that the external signer must sign:

   ```bash
   npm run protocol:epic-172-release -- prepare-evidence \
     --input /outside-forge/step0-envelope.json \
     > /outside-forge/step0-signing-request.json
   ```

   The external controller signs `signingPayloadBase64` with Ed25519. It then
   creates a closed JSON object containing only `envelope`, `envelopeDigest`, and
   `detachedSignatureBase64`. Neither this command nor any Forge process accepts a
   private-key option.
10. Record the signed receipt and inspect again:

    ```bash
    npm run protocol:epic-172-release -- record-evidence \
      --input /outside-forge/step0-signed.json

    FORGE_EPIC_172_ADMIN_DATABASE_URL='postgresql://…' \
    npm run protocol:epic-172-release -- inspect
    ```

    `step0ReceiptCount` must be exactly one before S3 is allowed to consume a
    separately signed, unexpired transition authorization. Use
    `prepare-authorization` and `record-authorization` for that later handoff.

## Rotate the external signer

Forge stores public keys only. Generate the next Ed25519 key outside Forge and
retain its private key only in the external signer. Install generation 2 with
`install-signer` and a new key ID, public key, ruleset fingerprint, and reviewed
validity window. Installation succeeds only for the exact next generation while
one signer is active and no other signer is staged.

Activate it with an explicit compare-and-set against the active key:

```bash
npm run protocol:epic-172-release -- rotate-signer \
  --key-id 00000000-0000-4000-8000-000000000002 \
  --expected-active-key-id 00000000-0000-4000-8000-000000000001 \
  --expected-active-generation 1 \
  --actor release-operator \
  --reason 'Rotate to reviewed signer generation 2'
```

The database records one cutoff time, moves generation 1 to `retiring`, and
activates generation 2 in the same transaction. Generation 1 receipts already
retained before that cutoff still verify, but generation 1 cannot record new
evidence or authorizations after the rotation commits. After checking retained
receipt verification, finish the lifecycle transition with the exact generation:

```bash
npm run protocol:epic-172-release -- retire-signer \
  --key-id 00000000-0000-4000-8000-000000000001 \
  --generation 1 \
  --actor release-operator \
  --reason 'Retained generation 1 receipts verified under generation 2'
```

If either compare-and-set loses a race, inspect the signer lifecycle audits and
start again from the current active generation. Do not retry with guessed IDs or
edit signer rows directly.

## Failure and rollback

- If role bootstrap or migration fails, keep every Forge process and project write
  path stopped. Correct the database problem and rerun the idempotent bootstrap and
  migration.
- If signer installation, signature verification, or receipt recording fails, do
  not manufacture an unsigned receipt. Keep release enablement disabled and obtain
  a corrected external signature.
- Rolling the application binary back does not authorize data rollback. Never drop
  the retained tables, restore cascade deletes, remove the hard-delete guard, or
  delete a signed receipt. An older binary must remain stopped because it cannot
  interpret the new operator-hold and retention contract.
- A signed Step 0 receipt is immutable. An expired or rotated key does not erase it;
  later transitions still require a fresh, exact, short-lived authorization.
