function collectErrorText(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  let depth = 0

  while (current && depth < 4 && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) parts.push(current.message)
    if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>
      for (const key of ['code', 'detail', 'schema', 'table']) {
        const value = record[key]
        if (typeof value === 'string') parts.push(value)
      }
      current = record.cause
    } else {
      current = null
    }
    depth += 1
  }

  return parts.join('\n')
}

export function taskLogsUnavailableMessage(err: unknown): string | null {
  const text = collectErrorText(err)
  if (/relation "task_logs" does not exist/i.test(text) || /\btask_logs\b/i.test(text) && /\b42P01\b/i.test(text)) {
    return 'Task logs are not available yet because the database migration has not been applied. Run `npm run db:migrate` from the web directory, then refresh this task.'
  }
  return null
}
