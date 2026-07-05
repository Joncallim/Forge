import { pathToFileURL } from 'node:url'

export function isDirectExecution(metaUrl: string): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && pathToFileURL(entry).href === metaUrl
}

export function runMain(metaUrl: string, main: () => Promise<void> | void): void {
  if (!isDirectExecution(metaUrl)) return

  Promise.resolve(main()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
