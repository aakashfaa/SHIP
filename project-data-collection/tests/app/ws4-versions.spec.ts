import { test, expect, type Page, type Locator } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * WS-4: drags inside a version of the plan (migration 0031 -- the what-if
 * became peer versions), end to end, as an editor.
 *
 * - M-05: two drags of two different bars inside one version are BOTH kept
 *   (each drop used to reset every other bar), and the bar visibly moves
 *   while it is being dragged.
 * - M-30: switching to another version and back shows the latest moves, in
 *   the same session and after a reload (which reopens the version last
 *   opened).
 * - M-23: Delete asks first, naming the version.
 * - M-01 (Wave B, D-1): zoom is a per-viewer view. Every level shows the
 *   same totals, and nothing is saved -- a reload opens at the default view.
 *
 * Signs in as planning@atlasmech.com (an editor on the seed project) rather
 * than reusing the admin storage state: editors are the people who run
 * versions in front of a client. Every version it creates is named with
 * PREFIX and deleted in afterEach; the version in the live tables is never
 * deleted here.
 */

const PROJECT_URL = '/projects/federal-campus-master-plan?tab=timeline'
const PREFIX = 'WS4 e2e'

test.describe.configure({ mode: 'serial' })
test.use({ storageState: { cookies: [], origins: [] } })

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel(/email/i).fill('planning@atlasmech.com')
  await page.getByLabel(/password/i).fill('localdev123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/projects', { timeout: 30_000 })
}

async function openTimeline(page: Page) {
  await page.goto(PROJECT_URL)
  await settle(page)
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(page.locator('#timeline-version')).toBeVisible()
}

async function totalText(page: Page): Promise<string> {
  const card = page.locator('text=Total (escalated)').locator('..')
  await expect(card).not.toContainText('$0.00', { timeout: 20_000 })
  return (await card.innerText()).trim()
}

async function startOf(bar: Locator): Promise<number> {
  return Number(await bar.getAttribute('data-start-slot'))
}

/** "New version" (a copy of the open one), named, and opened. */
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

/** Deletes every version this spec made, whatever state the page is in. */
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

/**
 * Drags a bar by `cells` columns with a real pointer, asserting the bar has
 * already moved BEFORE the button is released (M-05: it used to sit still
 * until the drop). Waits for the version save to land.
 */
async function dragBar(page: Page, phaseId: string, cells: number) {
  const bar = page.locator(`[data-phase-id="${phaseId}"]`)
  const before = await startOf(bar)
  await bar.scrollIntoViewIfNeeded()
  const box = (await bar.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 92 * cells, y, { steps: 8 })
  await expect(bar).toHaveAttribute('data-start-slot', String(before + cells))

  const saved = page.waitForResponse(
    (r) => r.url().includes('/rpc/save_version_phases') && r.request().method() === 'POST'
  )
  await page.mouse.up()
  const response = await saved
  expect(response.ok(), await response.text()).toBe(true)
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test.afterEach(async ({ page }) => {
  await deleteOurVersions(page)
})

test('zoom changes the view only: same totals at every level, nothing saved (M-01, D-1)', async ({
  page,
}) => {
  await openTimeline(page)
  const before = await totalText(page)
  const fyStrip = page.getByRole('heading', { name: 'By fiscal year' }).locator('..')
  const fyBefore = (await fyStrip.innerText()).trim()

  const zoom = page.locator('#timeline-zoom')
  await expect(zoom).toBeEnabled()
  for (const level of ['1', '2', '4', '5', '3']) {
    await zoom.fill(level)
    expect(await totalText(page)).toBe(before)
    expect((await fyStrip.innerText()).trim()).toBe(fyBefore)
  }

  // Month zoom, then reload: the view is not persisted, so the page opens at
  // the project's default (Year) again -- and the totals never moved.
  await zoom.fill('5')
  await page.reload()
  await settle(page)
  await expect(page.locator('#timeline-zoom')).toHaveValue('3')
  expect(await totalText(page)).toBe(before)
})

test('two drags in one version are both kept, and survive switching and reload (M-05, M-30)', async ({
  page,
}) => {
  await openTimeline(page)
  const originalTotal = await totalText(page)
  const originalKey = await page.locator('#timeline-version').inputValue()
  const name = `${PREFIX} two drags ${Date.now()}`

  await createVersion(page, name)
  const versionKey = await page.locator('#timeline-version').inputValue()

  await page.getByRole('button', { name: 'Open all' }).click()

  // Two bars in DIFFERENT packages, each with room to move one column right.
  const candidates = await page.locator('[data-phase-id]').evaluateAll((bars) =>
    bars.map((b) => ({
      id: b.getAttribute('data-phase-id')!,
      start: Number(b.getAttribute('data-start-slot')),
      duration: Number(b.getAttribute('data-duration-slots')),
      chunk: b.getAttribute('data-chunk-id')!,
    }))
  )
  const roomy = candidates.filter((c) => c.start + c.duration < 10)
  expect(roomy.length).toBeGreaterThanOrEqual(2)
  const first = roomy[0]
  const second = roomy.find((c) => c.chunk !== first.chunk) ?? roomy[1]

  await dragBar(page, first.id, 1)
  await dragBar(page, second.id, 1)

  const barA = page.locator(`[data-phase-id="${first.id}"]`)
  const barB = page.locator(`[data-phase-id="${second.id}"]`)
  await expect(barA).toHaveAttribute('data-start-slot', String(first.start + 1))
  await expect(barB).toHaveAttribute('data-start-slot', String(second.start + 1))

  // The version it was copied from: both bars where they were, total unchanged.
  await page.locator('#timeline-version').selectOption(originalKey)
  await page.getByRole('button', { name: 'Open all' }).click()
  await expect(barA).toHaveAttribute('data-start-slot', String(first.start))
  await expect(barB).toHaveAttribute('data-start-slot', String(second.start))
  expect(await totalText(page)).toBe(originalTotal)

  // Back in the same session (M-30): both moves are still there.
  await page.locator('#timeline-version').selectOption(versionKey)
  await page.getByRole('button', { name: 'Open all' }).click()
  await expect(barA).toHaveAttribute('data-start-slot', String(first.start + 1))
  await expect(barB).toHaveAttribute('data-start-slot', String(second.start + 1))

  // And from the server, after a reload -- which reopens this version.
  await page.reload()
  await settle(page)
  await expect(page.locator('#timeline-version')).toHaveValue(versionKey)
  await page.getByRole('button', { name: 'Open all' }).click()
  await expect(barA).toHaveAttribute('data-start-slot', String(first.start + 1))
  await expect(barB).toHaveAttribute('data-start-slot', String(second.start + 1))
})

test('a plain click on a bar inside a version saves nothing (M-05)', async ({ page }) => {
  await openTimeline(page)
  await createVersion(page, `${PREFIX} click ${Date.now()}`)
  await page.getByRole('button', { name: 'Open all' }).click()

  let saves = 0
  page.on('request', (r) => {
    if (r.url().includes('/rpc/save_version_phases')) saves += 1
  })
  await page.locator('[data-phase-id]').first().click()
  await page.waitForTimeout(500)
  expect(saves).toBe(0)
})

test('Delete asks first and names the version (M-23)', async ({ page }) => {
  await openTimeline(page)
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

  await page.reload()
  await settle(page)
  await expect(page.locator('#timeline-version option', { hasText: name })).toHaveCount(0)
})
