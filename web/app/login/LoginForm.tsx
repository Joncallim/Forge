'use client'

import type { FormEvent } from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { startAuthentication } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'

type SignInMethod = 'password' | 'passkey'

type LoginFormProps = {
  passkeysEnabled?: boolean
}

export function LoginForm({ passkeysEnabled = true }: LoginFormProps) {
  const router = useRouter()
  const [method, setMethod] = useState<SignInMethod>('password')
  const [password, setPassword] = useState('')
  const [loadingMethod, setLoadingMethod] = useState<SignInMethod | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [signedInVia, setSignedInVia] = useState<SignInMethod | null>(null)

  const loading = loadingMethod !== null || signedInVia !== null

  async function handlePasswordSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password) return

    setLoadingMethod('password')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/auth/login/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error ?? 'Sign-in failed. Please try again.')
      }

      router.push('/dashboard')
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred. Please try again.'
      setErrorMessage(message)
    } finally {
      setLoadingMethod(null)
    }
  }

  async function handlePasskeySignIn() {
    if (!passkeysEnabled) return

    setLoadingMethod('passkey')
    setErrorMessage(null)

    try {
      // Step 1: Request authentication options from the server
      const startResponse = await fetch('/api/auth/login/start', {
        method: 'POST',
      })

      if (!startResponse.ok) {
        throw new Error('Failed to start sign-in. Please try again.')
      }

      const { options, nonce } = await startResponse.json()

      // Step 2: Prompt the user for their passkey via the browser WebAuthn API
      let credential
      try {
        credential = await startAuthentication({ optionsJSON: options })
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === 'NotAllowedError') {
            throw new Error('Sign-in was cancelled or timed out. Please try again.')
          }
          if (err.name === 'SecurityError') {
            throw new Error('A security error occurred. Make sure you are on a secure connection.')
          }
        }
        throw new Error('Passkey authentication failed. Please try again.')
      }

      // Step 3: Send the credential back to verify
      const finishResponse = await fetch('/api/auth/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, credential }),
      })

      if (!finishResponse.ok) {
        const data = await finishResponse.json().catch(() => ({}))
        throw new Error(data.error ?? 'Sign-in failed. Please try again.')
      }

      // Step 4: Show a brief confirmation screen, then navigate to the dashboard.
      setLoadingMethod(null)
      setSignedInVia('passkey')
      router.prefetch('/dashboard')
      setTimeout(() => {
        router.push('/dashboard')
      }, 1200)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred. Please try again.'
      setErrorMessage(message)
      setLoadingMethod(null)
    }
  }

  function selectMethod(nextMethod: SignInMethod) {
    if (loading) return
    if (nextMethod === 'passkey' && !passkeysEnabled) return
    setMethod(nextMethod)
    setErrorMessage(null)
  }

  if (signedInVia !== null) {
    return (
      <div
        className="flex min-h-full flex-1 flex-col items-center justify-center bg-background px-4 py-12"
        role="status"
        aria-live="polite"
      >
        <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-full bg-muted text-2xl"
          >
            🔑
          </span>
          <div>
            <p className="text-base font-semibold text-foreground">
              {signedInVia === 'passkey' ? 'Signed in with your passkey' : 'Signed in'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">Taking you to your dashboard…</p>
          </div>
          <span
            aria-hidden="true"
            className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        {/* Wordmark */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Forge
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {passkeysEnabled ? 'Sign in with your password or passkey' : 'Sign in with your password'}
          </p>
        </div>

        {passkeysEnabled && (
          <div
            role="tablist"
            aria-label="Sign-in method"
            className="mb-5 grid grid-cols-2 rounded-lg border border-border bg-muted p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={method === 'password'}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                method === 'password'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => selectMethod('password')}
              disabled={loading}
            >
              Password
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={method === 'passkey'}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                method === 'passkey'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => selectMethod('passkey')}
              disabled={loading}
            >
              Passkey
            </button>
          </div>
        )}

        {method === 'password' || !passkeysEnabled ? (
          <form onSubmit={handlePasswordSignIn} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={loading}
                aria-required="true"
                aria-describedby={errorMessage !== null ? 'login-error' : undefined}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
              />
            </div>

            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={loading || !password}
              aria-busy={loadingMethod === 'password'}
              aria-label={loadingMethod === 'password' ? 'Signing in, please wait' : 'Sign in with password'}
            >
              {loadingMethod === 'password' ? 'Signing in...' : 'Sign in with password'}
            </Button>
          </form>
        ) : (
          <Button
            size="lg"
            className="w-full"
            onClick={handlePasskeySignIn}
            disabled={loading}
            aria-busy={loadingMethod === 'passkey'}
            aria-label={loadingMethod === 'passkey' ? 'Signing in, please wait' : 'Sign in with passkey'}
          >
            {loadingMethod === 'passkey' ? 'Signing in...' : 'Sign in with passkey'}
          </Button>
        )}

        {/* Error message */}
        {errorMessage !== null && (
          <p
            id="login-error"
            role="alert"
            aria-live="assertive"
            className="mt-4 text-center text-sm text-destructive"
          >
            {errorMessage}
          </p>
        )}

        {/* Register link */}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          First time?{' '}
          <Link
            href="/register"
            className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Create your account
          </Link>
          {' '}
          &#8594;
        </p>
      </div>
    </div>
  )
}
