import { test, expect, type Page, type Locator } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * WS-4: the what-if drag fixes, end to end, as an editor.
 *
 * - M-05: two drags of two different bars inside one what-if are BOTH kept
 *   (each drop used to reset every other bar to its live-plan position), and
 *   the bar visibly moves while it is being dragged.
 * - M-30: "Back to live plan" then "Resume…" shows the latest moves, in the
 *   same session and after a reload.
 * - M-23: Discard asks first, naming the what-if.
 * - M-01 (Wave B, D-1): zoom is a per-viewer view. Every level shows the
 *   same totals, and nothing is saved -- a reload opens at the default view.
 *
 * Signs in as planning@atlasmech.com (an editor on the seed project) rather
 * than reusing the admin storage state, because editors are the people who
 * actually run what-ifs in front of a client. Every what-if it creates is
 * named with PREFIX and discarded in afterEach.
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
}

async function totalText(page: Page): Promise<string> {
  const card = page.locator('text=Total (escalated)').locator('..')
  await expect(card).not.toContainText('$0.00', { timeout: 20_000 })
  return (await card.innerText()).trim()
}

async function startOf(bar: Locator): Promise<number> {
  return Number(await bar.getAttribute('data-start-slot'))
}

/** Removes every what-if this spec made, whatever state the page is in. */
async function discardOurScenarios(page: Page) {
  await openTimeline(page)
  const back = page.getByRole('button', { name: 'Back to live plan' })
  if (await back.count()) await back.click()

  const resume = page.getByLabel('Resume a saved what-if')
  for (;;) {
    if (!(await resume.count())) break
    const ours = await resume.locator('option').evaluateAll(
      (options, prefix) =>
        options
          .map((o) => o as HTMLOptionElement)
          .filter((o) => o.value && o.text.startsWith(prefix))
          .map((o) => o.value),
      PREFIX
    )
    if (ours.length === 0) break
    await resume.selectOption(ours[0])
    await page.getByRole('button', { name: 'Discard' }).click()
    await page.getByRole('button', { name: 'Yes, delete this what-if' }).click()
    await expect(page.getByText('Local copy')).toBeHidden()
  }
}

/**
 * Drags a bar by `cells` columns with a real pointer, asserting the bar has
 * already moved BEFORE the button is released (M-05: it used to sit still
 * until the drop). Waits for the what-if save to land.
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
    (r) => r.url().includes('/rpc/save_scenario_payload') && r.request().method() === 'POST'
  )
  await page.mouse.up()
  const response = await saved
  expect(response.ok(), await response.text()).toBe(true)
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test.afterEach(async ({ page }) => {
  await discardOurScenarios(page)
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

test('two drags in one what-if are both kept, and survive leave/resume and reload (M-05, M-30)', async ({
  page,
}) => {
  await openTimeline(page)
  const liveTotal = await totalText(page)
  const name = `${PREFIX} two drags ${Date.now()}`

  await page.getByRole('button', { name: 'Try a what-if' }).click()
  await page.getByLabel('Name this what-if').fill(name)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Local copy')).toBeVisible()

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

  // Back to the live plan: both bars at their live positions, total unchanged.
  await page.getByRole('button', { name: 'Back to live plan' }).click()
  await expect(page.getByText('Local copy')).toBeHidden()
  await expect(barA).toHaveAttribute('data-start-slot', String(first.start))
  await expect(barB).toHaveAttribute('data-start-slot', String(second.start))
  expect(await totalText(page)).toBe(liveTotal)

  // Resume in the same session (M-30): both moves are still there.
  const resume = page.getByLabel('Resume a saved what-if')
  const value = await resume
    .locator('option', { hasText: name })
    .evaluate((o) => (o as HTMLOptionElement).value)
  await resume.selectOption(value)
  await expect(page.getByText('Local copy')).toBeVisible()
  await page.getByRole('button', { name: 'Open all' }).click()
  await expect(barA).toHaveAttribute('data-start-slot', String(first.start + 1))
  await expect(barB).toHaveAttribute('data-start-slot', String(second.start + 1))

  // And from the server, after a reload.
  await page.reload()
  await settle(page)
  await page.getByLabel('Resume a saved what-if').selectOption(value)
  await page.getByRole('button', { name: 'Open all' }).click()
  await expect(barA).toHaveAttribute('data-start-slot', String(first.start + 1))
  await expect(barB).toHaveAttribute('data-start-slot', String(second.start + 1))
})

test('a plain click on a bar inside a what-if saves nothing (M-05)', async ({ page }) => {
  await openTimeline(page)
  await page.getByRole('button', { name: 'Try a what-if' }).click()
  await page.getByLabel('Name this what-if').fill(`${PREFIX} click ${Date.now()}`)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: 'Open all' }).click()

  let saves = 0
  page.on('request', (r) => {
    if (r.url().includes('/rpc/save_scenario_payload')) saves += 1
  })
  await page.locator('[data-phase-id]').first().click()
  await page.waitForTimeout(500)
  expect(saves).toBe(0)
})

test('Discard asks first and names the what-if (M-23)', async ({ page }) => {
  await openTimeline(page)
  const name = `${PREFIX} discard ${Date.now()}`
  await page.getByRole('button', { name: 'Try a what-if' }).click()
  await page.getByLabel('Name this what-if').fill(name)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Local copy')).toBeVisible()

  await page.getByRole('button', { name: 'Discard' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Confirm discard' })
  await expect(confirm).toContainText(name)
  await expect(confirm).toContainText("can't be undone")
  // Nothing has been deleted yet.
  await expect(page.getByText('Local copy')).toBeVisible()

  await confirm.getByRole('button', { name: 'Keep it' }).click()
  await expect(confirm).toBeHidden()
  await expect(page.getByText('Local copy')).toBeVisible()

  await page.getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('button', { name: 'Yes, delete this what-if' }).click()
  await expect(page.getByText('Local copy')).toBeHidden()

  await page.reload()
  await settle(page)
  const resume = page.getByLabel('Resume a saved what-if')
  if (await resume.count()) {
    await expect(resume.locator('option', { hasText: name })).toHaveCount(0)
  }
})

/**
 * M-07 (UI, against WS-1's 3-way rebase in 0015): a colleague's change to a
 * phase the what-if never touched is pulled in, the user's own move is kept,
 * and the banner says which is which. The "colleague" is a second tab on the
 * live plan; its move is put back at the end.
 */
test('Pull in the latest plan keeps my moves and reports what happened (M-07)', async ({
  page,
  context,
}) => {
  await openTimeline(page)
  const name = `${PREFIX} rebase ${Date.now()}`
  await page.getByRole('button', { name: 'Try a what-if' }).click()
  await page.getByLabel('Name this what-if').fill(name)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: 'Open all' }).click()

  const bars = await page.locator('[data-phase-id]').evaluateAll((els) =>
    els.map((b) => ({
      id: b.getAttribute('data-phase-id')!,
      start: Number(b.getAttribute('data-start-slot')),
      duration: Number(b.getAttribute('data-duration-slots')),
      chunk: b.getAttribute('data-chunk-id')!,
    }))
  )
  const roomy = bars.filter((c) => c.start + c.duration < 10)
  const mine = roomy[0]
  const theirs = roomy.find((c) => c.chunk !== mine.chunk)!
  await dragBar(page, mine.id, 1)

  // A colleague moves a different phase on the LIVE plan.
  const live = await context.newPage()
  await live.goto(PROJECT_URL)
  await settle(live)
  await live.getByRole('button', { name: 'Open all' }).click()
  const theirBar = live.locator(`[data-phase-id="${theirs.id}"]`)
  await theirBar.scrollIntoViewIfNeeded()
  const box = (await theirBar.boundingBox())!
  const liveSave = live.waitForResponse((r) => r.url().includes('/chunk_phases') && r.request().method() === 'PATCH')
  await live.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await live.mouse.down()
  await live.mouse.move(box.x + box.width / 2 + 92, box.y + box.height / 2, { steps: 8 })
  await live.mouse.up()
  await liveSave

  try {
    await page.getByRole('button', { name: 'Publish to live plan' }).click()
    await expect(page.getByText('The live plan changed while you were working')).toBeVisible()
    await page.getByRole('button', { name: 'Pull in the latest plan and keep my moves' }).click()

    const notice = page.getByText(/You can publish now\./)
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Kept your 1 move')
    await expect(notice).toContainText('Pulled in the live plan')
    await expect(page.locator(`[data-phase-id="${mine.id}"]`)).toHaveAttribute(
      'data-start-slot',
      String(mine.start + 1)
    )
    await expect(page.locator(`[data-phase-id="${theirs.id}"]`)).toHaveAttribute(
      'data-start-slot',
      String(theirs.start + 1)
    )
  } finally {
    // Put the colleague's live move back.
    await live.reload()
    await settle(live)
    await live.getByRole('button', { name: 'Open all' }).click()
    await theirBar.scrollIntoViewIfNeeded()
    const b = (await theirBar.boundingBox())!
    const undo = live.waitForResponse((r) => r.url().includes('/chunk_phases') && r.request().method() === 'PATCH')
    await live.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await live.mouse.down()
    await live.mouse.move(b.x + b.width / 2 - 92, b.y + b.height / 2, { steps: 8 })
    await live.mouse.up()
    await undo
    await expect(theirBar).toHaveAttribute('data-start-slot', String(theirs.start))
    await live.close()
  }
})
