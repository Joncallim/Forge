'use client'

import type { FormEvent } from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { startRegistration } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'

type RegisterFormProps = {
  passkeysEnabled?: boolean
}

export function RegisterForm({ passkeysEnabled = true }: RegisterFormProps) {
  const router = useRouter()
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const hasRequiredFields =
    displayName.trim().length > 0 &&
    password.length > 0 &&
    confirmPassword.length > 0 &&
    !loading

  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!displayName.trim()) return

    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters.')
      return
    }

    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.')
      return
    }

    setLoading(true)
    setErrorMessage(null)

    try {
      if (!passkeysEnabled) {
        const response = await fetch('/api/auth/register/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: displayName.trim(),
            password,
          }),
        })

        if (response.status === 409) {
          throw new Error('Registration is closed - an account already exists.')
        }

        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error ?? 'Registration failed. Please try again.')
        }

        router.push('/dashboard')
        return
      }

      // Step 1: Request registration options from the server
      const startResponse = await fetch('/api/auth/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim() }),
      })

      if (startResponse.status === 403) {
        throw new Error('Registration is closed - an account already exists.')
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
        body: JSON.stringify({ credential, password }),
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

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        {/* Wordmark */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Forge
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {passkeysEnabled ? 'Create a password and passkey' : 'Create a password'}
          </p>
        </div>

        <form onSubmit={handleRegister} className="space-y-4">
          <div>
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
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={loading}
              aria-required="true"
              aria-describedby={errorMessage !== null ? 'register-error' : undefined}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
            />
          </div>

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
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={loading}
              aria-required="true"
              aria-describedby={errorMessage !== null ? 'register-error' : undefined}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="confirm-password"
              className="mb-1.5 block text-sm font-medium text-foreground"
            >
              Confirm password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={loading}
              aria-required="true"
              aria-describedby={errorMessage !== null ? 'register-error' : undefined}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
            />
          </div>

          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={!hasRequiredFields}
            aria-busy={loading}
            aria-label={loading ? 'Creating account, please wait' : 'Create account'}
          >
            {loading ? 'Creating account...' : 'Create account'}
          </Button>
        </form>

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
          Already have an account?{' '}
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
