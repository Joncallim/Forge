'use client'

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  createElement,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { installUnauthorizedHandler } from '@/lib/api-fetch'

interface User {
  userId: string
  displayName: string
}

interface SessionContextValue {
  user: User | null
  loading: boolean
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

interface SessionProviderProps {
  children: ReactNode
}

export function SessionProvider({ children }: SessionProviderProps) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  // Centralized 401 handling: the server can invalidate a session at any
  // time (revoked, deleted user, etc.). Without this, each page's own ad hoc
  // fetchError/Retry UI just re-fires the same doomed request forever — see
  // lib/api-fetch.ts for the full rationale. Any fetch call anywhere in the
  // app (raw `fetch` or `apiFetch`) that gets a 401 back lands here.
  useEffect(() => {
    installUnauthorizedHandler(() => {
      setUser(null)

      // A 401 while already on /login (e.g. the initial /api/auth/me probe
      // for a visitor who was never signed in) is expected, not a session
      // that got revoked mid-use — there's nowhere useful to redirect to.
      if (window.location.pathname === '/login') return

      // The server has already invalidated the session; redirecting is what
      // actually matters here. Clearing the (now-meaningless) cookie is a
      // nice-to-have, so don't block navigation on it.
      void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
      router.push('/login')
    })
  }, [router])

  useEffect(() => {
    let cancelled = false

    async function fetchSession() {
      try {
        const response = await fetch('/api/auth/me')
        if (response.ok) {
          const data = await response.json()
          if (!cancelled) {
            setUser({ userId: data.userId, displayName: data.displayName })
          }
        } else {
          if (!cancelled) {
            setUser(null)
          }
        }
      } catch {
        if (!cancelled) {
          setUser(null)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchSession()

    return () => {
      cancelled = true
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Ignore network errors on logout — proceed with local cleanup
    } finally {
      setUser(null)
      router.push('/login')
    }
  }, [router])

  return createElement(
    SessionContext.Provider,
    { value: { user, loading, logout } },
    children,
  )
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext)
  if (context === null) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  return context
}
