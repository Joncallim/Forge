import { expect, test } from '@playwright/test'
import {
  installSessionCookie,
  resetState,
  seedProject,
  seedSession,
} from './helpers'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'

test.describe('MCP operator presentation', () => {
  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'mcp-operator-presentation.spec.ts')
    await resetState()
  })

  test('uses the same bounded runtime vocabulary on desktop and mobile', async ({ page, context }) => {
    const session = await seedSession('MCP Presentation Operator')
    await installSessionCookie(context, session)
    const { projectId } = await seedProject({
      name: 'MCP Presentation Project',
      userId: session.userId,
    })

    await page.goto('/dashboard/mcps')
    await expect(page.getByRole('heading', { name: 'MCP tools' })).toBeVisible()
    await expect(page.getByText('Bounded context', { exact: true })).toBeVisible()
    await expect(page.getByText('External service', { exact: true })).toBeVisible()
    await expect(page.getByText('no live tool handles', { exact: false })).toHaveCount(2)
    await expect(page.locator('body')).not.toContainText('/Users/')

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: 'Project tools' }).first()).toBeVisible()
    const hasHorizontalOverflow = await page.evaluate(() => (
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    ))
    expect(hasHorizontalOverflow).toBe(false)

    await page.goto(`/dashboard/projects/${projectId}#project-mcps-heading`)
    const heading = page.getByRole('heading', { name: 'MCP tools' })
    await expect(heading).toBeVisible()
    await expect(heading).toBeFocused()
    const projectTools = page.getByRole('region', { name: 'MCP tools' })
    await expect(projectTools.getByRole('listitem')).toHaveCount(2)
    await expect(projectTools.getByText('no live tool handles', { exact: false })).toHaveCount(2)
  })
})
