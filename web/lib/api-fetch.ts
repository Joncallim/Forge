// Shared fetch helper for client components calling Forge's own API routes.
//
// Forge's session is server-side (Redis + Postgres, see lib/session.ts). A
// session can be invalidated at any time (revoked, user deleted, etc.), and
// when that happens every subsequent API call from the browser starts
// returning 401. Without central handling, each page's own ad hoc
// fetchError/Retry state just re-fires the same doomed request forever.
//
// `installUnauthorizedHandler` patches `window.fetch` once (from
// SessionProvider) so that ANY fetch call made by the app — whether it goes
// through `apiFetch` below or a raw `fetch('/api/...')` in an existing page —
// is observed. On a 401 response we treat the session as dead and redirect
// to /login immediately, instead of leaving the user stuck on a broken page.
//
// `apiFetch` is the preferred entry point for new code: a thin wrapper around
// `fetch` that exists mainly so call sites read clearly as "this is an
// authenticated Forge API call." The actual 401 handling lives in the global
// patch so it covers old call sites too.

type UnauthorizedHandler = () => void

let handler: UnauthorizedHandler | null = null
let patched = false

/**
 * Installs a global fetch interceptor that calls `onUnauthorized` whenever
 * any request made via `fetch` resolves with a 401 status. Safe to call
 * multiple times — only the first call patches `window.fetch`; subsequent
 * calls just update which handler runs (so a single SessionProvider mount
 * stays the source of truth even across fast refresh in dev).
 */
export function installUnauthorizedHandler(onUnauthorized: UnauthorizedHandler): void {
  handler = onUnauthorized

  if (patched || typeof window === 'undefined') return
  patched = true

  const originalFetch = window.fetch.bind(window)

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args)
    if (response.status === 401 && isForgeApiRequest(args[0])) {
      handler?.()
    }
    return response
  }
}

// Only Forge's own /api/* routes use the session this handler reacts to —
// a 401 from anything else (a model provider's own API, a third-party
// widget, etc.) must not force a logout/redirect.
function isForgeApiRequest(input: Parameters<typeof fetch>[0]): boolean {
  const raw = input instanceof Request ? input.url : String(input)
  try {
    const url = new URL(raw, window.location.origin)
    return url.origin === window.location.origin && url.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/**
 * Thin wrapper around `fetch` for calling Forge's own API routes from client
 * components. Functionally identical to `fetch` today — 401 handling is
 * applied globally via `installUnauthorizedHandler` — but new call sites
 * should prefer this so intent is explicit and so we have a single place to
 * extend (e.g. default headers) later.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init)
}
