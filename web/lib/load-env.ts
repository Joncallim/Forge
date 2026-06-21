import path from 'node:path'
import { loadEnvConfig } from '@next/env'

/**
 * Single source of truth for environment loading across every Forge entrypoint:
 * the Next.js server runtime (via instrumentation.ts), drizzle-kit, the
 * seed scripts, the worker, and the doctor.
 *
 * Forge keeps one canonical `.env` at the repository root so the web app,
 * worker, and docker-compose all read the same values. Every Node process that
 * boots from `web/` must load that file explicitly, because:
 *
 *   - Next 16 + Turbopack runs route handlers in a separate runtime that does
 *     NOT inherit the `loadEnvConfig` side effect performed in `next.config.ts`.
 *     The reliable hook is `instrumentation.ts`, which runs inside that runtime
 *     before the first request.
 *   - drizzle-kit and tsx do not auto-load `.env` at all.
 *
 * Because the doctor, the app, and the tooling all funnel through this one
 * function, "doctor is green" can no longer diverge from "the app sees the
 * env" — they load identically.
 *
 * Convention: all Forge npm scripts run from `web/`, so the repo root is one
 * level up. Root is loaded first, then `web/` so a local `web/.env` can
 * override individual keys during development.
 */
let loaded = false

export function loadForgeEnv(): void {
  if (loaded) return
  loaded = true

  const cwd = process.cwd()
  loadEnvConfig(path.resolve(cwd, '..'))
  loadEnvConfig(cwd)
}

// Support side-effect imports: `import '@/lib/load-env'`
loadForgeEnv()
