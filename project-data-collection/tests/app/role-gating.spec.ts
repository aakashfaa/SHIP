import { test, expect, type Page } from '@playwright/test'

/**
 * The per-project role gates, exercised as each role rather than asserted
 * against a mock.
 *
 * These sign in fresh instead of reusing the admin `storageState`, because the
 * whole point is that the SAME page renders differently for different people.
 * A test that could not tell an admin from a viewer would not be testing the
 * feature.
 *
 * What is deliberately NOT asserted here: that the database refuses the writes.
 * It does — migration 0011 and the RLS policies in 0009 are the boundary, and
 * they are verified by impersonation in SQL. These tests cover the other half,
 * which is that we never offer someone a control that is going to be refused.
 */

const PROJECT = 'Federal Campus Master Plan'
const PASSWORD = 'localdev123'

async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  )
}

async function signInAs(page: Page, email: string) {
  await page.goto('/')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/projects', { timeout: 30_000 })
  await settle(page)
}

async function openTimelineAs(page: Page, email: string) {
  await signInAs(page, email)
  await page.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await settle(page)
}

// Every role signs in for itself; the stored admin session would defeat the test.
test.use({ storageState: { cookies: [], origins: [] } })

test('a viewer gets a read-only plan and an ephemeral sandbox', async ({ page }) => {
  await openTimelineAs(page, 'electrical@voltworks.com')

  await expect(page.getByText('Read-only Workspace')).toBeVisible()
  await expect(page.getByText(/Exploring — nothing is saved/i)).toBeVisible()

  // R8.4: no deliverables for a viewer.
  await expect(page.getByRole('button', { name: /Export Excel/i })).toHaveCount(0)

  // They cannot start a persisted what-if — that is migration 0011's rule,
  // surfaced here as an absent control rather than a failed one.
  await expect(page.getByRole('button', { name: /Try a what-if/i })).toHaveCount(0)

  // The schedule itself is still fully legible. Read-only is not blank.
  await expect(page.getByText(/Infrastructure Stabilization/).first()).toBeVisible()

  await expect(page).toHaveScreenshot('viewer-timeline.png', { fullPage: true })
})

test('a viewer cannot reach Add Data at all', async ({ page }) => {
  await openTimelineAs(page, 'electrical@voltworks.com')
  await expect(page.getByRole('button', { name: 'Add Data', exact: true })).toHaveCount(0)
})

test('a consultant may branch a what-if but not publish the plan', async ({ page }) => {
  await openTimelineAs(page, 'consultant1@gmail.com')

  await expect(page.getByText('Consultant Workspace')).toBeVisible()
  // Branching is theirs — modelling an idea privately is what they are here for.
  await expect(page.getByRole('button', { name: /Try a what-if/i })).toBeVisible()
  // Editing the live schedule is not.
  await expect(page.getByText(/Read-only\. Ask an editor/i)).toBeVisible()
})

test('an editor gets the plan and the deliverables', async ({ page }) => {
  await openTimelineAs(page, 'planning@atlasmech.com')

  await expect(page.getByText('Editor Workspace')).toBeVisible()
  await expect(page.getByRole('button', { name: /Export Excel/i })).toBeVisible()
  await expect(page.getByText(/Read-only\. Ask an editor/i)).toHaveCount(0)
})

test('an admin can edit the project vocabularies', async ({ page }) => {
  await signInAs(page, 'admin@gmail.com')
  await page.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)

  // Settle BEFORE reaching for the tab. The tab list is narrow until the role
  // RPC resolves -- Settings is admin-only, so it does not exist yet -- and
  // clicking into that window is a race, not a failure of the feature.
  await settle(page)

  // 'Settings', not the 'S' glyph the button displays: the accessible name
  // comes from its aria-label. Selecting by the visible character would pass
  // only by accident and would break the moment the icon changed.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settle(page)

  await expect(page.getByRole('heading', { name: /Line item vocabularies/i })).toBeVisible()

  // 'ANNEX' is here because seeds/003 backfills the values line items already
  // carry, not just the generic defaults. Without that, every existing item
  // would fail the taxonomy trigger on its next save.
  await expect(page.getByText('ANNEX', { exact: true })).toBeVisible()

  // One value is seeded archived so the restore path has a subject.
  await expect(page.getByRole('button', { name: /1 archived/i })).toBeVisible()

  await expect(page).toHaveScreenshot('taxonomy-editor.png', { fullPage: true })
})
