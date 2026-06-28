// Strict 'owner/repo' shape. Validate before values touch URLs or process args.
export const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// Redact embedded credentials from authenticated clone URLs before logging or
// returning git stderr.
const CREDENTIAL_URL_RE = /x-access-token:[^@]*@/g

export function redactToken(message: string): string {
  return message.replace(CREDENTIAL_URL_RE, 'x-access-token:***@')
}

export function buildCloneUrl(ownerRepo: string, token: string | null | undefined): string {
  if (!token) return `https://github.com/${ownerRepo}.git`
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${ownerRepo}.git`
}
