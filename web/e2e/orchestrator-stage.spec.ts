import { expect, test } from '@playwright/test'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'
import {
  installSessionCookie,
  resetState,
  seedProject,
  seedSession,
  startMockWorker,
  stopWorker,
} from './helpers'

test.describe('Orchestrator-stage beta smoke', () => {
  let worker: ChildProcessWithoutNullStreams | null = null
  let session: Awaited<ReturnType<typeof seedSession>>

  test.beforeEach(async ({ context }, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'orchestrator-stage.spec.ts')
    await resetState()
    session = await seedSession()
    await installSessionCookie(context, session)
    worker = await startMockWorker(testInfo)
  })

  test.afterEach(async ({}, testInfo) => {
    await stopWorker(worker, testInfo)
    worker = null
  })

  test('setup, task execution, artifact review, and approval handoff', async ({ page }, testInfo) => {
    await page.goto('/dashboard')

    await expect(page).toHaveURL(/\/dashboard\/setup$/)
    await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('01-setup.png'),
      fullPage: true,
    })

    await page.getByLabel('Apply Best Value preset').click()
    // Wait explicitly for the navigation to settle before asserting on the URL,
    // so a slow applyPreset server action does not race the route change.
    await page.waitForURL(/\/dashboard\/providers$/)
    await expect(page).toHaveURL(/\/dashboard\/providers$/)
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(page.getByText('anthropic / claude-sonnet-4-6')).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('02-providers.png'),
      fullPage: true,
    })

    await page.goto('/dashboard/projects')
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
    await seedProject({ name: 'Forge Smoke', userId: session.userId, githubRepo: 'owner/forge-smoke' })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Open project Forge Smoke' })).toBeVisible()

    await page.getByRole('button', { name: 'Open project Forge Smoke' }).click()
    await expect(page.getByRole('heading', { name: 'Forge Smoke' })).toBeVisible()
    await page.getByRole('button', { name: 'Create new task' }).click()
    await page.getByLabel('Title').fill('Draft smoke plan')
    await page.getByLabel('Prompt').fill('Create a short implementation plan for the smoke test.')
    await page.getByRole('button', { name: 'Create Task' }).click()

    await expect(page).toHaveURL(/\/dashboard\/tasks\/[0-9a-f-]+$/)
    await expect(page.getByRole('heading', { name: 'Draft smoke plan' })).toBeVisible()
    await expect(page.getByText('Needs approval', { exact: true })).toBeVisible()
    await expect(page.getByText('Mock architect plan for Draft smoke plan')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve generated plan' })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('03-task-awaiting-approval.png'),
      fullPage: true,
    })

    await page.getByRole('button', { name: 'Approve generated plan' }).click()
    // Scope to the header status badge because agent-run and package sections
    // can also render their own status badges.
    const taskStatusBadge = page
      .getByRole('heading', { name: 'Draft smoke plan' })
      .locator('xpath=following-sibling::*[1]')
    await expect(taskStatusBadge).toHaveText('Running')
    await expect(page.getByText('Mock architect plan for Draft smoke plan')).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('04-task-handoff.png'),
      fullPage: true,
    })
  })
})
