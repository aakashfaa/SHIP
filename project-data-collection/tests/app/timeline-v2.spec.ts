import { test, expect, type Page } from '@playwright/test'

/**
 * Visual and behavioural checks for the v2 Timeline.
 *
 * The fixture (supabase/seeds/002_v2_phases.sql) is shaped so that every
 * hard-to-eyeball behaviour is on screen at once: design scheduled years ahead
 * of construction, a locked-duration bar, an FS dependency with a lag, a
 * package deliberately allocated to 90% so the warning is reachable, and energy
 * savings on some disciplines but not others.
 */

const SEED_PROJECT = 'Federal Campus Master Plan'

async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  )
}

async function openTimeline(page: Page) {
  await page.goto('/projects')
  await settle(page)
  await page.getByRole('link', { name: new RegExp(SEED_PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await settle(page)
}

test('timeline renders packages, costs and the energy chart', async ({ page }) => {
  await openTimeline(page)

  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  // Fiscal-year labels are what the client plans in, not our slot indices.
  await expect(page.getByText(/^FY\d{2}$/).first()).toBeVisible()
  await expect(page.getByText('Remaining consumption')).toBeVisible()

  await expect(page).toHaveScreenshot('timeline-collapsed.png', { fullPage: true })
})

test('expanding a package reveals its phases and the dependency arrows', async ({ page }) => {
  await openTimeline(page)

  // Expand every package so design-ahead-of-construction and the links between
  // them are all visible in one frame. Re-resolving the locator each iteration
  // rather than holding an nth() handle: expanding a row inserts phase rows
  // into the DOM, which invalidates positional handles taken beforehand.
  for (const chunkNumber of ['PP10', 'PP11', 'PP12', 'PP13', 'PP14']) {
    await page.getByRole('button', { name: new RegExp(`${chunkNumber}$`) }).click()
    await expect(
      page.getByRole('button', { name: new RegExp(`▾ ${chunkNumber}$`) })
    ).toBeVisible()
  }
  await settle(page)

  await expect(page.getByText('Draft Study (Study Tasks 1-5)').first()).toBeVisible()
  await expect(page.getByText(/Construction & Close-out/).first()).toBeVisible()

  await expect(page).toHaveScreenshot('timeline-expanded.png', { fullPage: true })
})

test('an incomplete phase allocation is surfaced, not silently corrected', async ({ page }) => {
  await openTimeline(page)
  // PP14's construction phase is seeded at 80%, leaving the package at 90%.
  await expect(page.getByText(/Phases total 90\.0%, not 100%/)).toBeVisible()
})

test('a fixed-duration phase is marked and has no resize handles', async ({ page }) => {
  await openTimeline(page)
  await page.getByRole('button', { name: /^[▸▾] PP12$/ }).click()
  await settle(page)
  await expect(page.getByLabel('Fixed duration')).toBeVisible()
})

test('cost model tab exposes the assumptions behind the numbers', async ({ page }) => {
  await page.goto('/projects')
  await settle(page)
  await page.getByRole('link', { name: new RegExp(SEED_PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await page.getByRole('button', { name: 'Cost Model', exact: true }).click()
  await settle(page)

  await expect(page.getByRole('heading', { name: 'Cost Model' })).toBeVisible()
  await expect(page.getByText('What $1,000,000 becomes')).toBeVisible()

  await expect(page).toHaveScreenshot('cost-model.png', { fullPage: true })
})
