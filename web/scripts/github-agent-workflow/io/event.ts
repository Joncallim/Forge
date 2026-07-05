import { readFile } from 'node:fs/promises'

export async function readGitHubEvent<T = Record<string, unknown>>(env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const eventPath = env.GITHUB_EVENT_PATH?.trim()
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set.')

  const raw = await readFile(eventPath, 'utf8')
  return JSON.parse(raw) as T
}
