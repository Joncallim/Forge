import { expect, test } from '@playwright/test'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'
import {
  installSessionCookie,
  resetState,
  seedProjectTask,
  seedRequiredFilesystemPackage,
  seedSession,
} from './helpers'

test.describe('Epic 172 manifest-bound operator recovery', () => {
  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'mcp-operator-recovery.spec.ts')
    await resetState()
  })

  test('mcp-admission.operator-recovery: presents authenticated filesystem recovery controls', {
    tag: '@mcp-operator',
    annotation: { type: 'scenarioId', description: 'mcp-admission.operator-recovery' },
  }, async ({ context, page }) => {
    const session = await seedSession('MCP Recovery Operator')
    await installSessionCookie(context, session)
    const { taskId } = await seedProjectTask({
      status: 'approved',
      title: 'MCP recovery task',
      userId: session.userId,
    })
    await seedRequiredFilesystemPackage({ taskId, title: 'Recovery package' })

    await page.goto(`/dashboard/tasks/${taskId}`)

    const recovery = page.getByRole('region', { name: 'Filesystem access approval' })
    await expect(recovery).toBeVisible()
    await expect(recovery.getByText('Recovery package')).toBeVisible()
    await expect(recovery.getByText('filesystem.project.read')).toBeVisible()
    await expect(recovery.getByRole('button', { name: 'Allow once' })).toBeEnabled()
    await expect(recovery.getByRole('button', { name: 'Always allow' })).toBeEnabled()
    const deny = recovery.getByRole('button', { name: 'Deny' })
    await expect(deny).toBeEnabled()
    await deny.focus()
    await expect(deny).toBeFocused()

    const mutationResponse = page.waitForResponse((response) => (
      response.request().method() === 'PUT'
      && response.url().endsWith(`/api/tasks/${taskId}/filesystem-grants`)
    ))
    await deny.click()
    const response = await mutationResponse
    expect(response.status()).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: 'epic_172_project_management_ingress_closed',
    })
    await expect(recovery.getByRole('alert')).toHaveText(
      'Project management is temporarily disabled while release safety checks are incomplete.',
    )
    await expect(page.locator('body')).not.toContainText('/Users/')
  })
})
