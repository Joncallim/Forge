import { expect, test } from '@playwright/test'
import { installSessionCookie, resetState, seedSession } from './helpers'

test.describe('FORGE brand lifecycle', () => {
  test.beforeEach(async ({ context }) => {
    await resetState()
    await installSessionCookie(context, await seedSession())
  })

  test('renders setup motion once and keeps app-shell status branding accessible', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/dashboard/setup')

    const motion = page.locator('.forge-motion-mark')
    await expect(motion).toHaveAttribute('data-playing', 'true')
    await expect(motion.locator('.forge-motion-mark__assembly')).toBeVisible()
    await expect(motion).toHaveAttribute('data-complete', 'true', { timeout: 5_000 })
    await expect(motion.locator('.forge-motion-mark__assembly')).toHaveCount(0)

    await page.screenshot({
      path: testInfo.outputPath('forge-setup-complete.png'),
      fullPage: true,
    })

    await page.goto('/dashboard/projects')
    await page.goto('/dashboard/setup')
    await expect(motion).toHaveAttribute('data-playing', 'false')
    await expect(motion.locator('.forge-motion-mark__assembly')).toHaveCount(0)

    if (testInfo.project.name.includes('mobile')) {
      const mobileHeader = page.locator('header')
      await expect(mobileHeader.locator('.forge-wordmark')).toBeVisible()
      await page.getByRole('button', { name: 'Open navigation menu' }).click()
      const mobileNavigation = page.getByRole('dialog', { name: 'Navigation menu' })
      await expect(mobileNavigation.locator('.forge-wordmark')).toBeVisible()
      await expect(mobileNavigation.getByRole('link', { name: /^Task status:/ })).toBeVisible()
    } else {
      const sidebar = page.getByRole('complementary', { name: 'Main navigation' })
      await expect(sidebar.locator('.forge-wordmark')).toBeVisible()
      await expect(sidebar.getByRole('link', { name: /^Task status:/ })).toBeVisible()
    }
  })

  test('uses the immediate static mark for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dashboard/setup')

    const motion = page.locator('.forge-motion-mark')
    await expect(motion).toHaveAttribute('data-playing', 'false')
    await expect(motion.locator('.forge-motion-mark__assembly')).toHaveCount(0)
    await expect(motion.locator('.forge-motion-mark__static')).toBeVisible()
    await expect(motion.locator('.forge-motion-mark__name')).toBeVisible()
    await expect(motion.locator('.forge-motion-mark__static')).toHaveCSS('animation-name', 'none')
  })

  test('completes setup motion when session storage is blocked', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() {
          throw new DOMException('Storage access is blocked', 'SecurityError')
        },
      })
    })
    await page.goto('/dashboard/setup')

    const motion = page.locator('.forge-motion-mark')
    await expect(motion).toHaveAttribute('data-playing', 'true')
    await expect(motion.locator('.forge-motion-mark__assembly')).toBeVisible()
    await expect(motion).toHaveAttribute('data-complete', 'true', { timeout: 5_000 })
    await expect(motion).toHaveAttribute('data-playing', 'false')
    await expect(motion.locator('.forge-motion-mark__assembly')).toHaveCount(0)
    await expect(motion.locator('.forge-motion-mark__static')).toBeVisible()
  })

  test('uses one accessible auth heading without repeating FORGE', async ({ context, page }) => {
    await context.clearCookies()

    await page.goto('/login')
    const loginHeading = page.getByRole('heading', { level: 1, name: /FORGE.*Sign in/ })
    await expect(loginHeading).toBeVisible()
    await expect(loginHeading.getByText('FORGE', { exact: true })).toHaveCount(1)

    await page.goto('/register')
    const registerHeading = page.getByRole('heading', { level: 1, name: /FORGE.*Create account/ })
    await expect(registerHeading).toBeVisible()
    await expect(registerHeading.getByText('FORGE', { exact: true })).toHaveCount(1)
  })
})
