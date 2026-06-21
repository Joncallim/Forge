import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'

const HASH_VERSION = '1'
const KEY_LENGTH = 64
const SCRYPT_COST = 16384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128

function deriveKey(password: string, salt: string, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (err, derivedKey) => {
      if (err) {
        reject(err)
        return
      }

      resolve(derivedKey)
    })
  })
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`
  }

  return null
}

export async function hashPassword(password: string): Promise<string> {
  const validationError = validatePassword(password)
  if (validationError) throw new Error(validationError)

  const salt = randomBytes(16).toString('base64url')
  const derivedKey = await deriveKey(password, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  })

  return [
    'scrypt',
    HASH_VERSION,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt,
    derivedKey.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (!storedHash) return false

  const parts = storedHash.split('$')
  if (parts.length !== 7) return false

  const [algorithm, version, costValue, blockSizeValue, parallelizationValue, salt, key] = parts
  if (algorithm !== 'scrypt' || version !== HASH_VERSION || !salt || !key) return false

  const cost = Number(costValue)
  const blockSize = Number(blockSizeValue)
  const parallelization = Number(parallelizationValue)
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)) {
    return false
  }

  let expectedKey: Buffer
  try {
    expectedKey = Buffer.from(key, 'base64url')
  } catch {
    return false
  }

  if (expectedKey.length === 0) return false

  try {
    const actualKey = await deriveKey(password, salt, expectedKey.length, {
      cost,
      blockSize,
      parallelization,
    })

    return actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey)
  } catch {
    return false
  }
}
