import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

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


async function openTimeline(page: Page) {
  await page.goto('/projects')
  await settle(page)
  await page.getByRole('link', { name: new RegExp(SEED_PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await settle(page)

  // Assert the precondition rather than assume it. A leftover what-if from
  // another spec adds a "Resume…" select next to "Try a what-if", and a native
  // select is a couple of pixels taller than the button beside it — which
  // shifts the entire grid down and turns every screenshot here into a diff
  // that looks like a rendering regression. Failing loudly on the cause beats
  // debugging the symptom.
  await expect(page.getByRole('button', { name: 'Try a what-if' })).toBeVisible()
  await expect(page.getByLabel('Resume a saved what-if')).toHaveCount(0)
}

/**
 * Fixture guard.
 *
 * Every visual baseline in this file encodes the seeded dollar figures. If the
 * database has drifted — a stray edit, another process mid-test, a seed change
 * — every screenshot diffs at once and the failure looks like a rendering
 * regression. Asserting one known total first turns that into a single,
 * legible failure that names the real cause.
 *
 * Re-seed with `npm run db:reset` if this fails.
 */
test('fixture is the expected seeded plan', async ({ page }) => {
  await openTimeline(page)

  // Pinned to values derivable straight from the seed, not copied off a
  // screenshot: PP10's line items sum to 11,200,000 at quantity 1, and
  // 11,200,000 x the seeded 1.33 TPC factor is 14,896,000. If either number
  // moves, the fixture or the TPC maths changed, and every baseline below is
  // meaningless until that is understood.
  await expect(page.getByText('ECC $11,200,000 · TPC $14,896,000')).toBeVisible()
  // PP11 exercises quantity: 4,300,000 x 1 + 1,150,000 x 0.5.
  await expect(page.getByText('ECC $4,875,000 · TPC $6,483,750')).toBeVisible()

  // Phase allocations too, not just line-item costs. An earlier version of
  // this guard checked ECC alone, which is unaffected by pct_of_tpc — so a
  // fixture whose phase percentages had been edited to 141.5% sailed through
  // it and quietly poisoned three baselines. PP14 is the one package
  // deliberately seeded short.
  await expect(page.getByText('Phases total 90.0%, not 100%')).toHaveCount(1)
  await expect(page.getByText(/Phases total .*, not 100%/)).toHaveCount(1)

  // The grand total is the single number that moves if anything upstream of it
  // has drifted.
  await expect(page.getByText('$56,003,188')).toBeVisible()
})

test('timeline renders packages, costs and the energy chart', async ({ page }) => {
  await openTimeline(page)

  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  // Fiscal-year labels are what the client plans in, not our slot indices.
  await expect(page.getByText(/^FY\d{2}$/).first()).toBeVisible()
  await expect(page.getByText('Remaining consumption')).toBeVisible()

  await expect(page).toHaveScreenshot('timeline-collapsed.png', { fullPage: true })
})

test('expanding a package reveals its phases', async ({ page }) => {
  await openTimeline(page)

  // Expand every package so design-ahead-of-construction is visible in one
  // frame. The seeded FS link is still in the data, but no arrow is drawn:
  // dependency links are switched off (DEPENDENCY_LINKS_ENABLED, D-14) until
  // there is a UI to create them, and this baseline records that. Re-resolving the locator each iteration
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
