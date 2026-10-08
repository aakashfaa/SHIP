import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * Baseline capture of the v1 workspace, taken before the v2 phasing work lands.
 *
 * The point is not that these screenshots are correct — it is that they are
 * *current*. v2 rebuilds the Timeline tab and touches Packaging (was Chunking), Add Data and
 * Master View; having a committed before-image means an unintended change to a
 * tab nobody meant to touch shows up as a diff rather than as a bug report
 * three weeks later.
 *
 * The seeded fixture project is deterministic (supabase/seeds/001_seed.sql), so
 * these are stable as long as the seed is.
 */

const SEED_PROJECT = 'Federal Campus Master Plan'


async function openSeedProject(page: Page) {
  await page.goto('/projects')
  await settle(page)
  await page.getByRole('link', { name: new RegExp(SEED_PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await settle(page)
}

test('projects home lists the seeded projects', async ({ page }) => {
  await page.goto('/projects')
  await settle(page)

  await expect(page.getByRole('link', { name: new RegExp(SEED_PROJECT, 'i') })).toBeVisible()
  await expect(page).toHaveScreenshot('projects-home.png', { fullPage: true })
})

for (const tab of ['Add Data', 'Master View', 'Packaging', 'Timeline'] as const) {
  test(`workspace tab: ${tab}`, async ({ page }) => {
    await openSeedProject(page)

    await page.getByRole('button', { name: tab, exact: true }).click()
    await settle(page)
    // The tab's own content must be on screen, not just its empty frame.
    if (tab === 'Packaging') {
      await expect(page.getByRole('button', { name: 'Create Package' })).toBeVisible()
    }

    await expect(page).toHaveScreenshot(
      `tab-${tab.toLowerCase().replace(/\s+/g, '-')}.png`,
      { fullPage: true }
    )
  })
}
