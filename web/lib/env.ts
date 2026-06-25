import { passkeysEnabled } from '@/lib/auth-options'

type EnvVarName =
  | 'DATABASE_URL'
  | 'REDIS_URL'
  | 'SESSION_SECRET'
  | 'WEBAUTHN_RP_ID'
  | 'WEBAUTHN_RP_NAME'
  | 'WEBAUTHN_ORIGIN'

const BASE_RUNTIME_ENV: EnvVarName[] = [
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
]

const PASSKEY_RUNTIME_ENV: EnvVarName[] = [
  'WEBAUTHN_RP_ID',
  'WEBAUTHN_RP_NAME',
  'WEBAUTHN_ORIGIN',
]

const SECRET_ENV_NAMES = new Set(['SESSION_SECRET', 'FORGE_ENCRYPTION_KEY'])
const UNSAFE_SECRET_VALUES = new Set([
  'change_me',
  'change_me_generate_with_openssl_rand_hex_32',
  'placeholder',
])

export type RuntimeEnvCheck = {
  name: EnvVarName
  present: boolean
  message?: string
}

export function unsafeRuntimeSecretReason(name: string, value: string | undefined): string | null {
  if (!SECRET_ENV_NAMES.has(name)) return null
  const normalized = value?.trim()
  if (!normalized) return null
  if (UNSAFE_SECRET_VALUES.has(normalized.toLowerCase()) || normalized.toLowerCase().startsWith('change_me')) {
    return `${name} must be set to a generated secret, not the placeholder value`
  }
  return null
}

export function getRequiredEnv(name: EnvVarName): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `[env] ${name} is required. See docs/operator-guide.md for deployment values.`,
    )
  }
  const unsafeSecretReason = unsafeRuntimeSecretReason(name, value)
  if (unsafeSecretReason) {
    throw new Error(`[env] ${unsafeSecretReason}.`)
  }

  return value
}

export function requiredRuntimeEnv(): EnvVarName[] {
  return passkeysEnabled()
    ? [...BASE_RUNTIME_ENV, ...PASSKEY_RUNTIME_ENV]
    : BASE_RUNTIME_ENV
}

export function checkRuntimeEnv(): RuntimeEnvCheck[] {
  return requiredRuntimeEnv().map((name) => {
    const value = process.env[name]
    const present = value !== undefined && value.trim() !== ''
    const unsafeSecretReason = present ? unsafeRuntimeSecretReason(name, value) : null
    return {
      name,
      present: present && !unsafeSecretReason,
      message: unsafeSecretReason ?? (present ? undefined : `${name} is required`),
    }
  })
}

export function validateRuntimeEnv(): void {
  const missing = checkRuntimeEnv().filter((check) => !check.present)
  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required runtime env vars: ${missing.map((check) => check.name).join(', ')}`,
    )
  }
}
