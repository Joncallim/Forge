export function fixedDatabaseRoleUrl(input: {
  environmentName: string
  expectedUsername: string
  value: string | undefined
}): string {
  const raw = input.value?.trim() ?? ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${input.environmentName} must be a valid PostgreSQL URL.`)
  }
  const protocol = url.protocol.toLowerCase()
  let username = ''
  try {
    username = decodeURIComponent(url.username)
  } catch {
    throw new Error(`${input.environmentName} has an invalid database username.`)
  }
  const hasQueryPassword = [...url.searchParams.keys()].some((key) =>
    ['password', 'pass', 'pwd'].includes(key.toLowerCase()),
  )
  if (
    (protocol !== 'postgres:' && protocol !== 'postgresql:')
    || username !== input.expectedUsername
    || url.password !== ''
    || hasQueryPassword
    || url.hostname === ''
    || url.hash !== ''
  ) {
    throw new Error(
      `${input.environmentName} must be a passwordless PostgreSQL URL for ${input.expectedUsername}.`,
    )
  }
  return raw
}
