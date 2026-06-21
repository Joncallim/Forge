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

export type RuntimeEnvCheck = {
  name: EnvVarName
  present: boolean
  message?: string
}

export function getRequiredEnv(name: EnvVarName): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `[env] ${name} is required. See docs/deployment-checklist.md for deployment values.`,
    )
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
    return {
      name,
      present,
      message: present ? undefined : `${name} is required`,
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
