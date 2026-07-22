import { defineConfig, devices } from '@playwright/test'
import { resolveDestructiveE2EEnvironment } from './e2e/destructive-environment'
import { EPIC_172_STEP0_E2E_BRIDGE_ENV } from './e2e/epic-172-step0-bridge'

const inheritedEnvironment = { ...process.env }
const epic172Step0E2EBridge = inheritedEnvironment[EPIC_172_STEP0_E2E_BRIDGE_ENV]
delete process.env.DATABASE_URL
delete process.env.REDIS_URL
delete process.env[EPIC_172_STEP0_E2E_BRIDGE_ENV]
delete inheritedEnvironment[EPIC_172_STEP0_E2E_BRIDGE_ENV]

const hasE2EEnvironment = Boolean(
  inheritedEnvironment.FORGE_E2E_ALLOW_DESTRUCTIVE_RESET ||
  inheritedEnvironment.FORGE_E2E_DATABASE_URL ||
  inheritedEnvironment.FORGE_E2E_REDIS_URL,
)
const e2eEnvironment = hasE2EEnvironment
  ? resolveDestructiveE2EEnvironment(inheritedEnvironment)
  : null
if (e2eEnvironment) {
  process.env.DATABASE_URL = e2eEnvironment.databaseUrl
  process.env.REDIS_URL = e2eEnvironment.redisUrl
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  testDir: './e2e',
  // Keep the temporary Step 0 test disposition in Playwright configuration.
  // It is deliberately removed from process.env before Playwright starts the
  // Forge web server, so application code cannot turn it into a runtime bypass.
  metadata: {
    [EPIC_172_STEP0_E2E_BRIDGE_ENV]: epic172Step0E2EBridge,
  },
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  // Tests share one PostgreSQL/Redis instance. Some fixtures update shared
  // settings and queues even though retained records use random identities, so
  // force sequential execution across all files and projects.
  workers: 1,
  // Absorb environmental E2E flake in CI (slow Postgres/Redis under load).
  retries: process.env.CI ? 2 : 0,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1',
    url: baseURL,
    // Reusing an arbitrary local dev server can bypass the E2E env below
    // (notably FORGE_EMBED_WORKER=0) and make the suite nondeterministic.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === '1',
    timeout: 120_000,
    env: {
      DATABASE_URL: e2eEnvironment?.databaseUrl ?? '',
      REDIS_URL: e2eEnvironment?.redisUrl ?? '',
      SESSION_SECRET: process.env.SESSION_SECRET ?? '',
      WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID ?? 'localhost',
      WEBAUTHN_RP_NAME: process.env.WEBAUTHN_RP_NAME ?? 'Forge',
      WEBAUTHN_ORIGIN: process.env.WEBAUTHN_ORIGIN ?? baseURL,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? baseURL,
      FORGE_EMBED_WORKER: '0',
    },
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
})
