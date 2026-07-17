const LOGGED_500_CONTEXTS = new WeakSet<Error>()

export function logged500Error(
  route: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const error = err instanceof Error ? err : new Error(String(err))
  if (LOGGED_500_CONTEXTS.has(error)) return
  LOGGED_500_CONTEXTS.add(error)
  const message = error.message || 'Unknown server error'
  const payload: Record<string, unknown> = {
    route,
    error: message,
    ...extra,
  }
  if (error.stack) payload.stack = error.stack
  console.error(`[${route}] Unexpected error`, payload)
}

export function generic500Response(err: unknown, route: string): { error: string; status: 500; logged: boolean } {
  logged500Error(route, err)
  const message = err instanceof Error && process.env.NODE_ENV === 'development'
    ? err.message
    : 'Internal server error'
  return { error: message, status: 500, logged: true }
}
