import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * The what-if sandbox — Megan's Revit local-copy model.
 *
 * The property under test is the one that matters commercially: a what-if
 * explored live in front of a client must not reach the live plan until
 * somebody deliberately publishes it. A failure here is not a cosmetic bug, it
 * is the tool silently rewriting a capital plan during a meeting.
 */

const SEED_PROJECT = 'Federal Campus Master Plan'

/**
 * Serial, and each test cleans up after itself.
 *
 * These tests mutate shared database state: a scenario created by one is
 * visible to the next, which changes the "Resume… (N)" control and makes the
 * banner screenshot non-deterministic. Running them in parallel against one
 * database produced a diff that looked like a rendering regression and was
 * really a fixture-leak. Serial + cleanup is the honest fix; isolating the
 * database per worker would be the other one, and is not worth it for three
 * tests.
 */
test.describe.configure({ mode: 'serial' })

/** Leaves the project with no open what-ifs, whatever the test did. */
async function discardAllScenarios(page: Page) {
  await page.goto(`/projects/federal-campus-master-plan?tab=timeline`)
  await settle(page)

  // Exit any active branch first — Discard only exists inside one.
  const backToLive = page.getByRole('button', { name: 'Back to live plan' })
  if (await backToLive.count()) await backToLive.click()

  const resume = page.getByLabel('Resume a saved what-if')
  while (await resume.count()) {
    const values = await resume.locator('option').evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter(Boolean)
    )
    if (values.length === 0) break
    await resume.selectOption(values[0])
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByText('Local copy')).toBeHidden()
  }
}


async function openTimeline(page: Page) {
  await page.goto('/projects')
  await settle(page)
  await page.getByRole('link', { name: new RegExp(SEED_PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await settle(page)
}

/** The escalated grand total is the cheapest honest proxy for "did the plan
 *  change" — every phase move re-prices it.
 *
 * Waits for a non-zero figure first. The card renders immediately with $0.00
 * and fills in once the six async loads resolve, so reading it on
 * `networkidle` alone captures the placeholder and every comparison against it
 * passes or fails for the wrong reason. */
async function grandTotal(page: Page): Promise<string> {
  // Wait for the project's own cost settings to land before reading anything.
  //
  // The Timeline renders as soon as phases arrive, and until the cost-settings
  // query resolves it prices them with DEFAULT_COST_SETTINGS — a flat 4% with
  // no per-year overrides. That produces a real, non-zero, WRONG total for a
  // few hundred milliseconds. Waiting on "not $0.00" caught that intermediate
  // value and made this test compare two different escalation models.
  //
  // "2 years overridden" only appears once the seeded rate overrides are in
  // hand, so it is a precise signal that the numbers below have settled.
  await expect(page.getByText('2 years overridden')).toBeVisible({ timeout: 20_000 })

  const card = page.locator('text=Total (escalated)').locator('..')
  await expect(card).not.toContainText('$0.00', { timeout: 20_000 })
  return (await card.innerText()).trim()
}

test.afterEach(async ({ page }) => {
  await discardAllScenarios(page)
})

test('entering a what-if shows an unmissable banner', async ({ page }) => {
  await openTimeline(page)

  await page.getByRole('button', { name: 'Try a what-if' }).click()
  await page.getByLabel('Name this what-if').fill('What if we defer the east wing')
  await page.getByRole('button', { name: 'Start', exact: true }).click()

  await expect(page.getByText('Local copy')).toBeVisible()
  await expect(page.getByText('What if we defer the east wing')).toBeVisible()
  await expect(
    page.getByText('Changes stay here until you publish. The live plan is untouched.')
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish to live plan' })).toBeVisible()

  await settle(page)
  await expect(page).toHaveScreenshot('sandbox-active.png', { fullPage: true })
})

test('discarding a what-if leaves the live plan untouched', async ({ page }) => {
  await openTimeline(page)
  const before = await grandTotal(page)

  await page.getByRole('button', { name: 'Try a what-if' }).click()
  await page.getByLabel('Name this what-if').fill('Throwaway')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Local copy')).toBeVisible()

  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('Local copy')).toBeHidden()

  // Reload rather than trusting client state: the assertion is about what is
  // in the database, not what React is holding. The tab now lives in the URL,
  // so a reload lands back on the Timeline rather than on Add Data.
  await page.reload()
  await settle(page)
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  expect(await grandTotal(page)).toBe(before)
})

test('leaving a what-if returns to the live plan', async ({ page }) => {
  await openTimeline(page)
  const before = await grandTotal(page)

  await page.getByRole('button', { name: 'Try a what-if' }).click()
  await page.getByLabel('Name this what-if').fill('Resumable')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: 'Back to live plan' }).click()

  await expect(page.getByText('Local copy')).toBeHidden()
  expect(await grandTotal(page)).toBe(before)

  // And it is resumable rather than lost.
  await expect(page.getByLabel('Resume a saved what-if')).toBeVisible()
})
