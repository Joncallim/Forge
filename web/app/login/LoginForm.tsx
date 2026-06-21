'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { startAuthentication } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'

export function LoginForm() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSignIn() {
    setLoading(true)
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

      // Step 4: Navigate to the dashboard on success
      router.push('/dashboard')
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred. Please try again.'
      setErrorMessage(message)
    } finally {
      setLoading(false)
    }
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
            Sign in with your passkey
          </p>
        </div>

        {/* Sign-in button */}
        <Button
          size="lg"
          className="w-full"
          onClick={handleSignIn}
          disabled={loading}
          aria-busy={loading}
          aria-label={loading ? 'Signing in, please wait' : 'Sign in with passkey'}
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </Button>

        {/* Error message */}
        {errorMessage !== null && (
          <p
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
            Register your passkey
          </Link>
          {' '}
          &#8594;
        </p>
      </div>
    </div>
  )
}
