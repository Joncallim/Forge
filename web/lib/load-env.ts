import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadEnvConfig } from '@next/env'

/**
 * Single source of truth for environment loading across every Forge entrypoint:
 * the Next.js server runtime (via instrumentation.ts), drizzle-kit, the
 * seed scripts, the worker, and the doctor.
 *
 * Forge keeps the canonical local environment file in the native workspace:
 * ~/Documents/Forge/config/forge.env. Every Node process that boots from `web/`
 * must load that file explicitly, because:
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
 * Repository `.env` files are loaded only as legacy/development fallbacks.
 */
let loaded = false

function defaultWorkspaceRoot(): string {
  return path.join(/*turbopackIgnore: true*/ os.homedir() || '/', 'Documents', 'Forge')
}

function expandHomePath(value: string): string {
  if (value === '~') return os.homedir() || '/'
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(/*turbopackIgnore: true*/ os.homedir() || '/', value.slice(2))
  }
  return value
}

function workspaceEnvPath(): string {
  if (process.env.FORGE_ENV_FILE?.trim()) {
    return path.resolve(/*turbopackIgnore: true*/ expandHomePath(process.env.FORGE_ENV_FILE))
  }

  if (process.env.FORGE_WORKSPACE_ROOT?.trim()) {
    return path.join(
      /*turbopackIgnore: true*/ path.resolve(
        /*turbopackIgnore: true*/ expandHomePath(process.env.FORGE_WORKSPACE_ROOT),
      ),
      'config',
      'forge.env',
    )
  }

  const defaultRoot = defaultWorkspaceRoot()
  const defaultSettingsPath = path.join(defaultRoot, 'global-settings.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(defaultSettingsPath, 'utf-8')) as {
      forgeEnvPath?: unknown
      workspaceRoot?: unknown
    }
    if (typeof parsed.forgeEnvPath === 'string' && parsed.forgeEnvPath.trim()) {
      return path.resolve(/*turbopackIgnore: true*/ expandHomePath(parsed.forgeEnvPath))
    }
    if (typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot.trim()) {
      return path.join(
        /*turbopackIgnore: true*/ path.resolve(
          /*turbopackIgnore: true*/ expandHomePath(parsed.workspaceRoot),
        ),
        'config',
        'forge.env',
      )
    }
  } catch {
    // Fall back to the default workspace path.
  }

  return path.join(/*turbopackIgnore: true*/ defaultRoot, 'config', 'forge.env')
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const equalsIndex = trimmed.indexOf('=')
  if (equalsIndex <= 0) return null
  const key = trimmed.slice(0, equalsIndex).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
  let value = trimmed.slice(equalsIndex + 1).trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return [key, value]
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  const raw = fs.readFileSync(filePath, 'utf-8')
  for (const line of raw.split('\n')) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    const [key, value] = parsed
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

export function loadForgeEnv(): void {
  if (loaded) return
  loaded = true

  const cwd = process.cwd()
  loadEnvFile(workspaceEnvPath())
  loadEnvConfig(path.resolve(/*turbopackIgnore: true*/ cwd, '..'))
  loadEnvConfig(cwd)
}

// Support side-effect imports: `import '@/lib/load-env'`
loadForgeEnv()
