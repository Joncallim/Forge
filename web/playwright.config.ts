import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'
const trustedHostBoundary = process.env.FORGE_TRUSTED_HOST_BOUNDARY === '1'
const dedicatedMcpTags = /@mcp-postgres|@mcp-issuance|@mcp-operator|@mcp-host-boundary/

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
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
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      REDIS_URL: process.env.REDIS_URL ?? '',
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
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mcp-issuance',
      grep: /@mcp-issuance/,
      fullyParallel: false,
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mcp-operator-desktop',
      grep: /@mcp-operator/,
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mcp-operator-mobile',
      grep: /@mcp-operator/,
      retries: 0,
      use: { ...devices['Pixel 5'] },
    },
    ...(trustedHostBoundary ? [{
      name: 'mcp-host-boundary',
      testMatch: /mcp-host-boundary\.spec\.ts/,
      grep: /@mcp-host-boundary/,
      fullyParallel: false,
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    }] : []),
  ],
})
