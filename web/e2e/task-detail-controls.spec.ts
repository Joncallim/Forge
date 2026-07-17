import { expect, test } from '@playwright/test'
import crypto from 'node:crypto'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'
import {
  installSessionCookie,
  resetState,
  seedProjectTask,
  seedRequiredFilesystemPackage,
  seedSession,
} from './helpers'

type BrowserGrantState = {
  currentDecision: null | {
    capabilities: string[]
    decision: 'approved' | 'denied'
    grantDecisionRevision: string
    id: string
    reason: string
  }
  pointerFingerprint: string | null
  pointerVersion: string
  workPackageId: string
}

function browserGrantState(
  workPackageId: string,
  decision?: {
    fingerprint: string
    id: string
    revision: string
    version: string
  },
): BrowserGrantState {
  return {
    currentDecision: decision ? {
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      decision: 'approved',
      grantDecisionRevision: decision.revision,
      id: decision.id,
      reason: `Reviewed ${decision.revision}`,
    } : null,
    pointerFingerprint: decision?.fingerprint ?? null,
    pointerVersion: decision?.version ?? '0',
    workPackageId,
  }
}

test.describe('task detail operator controls', () => {
  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'task-detail-controls.spec.ts')
    await resetState()
  })

  test('stops an active task while retaining its execution history', async ({ page, context }) => {
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
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/dashboard/tasks/${taskId}$`))
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

  test('loads the package pointer and carries D1 into an explicit D2 reapproval', async ({ page, context }) => {
    const session = await seedSession('Filesystem Reapproval Operator')
    await installSessionCookie(context, session)
    const { taskId } = await seedProjectTask({
      status: 'awaiting_approval',
      title: 'Filesystem D1 to D2 control task',
      userId: session.userId,
    })
    const { packageId } = await seedRequiredFilesystemPackage({ taskId })
    const d1 = {
      fingerprint: 'sha256:d1-browser-pointer',
      id: crypto.randomUUID(),
      revision: '1',
      version: '1',
    }
    const d2 = {
      fingerprint: 'sha256:d2-browser-pointer',
      id: crypto.randomUUID(),
      revision: '2',
      version: '2',
    }
    let currentState = browserGrantState(packageId)
    const mutations: Array<Record<string, unknown>> = []

    await page.route(`**/api/tasks/${taskId}/filesystem-grants`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { schemaVersion: 2, grants: [currentState] } })
        return
      }
      const body = route.request().postDataJSON() as { grants: Array<Record<string, unknown>> }
      mutations.push(body.grants[0])
      currentState = browserGrantState(packageId, mutations.length === 1 ? d1 : d2)
      await route.fulfill({ json: { schemaVersion: 2, grants: [currentState], recoveredTaskIds: [] } })
    })

    await page.goto(`/dashboard/tasks/${taskId}`)
    const grantPanel = page.getByText('Filesystem grants required').locator('..')
    const allowOnce = grantPanel.getByRole('button', { name: 'Allow once' })
    await expect(allowOnce).toBeEnabled()

    await allowOnce.click()
    await expect.poll(() => mutations.length).toBe(1)
    expect(mutations[0]).not.toHaveProperty('expectedPointer')
    await expect(grantPanel.getByText(new RegExp(`Current decision ${d1.id}`))).toBeVisible()

    await allowOnce.click()
    await expect.poll(() => mutations.length).toBe(2)
    expect(mutations[1]).toMatchObject({
      expectedPointer: {
        currentDecisionId: d1.id,
        currentDecisionRevision: d1.revision,
        pointerFingerprint: d1.fingerprint,
        pointerVersion: d1.version,
      },
    })
    await expect(grantPanel.getByText(new RegExp(`Current decision ${d2.id}`))).toBeVisible()
  })

  test('refreshes a stale pointer and waits for a second explicit confirmation', async ({ page, context }) => {
    const session = await seedSession('Filesystem Stale Reapproval Operator')
    await installSessionCookie(context, session)
    const { taskId } = await seedProjectTask({
      status: 'awaiting_approval',
      title: 'Filesystem stale reapproval control task',
      userId: session.userId,
    })
    const { packageId } = await seedRequiredFilesystemPackage({ taskId })
    const d1 = {
      fingerprint: 'sha256:d1-stale-browser-pointer',
      id: crypto.randomUUID(),
      revision: '10',
      version: '1',
    }
    const d2 = {
      fingerprint: 'sha256:d2-stale-browser-pointer',
      id: crypto.randomUUID(),
      revision: '11',
      version: '2',
    }
    const d3 = {
      fingerprint: 'sha256:d3-stale-browser-pointer',
      id: crypto.randomUUID(),
      revision: '12',
      version: '3',
    }
    let currentState = browserGrantState(packageId, d1)
    const mutations: Array<Record<string, unknown>> = []

    await page.route(`**/api/tasks/${taskId}/filesystem-grants`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { schemaVersion: 2, grants: [currentState] } })
        return
      }
      const body = route.request().postDataJSON() as { grants: Array<Record<string, unknown>> }
      mutations.push(body.grants[0])
      if (mutations.length === 1) {
        currentState = browserGrantState(packageId, d2)
        await route.fulfill({
          json: { error: 'Filesystem decision changed. Review the current decision and submit explicit intent against its pointer.' },
          status: 409,
        })
        return
      }
      currentState = browserGrantState(packageId, d3)
      await route.fulfill({ json: { schemaVersion: 2, grants: [currentState], recoveredTaskIds: [] } })
    })

    await page.goto(`/dashboard/tasks/${taskId}`)
    const grantPanel = page.getByText('Filesystem grants required').locator('..')
    await expect(grantPanel.getByText(new RegExp(`Current decision ${d1.id}`))).toBeVisible()

    await grantPanel.getByRole('button', { name: 'Allow once' }).click()
    await expect(grantPanel.getByRole('alert')).toContainText('changed while you were reviewing it')
    await expect(grantPanel.getByText(new RegExp(`Current decision ${d2.id}`))).toBeVisible()
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      expectedPointer: {
        currentDecisionId: d1.id,
        currentDecisionRevision: d1.revision,
        pointerFingerprint: d1.fingerprint,
        pointerVersion: d1.version,
      },
    })

    await grantPanel.getByRole('button', { name: 'Confirm allow once' }).click()
    await expect.poll(() => mutations.length).toBe(2)
    expect(mutations[1]).toMatchObject({
      expectedPointer: {
        currentDecisionId: d2.id,
        currentDecisionRevision: d2.revision,
        pointerFingerprint: d2.fingerprint,
        pointerVersion: d2.version,
      },
    })
    await expect(grantPanel.getByText(new RegExp(`Current decision ${d3.id}`))).toBeVisible()
  })
})
