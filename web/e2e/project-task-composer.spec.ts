import { expect, test } from '@playwright/test'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'
import {
  installSessionCookie,
  resetState,
  seedProject,
  seedSession,
} from './helpers'

test.describe('project task composer', () => {
  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'project-task-composer.spec.ts')
    await resetState()
  })

  test('minimizes draft on outside interaction, restores it, and submits with Control+Enter', async ({ page, context }) => {
    const session = await seedSession('Composer Operator')
    await installSessionCookie(context, session)
    const { projectId } = await seedProject({
      name: 'Composer Controls Project',
      userId: session.userId,
    })

    await page.goto(`/dashboard/projects/${projectId}`)
    await expect(page.getByRole('heading', { name: 'Composer Controls Project' })).toBeVisible()

    await page.getByRole('button', { name: 'Create new task' }).click()
    await page.mouse.click(8, 8)
    await expect(page.getByRole('button', { name: 'Restore draft task' })).toBeVisible()
    await page.getByRole('button', { name: 'Restore draft task' }).click()

    await page.getByLabel('Title').fill('Keyboard draft task')
    await page.getByLabel('Prompt').fill('Verify draft preservation and modifier submit.')

    await page.mouse.click(8, 8)

    await expect(page.getByRole('button', { name: 'Restore draft task' })).toBeVisible()
    await expect(page.getByLabel('Prompt')).toHaveCount(0)

    await page.getByRole('button', { name: 'Restore draft task' }).click()
    await expect(page.getByLabel('Title')).toHaveValue('Keyboard draft task')
    await expect(page.getByLabel('Prompt')).toHaveValue('Verify draft preservation and modifier submit.')

    await page.getByLabel('Prompt').focus()
    await page.keyboard.press('Control+Enter')

    await expect(page).toHaveURL(/\/dashboard\/tasks\/[0-9a-f-]+$/)
    await expect(page.getByRole('heading', { name: 'Keyboard draft task' })).toBeVisible()
  })
})
