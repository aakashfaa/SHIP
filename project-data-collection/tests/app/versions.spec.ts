import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * Versions of the plan (migration 0031) -- the Timeline's "What if" became
 * peer versions:
 *
 *   "Each version can have a different cost model but they will have the
 *    same packages and line items so they can be saved and changed."
 *                                                                -- owner
 *
 * The properties under test: a new version starts as a copy of the open one
 * (same total), deleting a version asks first and leaves the others exactly
 * as they were, and the Timeline remembers which version you last opened.
 *
 * Runs as the stored admin session. Every version made here is named with
 * PREFIX and deleted in afterEach; the version held in the live tables is
 * never deleted by this file.
 */

const PROJECT_URL = '/projects/federal-campus-master-plan?tab=timeline'
const PREFIX = 'Versions e2e'

test.describe.configure({ mode: 'serial' })

async function openTimeline(page: Page) {
  await page.goto(PROJECT_URL)
  await settle(page)
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(page.locator('#timeline-version')).toBeVisible()
}

/** The escalated grand total, once the seeded cost model has landed ("2
 *  years overridden" only shows once the rate overrides are in hand). */
async function grandTotal(page: Page): Promise<string> {
  await expect(page.getByText('2 years overridden')).toBeVisible({ timeout: 20_000 })
  const card = page.locator('text=Total (escalated)').locator('..')
  await expect(card).not.toContainText('$0.00', { timeout: 20_000 })
  return (await card.innerText()).trim()
}

async function createVersion(page: Page, name: string) {
  await page.getByRole('button', { name: 'New version' }).click()
  await page.locator('#version-name').fill(name)
  const created = page.waitForResponse(
    (r) => r.url().includes('/rpc/create_version') && r.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  expect((await created).ok()).toBe(true)
  await expect(page.locator('#timeline-version option:checked')).toHaveText(name)
}

/** Deletes every version this file made, whatever state the page is in. */
async function deleteOurVersions(page: Page) {
  await openTimeline(page)
  const picker = page.locator('#timeline-version')
  for (;;) {
    const ours = await picker.locator('option').evaluateAll(
      (options, prefix) =>
        options
          .map((o) => o as HTMLOptionElement)
          .filter((o) => o.text.startsWith(prefix))
          .map((o) => o.value),
      PREFIX
    )
    if (ours.length === 0) break
    await picker.selectOption(ours[0])
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Yes, delete this version' }).click()
    await expect(picker.locator('option', { hasText: PREFIX })).toHaveCount(ours.length - 1)
  }
}

test.afterEach(async ({ page }) => {
  await deleteOurVersions(page)
})

test('a new version starts as a copy of the open one', async ({ page }) => {
  await openTimeline(page)
  const before = await grandTotal(page)

  await createVersion(page, `${PREFIX} copy ${Date.now()}`)

  // Same schedule, same cost model: same money.
  expect(await grandTotal(page)).toBe(before)
  // Every version is a peer: no "local copy" banner, no publish.
  await expect(page.getByText('Local copy')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /publish/i })).toHaveCount(0)
})

test('deleting a version asks first, names it, and leaves the others alone', async ({ page }) => {
  await openTimeline(page)
  const firstName = await page.locator('#timeline-version option:checked').innerText()
  const before = await grandTotal(page)
  const name = `${PREFIX} delete ${Date.now()}`
  await createVersion(page, name)

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Confirm delete version' })
  await expect(confirm).toContainText(name)
  await expect(confirm).toContainText(/can't be undone/i)
  await confirm.getByRole('button', { name: 'Keep it' }).click()
  await expect(confirm).toBeHidden()
  await expect(page.locator('#timeline-version option', { hasText: name })).toHaveCount(1)

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Yes, delete this version' }).click()
  await expect(page.locator('#timeline-version option', { hasText: name })).toHaveCount(0)

  // From the database, not React state.
  await page.reload()
  await settle(page)
  await expect(page.locator('#timeline-version option:checked')).toHaveText(firstName)
  expect(await grandTotal(page)).toBe(before)
})

test('the only version cannot be deleted', async ({ page }) => {
  await openTimeline(page)
  // The seed project has one version until someone makes another.
  if ((await page.locator('#timeline-version option').count()) === 1) {
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
  }
})

test('the Timeline remembers the version you last opened', async ({ page }) => {
  await openTimeline(page)
  const name = `${PREFIX} remembered ${Date.now()}`
  await createVersion(page, name)

  await page.reload()
  await settle(page)
  await expect(page.locator('#timeline-version option:checked')).toHaveText(name)
})

test('a version has its own cost model', async ({ page }) => {
  await openTimeline(page)
  const before = await grandTotal(page)
  await createVersion(page, `${PREFIX} cost ${Date.now()}`)

  await page.getByRole('button', { name: 'Edit cost model' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(PREFIX)
  const saved = page.waitForResponse(
    (r) => r.url().includes('/rpc/save_version_cost_settings') && r.request().method() === 'POST'
  )
  await dialog.getByLabel('TPC factor (× ECC)').fill('2.5')
  expect((await saved).ok()).toBe(true)
  await dialog.getByRole('button', { name: 'Done' }).click()

  const after = await grandTotal(page)
  expect(after).not.toBe(before)

  // The other version is untouched.
  await page.locator('#timeline-version').selectOption({ index: 0 })
  expect(await grandTotal(page)).toBe(before)
})

test('Excel export asks which version, defaulting to the open one', async ({ page }) => {
  await openTimeline(page)
  const name = `${PREFIX} export ${Date.now()}`
  await createVersion(page, name)

  const choice = page.getByLabel('Version to export')
  await expect(choice.locator('option:checked')).toContainText(name)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export Excel' }).click()
  expect((await download).suggestedFilename()).toContain('versions-e2e-export')
})
