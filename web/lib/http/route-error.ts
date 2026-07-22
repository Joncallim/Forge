import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { logged500Error } from '@/lib/logged-500'

/**
 * Brand for typed, operator-safe HTTP errors. Membership is proved only by
 * constructing the error through {@link publicHttpError}; a plain object that
 * merely carries a numeric `status` can never impersonate it, so an untyped
 * failure can never smuggle its message into an HTTP response.
 */
const PUBLIC_HTTP_ERROR_BRAND: unique symbol = Symbol.for('forge.http.publicError')

export interface PublicHttpError extends Error {
  readonly status: number
  readonly publicMessage: string
  readonly [PUBLIC_HTTP_ERROR_BRAND]: true
}

/**
 * Construct a typed public HTTP error. Only 4xx statuses are permitted: the
 * message is contractually an approved, client-safe string. Anything that is
 * not one of these branded errors is treated at the route boundary as an
 * unknown internal failure and is never echoed to the caller.
 */
export function publicHttpError(message: string, status: number): PublicHttpError {
  if (!Number.isInteger(status) || status < 400 || status > 499) {
    throw new Error(`publicHttpError requires a 4xx status code, received ${String(status)}`)
  }
  return Object.assign(new Error(message), {
    status,
    publicMessage: message,
    [PUBLIC_HTTP_ERROR_BRAND]: true as const,
  })
}

export function isPublicHttpError(err: unknown): err is PublicHttpError {
  if (!(err instanceof Error)) return false
  const candidate = err as Partial<PublicHttpError> & Record<PropertyKey, unknown>
  return (
    candidate[PUBLIC_HTTP_ERROR_BRAND] === true &&
    typeof candidate.status === 'number' &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 400 &&
    candidate.status <= 499 &&
    typeof candidate.publicMessage === 'string'
  )
}

/**
 * Canonical route error boundary. Typed public 4xx errors surface their
 * approved message and status. Every other value — a plain Error, an object
 * with a forged numeric `status`, or an untyped 5xx — is logged server-side
 * against a fresh correlation id and answered with fixed generic text. The log
 * retains only an allowlisted error class and validated error code; exception
 * messages, stacks, filesystem paths, SQL details, prompt fragments, nonces,
 * and tokens never reach either output.
 */
export function respondToRouteError(route: string, err: unknown): NextResponse {
  if (isPublicHttpError(err)) {
    return NextResponse.json({ error: err.publicMessage }, { status: err.status })
  }
  const correlationId = randomUUID()
  logged500Error(route, err, { correlationId })
  return NextResponse.json({ error: 'Internal server error', correlationId }, { status: 500 })
}
