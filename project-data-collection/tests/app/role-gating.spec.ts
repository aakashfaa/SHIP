import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

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

/**
 * The "<View> · <Role>" line under the project name in the top bar. This is
 * where the shell names the caller's role (it replaced the old "Read-only /
 * Consultant / Editor Workspace" titles), so it is what tells a viewer apart
 * from an editor on the same page.
 */
function roleLine(page: Page) {
  return page.locator('[data-workspace-topbar] p').first()
}

// Every role signs in for itself; the stored admin session would defeat the test.
test.use({ storageState: { cookies: [], origins: [] } })

test('a viewer gets a read-only plan and an ephemeral sandbox', async ({ page }) => {
  await openTimelineAs(page, 'electrical@voltworks.com')

  await expect(roleLine(page)).toHaveText('Timeline · Client')
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

  await expect(roleLine(page)).toHaveText(/^Timeline · Consultant( · .+)?$/)
  // Branching is theirs — modelling an idea privately is what they are here for.
  await expect(page.getByRole('button', { name: /Try a what-if/i })).toBeVisible()
  // Editing the live schedule is not.
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible()
})

test('an editor gets the plan and the deliverables', async ({ page }) => {
  await openTimelineAs(page, 'planning@atlasmech.com')

  await expect(roleLine(page)).toHaveText('Timeline · Editor')
  await expect(page.getByRole('button', { name: /Export Excel/i })).toBeVisible()
  await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0)
})

test('an admin can edit the line item form', async ({ page }) => {
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

  await expect(page.getByRole('heading', { name: 'Consultant input form', exact: true })).toBeVisible()

  // A built-in field, a custom one, and a field the fixture hides. The three
  // together are the whole model: built-ins are structural, custom fields are
  // the point of the feature, and hiding is what you do instead of deleting a
  // built-in. If any one of them stops rendering, the builder is broken in a
  // way a screenshot diff alone would not explain.
  await expect(page.getByText('Estimated first cost', { exact: true })).toBeVisible()
  await expect(page.getByText('Funding source', { exact: true })).toBeVisible()
  await expect(page.getByText('Electrification', { exact: true })).toBeVisible()

  await expect(page).toHaveScreenshot('form-builder.png', { fullPage: true })
})

test('default fields offer no remove, every other field does', async ({ page }) => {
  await signInAs(page, 'admin@gmail.com')
  await page.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await settle(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settle(page)

  // Wait for the builder to actually be on screen before counting anything.
  // `locator.count()` is a ONE-SHOT query with no auto-retry, unlike
  // `expect(...).toBeVisible()` -- and the tab panel animates in over ~280ms,
  // so counting straight after the click reliably returns 0 and reads as
  // "the feature is missing" rather than "the page had not painted yet".
  await expect(page.getByText('Funding source', { exact: true })).toBeVisible()

  // Remove (and every other write) lives behind the builder's edit mode.
  await page.getByRole('button', { name: 'Edit form', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Done editing', exact: true })).toBeVisible()

  // The five Default questions (name, short description, category, timeline
  // priority, annual energy savings) are asked on every line item and must never be removable --
  // the UI does not offer the action at all. A button that exists only to
  // produce a broken form is worse than no button.
  const rows = page.locator('li[data-drag-row]')
  const defaultRows = rows.filter({ has: page.getByText('Default', { exact: true }) })
  await expect(defaultRows).toHaveCount(5)
  for (const row of await defaultRows.all()) {
    await expect(row.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  }

  // Every other listed question -- custom, or column-backed but optional --
  // can be removed (custom: deleted; column-backed: taken out of the form,
  // since the database refuses to delete the row). Each offers exactly one.
  const rowCount = await rows.count()
  expect(rowCount).toBeGreaterThan(5)
  await expect(rows.getByRole('button', { name: /^Remove / })).toHaveCount(rowCount - 5)

  // The fixture's custom field among them.
  const funding = rows.filter({ has: page.getByText('Funding source', { exact: true }) })
  await expect(funding.getByRole('button', { name: 'Remove Funding source' })).toHaveCount(1)
})

test('a custom field can be added and removed, defaults are untouched', async ({ page }) => {
  await signInAs(page, 'admin@gmail.com')
  await page.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first().click()
  await page.waitForURL(/\/projects\/.+/)
  await settle(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settle(page)
  await expect(page.getByText('Funding source', { exact: true })).toBeVisible()

  const defaultCount = await page.getByText('Default', { exact: true }).count()
  expect(defaultCount).toBe(5)

  // Add a field. This is the client's actual ask -- "they have 10 fields now,
  // in the future they add 2 more" -- so it is worth exercising for real
  // rather than asserting the form that creates it merely renders.
  await page.getByRole('button', { name: 'Add questions', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add questions' })
  await dialog.getByLabel('Question 1 label').fill('Roof warranty note')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Roof warranty note', { exact: true })).toBeVisible()

  // Adding must not have disturbed the defaults. That is the additive
  // guarantee, observed from the UI rather than from SQL.
  expect(await page.getByText('Default', { exact: true }).count()).toBe(defaultCount)

  // Remove it again, through the two-step inline confirm. A native
  // window.confirm() here would block the page and hang this test.
  await page.getByRole('button', { name: 'Edit form', exact: true }).click()
  const row = page.locator('li', { hasText: 'Roof warranty note' }).last()
  await row.getByRole('button', { name: 'Remove Roof warranty note' }).click()
  await row.getByRole('button', { name: /^Confirm remove$/ }).click()

  await expect(page.getByText('Roof warranty note', { exact: true })).toHaveCount(0)
  expect(await page.getByText('Default', { exact: true }).count()).toBe(defaultCount)
})
