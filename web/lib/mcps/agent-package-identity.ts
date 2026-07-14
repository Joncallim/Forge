/**
 * Returns the package identity used when an Architect role is matched to a
 * configured Forge agent. Role separators are intentionally equivalent here:
 * `backend_dev` and `backend-dev` name the same executable package role.
 *
 * This helper does not truncate input. Policy parsers must validate their own
 * input bounds before calling it so distinct raw identities cannot collapse
 * merely because a parser discarded a suffix.
 */
export function canonicalAgentPackageIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/_/g, '-')
    .replace(/^-+|-+$/g, '')
}
