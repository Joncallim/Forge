function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '')
}

function falsy(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value ?? '')
}

export function passkeysEnabled(): boolean {
  if (truthy(process.env.FORGE_DISABLE_PASSKEYS)) return false

  const configured = process.env.FORGE_PASSKEYS_ENABLED
  if (configured === undefined || configured.trim() === '') return true

  return !falsy(configured)
}
