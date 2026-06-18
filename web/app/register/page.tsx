'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { startRegistration } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'

export default function RegisterPage() {
  const router = useRouter()
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleRegister() {
    if (!displayName.trim()) return

    setLoading(true)
    setErrorMessage(null)

    try {
      // Step 1: Request registration options from the server
      const startResponse = await fetch('/api/auth/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim() }),
      })

      if (startResponse.status === 403) {
        throw new Error('Registration is closed — an account already exists.')
      }

      if (!startResponse.ok) {
        throw new Error('Failed to start registration. Please try again.')
      }

      const { options } = await startResponse.json()

      // Step 2: Prompt the user to create a passkey via the browser WebAuthn API
      let credential
      try {
        credential = await startRegistration({ optionsJSON: options })
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === 'NotAllowedError') {
            throw new Error('Registration was cancelled or timed out. Please try again.')
          }
          if (err.name === 'InvalidStateError') {
            throw new Error('A passkey already exists for this device. Try signing in instead.')
          }
          if (err.name === 'SecurityError') {
            throw new Error('A security error occurred. Make sure you are on a secure connection.')
          }
        }
        throw new Error('Passkey creation failed. Please try again.')
      }

      // Step 3: Send the credential to the server to complete registration
      const finishResponse = await fetch('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      })

      if (!finishResponse.ok) {
        const data = await finishResponse.json().catch(() => ({}))
        throw new Error(data.error ?? 'Registration failed. Please try again.')
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

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && displayName.trim() && !loading) {
      handleRegister()
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
            Register your passkey
          </p>
        </div>

        {/* Display name input */}
        <div className="mb-4">
          <label
            htmlFor="display-name"
            className="mb-1.5 block text-sm font-medium text-foreground"
          >
            Your name
          </label>
          <input
            id="display-name"
            type="text"
            autoComplete="name"
            placeholder="e.g. Alex"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            aria-required="true"
            aria-describedby={errorMessage !== null ? 'register-error' : undefined}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          />
        </div>

        {/* Register button */}
        <Button
          size="lg"
          className="w-full"
          onClick={handleRegister}
          disabled={loading || !displayName.trim()}
          aria-busy={loading}
          aria-label={loading ? 'Registering, please wait' : 'Register passkey'}
        >
          {loading ? 'Registering...' : 'Register'}
        </Button>

        {/* Error message */}
        {errorMessage !== null && (
          <p
            id="register-error"
            role="alert"
            aria-live="assertive"
            className="mt-4 text-center text-sm text-destructive"
          >
            {errorMessage}
          </p>
        )}

        {/* Sign-in link */}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have a passkey?{' '}
          <Link
            href="/login"
            className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
