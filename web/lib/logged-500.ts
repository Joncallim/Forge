const LOGGED_500_CONTEXTS = new WeakSet<Error>()

export interface Logged500Context {
  correlationId?: string
}

interface Logged500Payload {
  route: string
  errorClass: string
  correlationId?: string
  code?: string
}

const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{1,63})$/

function safeErrorClass(err: unknown): string {
  try {
    if (err instanceof EvalError) return 'EvalError'
    if (err instanceof RangeError) return 'RangeError'
    if (err instanceof ReferenceError) return 'ReferenceError'
    if (err instanceof SyntaxError) return 'SyntaxError'
    if (err instanceof TypeError) return 'TypeError'
    if (err instanceof URIError) return 'URIError'
    if (err instanceof AggregateError) return 'AggregateError'
    if (err instanceof Error) return 'Error'
  } catch {
    return 'UnknownError'
  }
  return 'UnknownError'
}

function errorInstance(err: unknown): Error | null {
  try {
    return err instanceof Error ? err : null
  } catch {
    return null
  }
}

function safeErrorCode(err: unknown): string | null {
  const visited = new Set<object>()
  let current = err
  for (let depth = 0; depth < 5; depth += 1) {
    if ((typeof current !== 'object' || current === null) && typeof current !== 'function') return null
    if (visited.has(current)) return null
    visited.add(current)

    let code: unknown
    let cause: unknown
    try {
      code = Reflect.get(current, 'code')
      cause = Reflect.get(current, 'cause')
    } catch {
      return null
    }
    if (typeof code === 'string' && SAFE_ERROR_CODE.test(code)) return code
    current = cause
  }
  return null
}

export function logged500Error(
  route: string,
  err: unknown,
  context?: Logged500Context,
): void {
  const error = errorInstance(err)
  if (error) {
    if (LOGGED_500_CONTEXTS.has(error)) return
    LOGGED_500_CONTEXTS.add(error)
  }

  const payload: Logged500Payload = {
    route,
    errorClass: safeErrorClass(err),
  }
  if (context?.correlationId && SAFE_CORRELATION_ID.test(context.correlationId)) {
    payload.correlationId = context.correlationId
  }
  const code = safeErrorCode(err)
  if (code) payload.code = code
  console.error(`[${route}] Unexpected error`, payload)
}

export function generic500Response(err: unknown, route: string): { error: string; status: 500; logged: boolean } {
  logged500Error(route, err)
  return { error: 'Internal server error', status: 500, logged: true }
}
