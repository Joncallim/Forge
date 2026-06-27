'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { RefreshCwIcon } from 'lucide-react'

// In `next dev`, route chunks the user hasn't visited in a while are evicted
// and recompiled on demand. A request that lands mid-recompile can surface a
// transient ENOENT for a dev build manifest, which crashes the React tree
// with no recovery path other than a full Forge restart (see issue #86).
// This boundary recognizes that specific dev-only signature and offers a
// retry instead of a dead end; any other error still bubbles through the
// generic message below.
export function isDevManifestError(error: Error): boolean {
  return (
    /ENOENT/.test(error.message) &&
    /build-manifest\.json/.test(error.message)
  )
}

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [isRetrying, setIsRetrying] = useState(false)
  const devManifestError = isDevManifestError(error)

  useEffect(() => {
    console.error('[dashboard error boundary]', error)
  }, [error])

  const handleRetry = () => {
    setIsRetrying(true)
    reset()
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        {devManifestError ? 'The dev server is still recompiling' : 'Something went wrong'}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {devManifestError
          ? 'This page was rebuilt in the background and a request landed mid-rebuild. This is a Next.js dev-server timing issue, not a problem with your task or data — retrying should resolve it.'
          : 'An unexpected error occurred while loading this page.'}
      </p>
      <Button onClick={handleRetry} disabled={isRetrying}>
        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        {isRetrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}
