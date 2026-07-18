import { defineConfig, devices } from '@playwright/test'
import { resolveDestructiveE2EEnvironment } from './e2e/destructive-environment'
import { EPIC_172_STEP0_E2E_BRIDGE_ENV } from './e2e/epic-172-step0-bridge'

const trustedHostBoundary = process.env.FORGE_TRUSTED_HOST_BOUNDARY === '1'
const dedicatedMcpTags = /@mcp-postgres|@mcp-issuance|@mcp-operator|@mcp-host-boundary/
const noMcpArtifacts = Object.freeze({ trace: 'off', screenshot: 'off', video: 'off' } as const)

const inheritedEnvironment = { ...process.env }
const epic172Step0E2EBridge = inheritedEnvironment[EPIC_172_STEP0_E2E_BRIDGE_ENV]
delete process.env.DATABASE_URL
delete process.env.REDIS_URL
delete process.env[EPIC_172_STEP0_E2E_BRIDGE_ENV]
delete inheritedEnvironment[EPIC_172_STEP0_E2E_BRIDGE_ENV]

const hasE2EEnvironment = Boolean(
  inheritedEnvironment.FORGE_E2E_ALLOW_DESTRUCTIVE_RESET
  || inheritedEnvironment.FORGE_E2E_DATABASE_URL
  || inheritedEnvironment.FORGE_E2E_REDIS_URL,
)
const e2eEnvironment = !trustedHostBoundary && hasE2EEnvironment
  ? resolveDestructiveE2EEnvironment(inheritedEnvironment)
  : null
if (e2eEnvironment) {
  process.env.DATABASE_URL = e2eEnvironment.databaseUrl
  process.env.REDIS_URL = e2eEnvironment.redisUrl
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  testDir: './e2e',
  globalTeardown: trustedHostBoundary ? undefined : './e2e/global-teardown.ts',
  timeout: 60_000,
  // Tests share one dev Postgres/Redis instance and each does a global
  // truncate in beforeEach, so concurrent workers race on each other's data.
  // Force fully sequential execution across all files and projects.
  workers: 1,
  // Absorb environmental E2E flake in CI (slow Postgres/Redis under load).
  retries: process.env.CI ? 2 : 0,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: trustedHostBoundary ? {
    baseURL,
    ...noMcpArtifacts,
  } : {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: trustedHostBoundary ? undefined : {
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
  metadata: {
    [EPIC_172_STEP0_E2E_BRIDGE_ENV]: epic172Step0E2EBridge,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: dedicatedMcpTags,
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'] },
      grepInvert: dedicatedMcpTags,
    },
    {
      name: 'mcp-postgres',
      grep: /@mcp-postgres/,
      fullyParallel: false,
      retries: 0,
      use: { ...devices['Desktop Chrome'], ...noMcpArtifacts },
    },
    {
      name: 'mcp-issuance',
      grep: /@mcp-issuance/,
      fullyParallel: false,
      retries: 0,
      use: { ...devices['Desktop Chrome'], ...noMcpArtifacts },
    },
    {
      name: 'mcp-operator-desktop',
      grep: /@mcp-operator/,
      retries: 0,
      use: { ...devices['Desktop Chrome'], ...noMcpArtifacts },
    },
    {
      name: 'mcp-operator-mobile',
      grep: /@mcp-operator/,
      retries: 0,
      use: { ...devices['Pixel 5'], ...noMcpArtifacts },
    },
    ...(trustedHostBoundary ? [{
      name: 'mcp-host-boundary',
      testMatch: /mcp-host-boundary\.spec\.ts/,
      grep: /@mcp-host-boundary/,
      fullyParallel: false,
      retries: 0,
      use: { ...devices['Desktop Chrome'], ...noMcpArtifacts },
    }] : []),
  ],
})
