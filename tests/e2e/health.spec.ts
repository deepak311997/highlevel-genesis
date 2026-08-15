import { expect, test } from '@playwright/test'

test.describe('Slice 0 — rails', () => {
  test('the health page reports a successful Firestore round trip', async ({ page }) => {
    await page.goto('/health')

    const ok = page.getByTestId('health-ok')
    await expect(ok).toBeVisible({ timeout: 15_000 })
    await expect(ok).toContainText('ok')
    await expect(ok).toContainText('Round trip')
  })

  test('the home page links into the health check', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('link', { name: 'Run the health check' }).click()
    await expect(page).toHaveURL(/\/health$/)
  })
})
