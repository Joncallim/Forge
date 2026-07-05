import { expect, test } from '@playwright/test'
import {
  installSessionCookie,
  resetState,
  seedProjectTask,
  seedRequiredFilesystemPackage,
  seedSession,
} from './helpers'

test.describe('task detail operator controls', () => {
  test.beforeEach(async () => {
    await resetState()
  })

  test('stops an active task before allowing hard delete', async ({ page, context }) => {
    const session = await seedSession('Task Control Operator')
    await installSessionCookie(context, session)
    const { taskId } = await seedProjectTask({
      status: 'running',
      title: 'Running operator control task',
      userId: session.userId,
    })

    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`/dashboard/tasks/${taskId}`)

    await expect(page.getByRole('heading', { name: 'Running operator control task' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible()

    await page.getByRole('button', { name: 'Delete' }).click()
    await expect(page).toHaveURL(/\/dashboard\/tasks$/)
  })

  test('shows retry submitted feedback while collapsing the retry form', async ({ page, context }) => {
    const session = await seedSession('Retry Operator')
    await installSessionCookie(context, session)
    const { taskId } = await seedProjectTask({
      status: 'failed',
      title: 'Failed retry control task',
      userId: session.userId,
    })

    await page.goto(`/dashboard/tasks/${taskId}`)

    const retryForm = page.getByRole('form', { name: 'Retry task' })
    await expect(retryForm).toBeVisible()
    await page.getByRole('button', { name: 'Retry task' }).click()

    await expect(page.getByText('Retry submitted. Forge is waiting for a worker to pick up the task.')).toBeVisible()
    await expect(retryForm).toBeHidden()
  })

  test('warns before saving project-wide filesystem approval', async ({ page, context }) => {
    const session = await seedSession('Filesystem Grant Operator')
    await installSessionCookie(context, session)
    const { taskId } = await seedProjectTask({
      status: 'awaiting_approval',
      title: 'Filesystem approval control task',
      userId: session.userId,
    })
    await seedRequiredFilesystemPackage({ taskId })

    await page.goto(`/dashboard/tasks/${taskId}`)

    await expect(page.getByText('Filesystem grants required')).toBeVisible()
    await expect(page.getByText('missing grant')).toBeVisible()
    await expect(page.getByText('future packages with the same or narrower filesystem needs').first()).toBeVisible()
    await expect(page.getByText('bounded read-only context packet').first()).toBeVisible()
    await expect(page.getByText('does not issue live filesystem tools or write access').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Allow once' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Always allow' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })
})
