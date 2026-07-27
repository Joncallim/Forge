export type SessionCachePurgeTarget = {
  attemptCount: number
  claimToken: string | null
  credentialDigestHex: string
  generation: string
  legacyCredential: string | null
  sessionId: string
}

export type SessionCachePurgeStore = {
  claimDue: (limit: number) => Promise<readonly SessionCachePurgeTarget[]>
  complete: (target: SessionCachePurgeTarget) => Promise<void>
  defer: (target: SessionCachePurgeTarget) => Promise<void>
}

export function sessionCachePurgeKeys(target: Pick<SessionCachePurgeTarget, 'credentialDigestHex' | 'legacyCredential'>): string[] {
  if (!/^[0-9a-f]{64}$/.test(target.credentialDigestHex)) return []
  const keys = [`session:v2:${target.credentialDigestHex}`]
  if (target.legacyCredential) keys.push(`session:${target.legacyCredential}`)
  return keys
}

export function sessionCachePurgeBackoffSeconds(attemptCount: number): number {
  return Math.min(2 ** Math.max(attemptCount - 1, 0), 300)
}

/**
 * Claims a bounded batch of already-revoked session cache entries. Redis
 * deletion is idempotent; the store is responsible for crash-recoverable claim
 * expiry and for accepting completion only from the matching claim generation.
 */
export async function reconcileSessionCacheInvalidations(input: {
  deleteKeys: (keys: readonly string[]) => Promise<unknown>
  limit: number
  store: SessionCachePurgeStore
}): Promise<{ completed: number; deferred: number; claimed: number }> {
  const targets = await input.store.claimDue(input.limit)
  let completed = 0
  let deferred = 0
  for (const target of targets) {
    const keys = sessionCachePurgeKeys(target)
    if (keys.length === 0) {
      await input.store.defer(target)
      deferred += 1
      continue
    }
    try {
      await input.deleteKeys(keys)
      await input.store.complete(target)
      completed += 1
    } catch {
      await input.store.defer(target)
      deferred += 1
    }
  }
  return { claimed: targets.length, completed, deferred }
}
