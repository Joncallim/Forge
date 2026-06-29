const DISPLAY_NAME_EXCEPTIONS: Record<string, string> = {
  api: 'API',
  devops: 'DevOps',
  mcp: 'MCP',
  qa: 'QA',
}

export function normalizeDisplayNameForUniqueness(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function slugifyDisplayName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function uniqueSlug(baseSlug: string, existingSlugs: Iterable<string>, fallback: string): string {
  const taken = new Set([...existingSlugs].map((slug) => slug.toLowerCase()))
  const normalizedBase = (baseSlug || fallback).slice(0, 64).replace(/[-_]+$/g, '') || fallback
  if (!taken.has(normalizedBase)) return normalizedBase

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const marker = `-${suffix}`
    const candidate = `${normalizedBase.slice(0, 64 - marker.length).replace(/[-_]+$/g, '')}${marker}`
    if (!taken.has(candidate)) return candidate
  }

  throw new Error('Could not generate a unique slug.')
}

export function displayNameForSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => DISPLAY_NAME_EXCEPTIONS[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
