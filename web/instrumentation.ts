/**
 * Next.js instrumentation hook. `register()` runs once when a server instance
 * starts and must complete before the server handles requests.
 *
 * We use it to load Forge's canonical repo-root `.env` into the Node server
 * runtime. Under Turbopack, route handlers execute in a runtime that does not
 * inherit the env loaded in `next.config.ts`, so without this the app would
 * see `DATABASE_URL` (and friends) as undefined even though the file exists.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return

  await import('./lib/load-env')

  const building = process.env.npm_lifecycle_event === 'build'
  if (building || process.env.FORGE_EMBED_WORKER === '0') return

  const { startWorker } = await import('./worker/runtime')
  await startWorker('embedded')
}
