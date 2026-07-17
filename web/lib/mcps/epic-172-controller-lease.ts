import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const EPIC_172_CONTROLLER_LEASE_SECRET_BYTES_V1 = 32
export const EPIC_172_CONTROLLER_LEASE_DIGEST_DOMAIN_V1 = Buffer.from(
  'forge:epic-172-controller-lease:v1\0',
  'utf8',
)

const TEST_FIXTURE_SECRET = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
)

function requireSecretBytes(value: Uint8Array, label: string): Buffer {
  const bytes = Buffer.from(value)
  if (bytes.byteLength !== EPIC_172_CONTROLLER_LEASE_SECRET_BYTES_V1) {
    throw new Error(`${label} must be exactly ${EPIC_172_CONTROLLER_LEASE_SECRET_BYTES_V1} bytes.`)
  }
  return bytes
}

export function epic172ControllerLeaseDigestV1(secret: Uint8Array): Buffer {
  const bytes = requireSecretBytes(secret, 'Epic 172 controller lease secret')
  return createHash('sha256')
    .update(EPIC_172_CONTROLLER_LEASE_DIGEST_DOMAIN_V1)
    .update(bytes)
    .digest()
}

export function constantTimeEqualEpic172DigestV1(left: Uint8Array, right: Uint8Array): boolean {
  const leftBytes = requireSecretBytes(left, 'Left Epic 172 controller lease digest')
  const rightBytes = requireSecretBytes(right, 'Right Epic 172 controller lease digest')
  return timingSafeEqual(leftBytes, rightBytes)
}

export function assertEpic172ProductionControllerLeaseSecret(secret: Uint8Array): Buffer {
  const bytes = requireSecretBytes(secret, 'Epic 172 controller lease secret')
  if (timingSafeEqual(bytes, TEST_FIXTURE_SECRET)) {
    throw new Error('The public Epic 172 controller lease fixture secret is forbidden in production.')
  }
  return bytes
}

export function generateEpic172ControllerLeaseSecretV1(): Buffer {
  while (true) {
    const candidate = randomBytes(EPIC_172_CONTROLLER_LEASE_SECRET_BYTES_V1)
    if (!timingSafeEqual(candidate, TEST_FIXTURE_SECRET)) return candidate
  }
}
