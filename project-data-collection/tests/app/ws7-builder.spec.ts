import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * WS-7: form builder reordering (M-18, keyboard path on the drag handle), two-step delete confirm for packages
 * (M-23; per-package phase editing is gone, phases come from the project
 * template), and package quantity validation (M-10).
 *
 * These write to the local DB, so each test puts everything back: the reorder
 * test moves a field down and then back up, and the package test creates its
 * own throwaway package and deletes it (also in a finally).
 */

test.describe.configure({ mode: 'serial' })

const PROJECT = 'federal-campus-master-plan'

async function fieldOrder(page: Page): Promise<string[]> {
  // In edit mode each question row has a drag handle labelled
  // "Reorder <label> (arrow keys move it)"; group handles read "Reorder group
  // ..." and are skipped. Read the labels off the handles, in DOM order.
  const names = await page
    .getByRole('button', { name: /^Reorder (?!group ).+ \(arrow keys move it\)$/ })
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  return names.map((n) => n.replace(/^Reorder /, '').replace(/ \(arrow keys move it\)$/, ''))
}

function handleFor(page: Page, label: string) {
  return page.getByRole('button', { name: `Reorder ${label} (arrow keys move it)`, exact: true })
}

async function openEditMode(page: Page) {
  await page.getByRole('button', { name: 'Edit form', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Done editing', exact: true })).toBeVisible()
}

test('form builder: field reorder persists and survives a reload', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}?tab=settings`)
  await settle(page)
  await openEditMode(page)

  const before = await fieldOrder(page)
  expect(before.length).toBeGreaterThan(2)

  // First field of the first group moves below the second, via the keyboard
  // path on its drag handle (the same commit a drag makes).
  const [first, second] = before
  try {
    await handleFor(page, first).focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByText(/Failed to reorder|violates not-null/i)).toHaveCount(0)
    // The builder's own error banner (role=alert); Next's route announcer
    // also carries role=alert and is not an error.
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0)
    await expect.poll(async () => (await fieldOrder(page)).slice(0, 2)).toEqual([second, first])

    await page.reload()
    await settle(page)
    await openEditMode(page)
    expect((await fieldOrder(page)).slice(0, 2)).toEqual([second, first])
  } finally {
    // Put it back so the seed order is unchanged for every other spec.
    const order = await fieldOrder(page)
    if (order.indexOf(first) === 1 && order[0] === second) {
      await handleFor(page, first).focus()
      await page.keyboard.press('ArrowUp')
      await expect.poll(async () => (await fieldOrder(page)).slice(0, 2)).toEqual([first, second])
    }
  }
})

/**
 * A package card on the Phasing tab. The `:not(...)` clauses because the
 * workspace frame (root and box) that holds every tab is overflow-hidden too, and it
 * contains every card's text.
 */
function packageCard(page: Page, name: string) {
  return page.locator('div.overflow-hidden:not([data-workspace-root]):not([data-workspace-box])', { hasText: name }).first()
}

test('phasing: a new package gets the project template phases; quantity is validated; delete needs a second click', async ({
  page,
}) => {
  const name = `WS7 temp ${Date.now()}`
  await page.goto(`/projects/${PROJECT}?tab=phasing`)
  await settle(page)

  async function deleteTempPackageIfAny() {
    const card = packageCard(page, name)
    if ((await card.count()) === 0) return
    await card.getByRole('button', { name: 'Delete', exact: true }).click()
    await card.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(page.getByText(name)).toHaveCount(0)
  }

  try {
    // Create a package holding one line item. No per-package template step:
    // phases come from the project's one phase template.
    await page.getByRole('button', { name: 'Create Package' }).click()
    const dialog = page.getByRole('dialog', { name: 'New package' })
    await dialog.getByLabel('Package name').fill(name)
    await dialog.locator('input[type="checkbox"]').first().check()
    await expect(dialog.getByText('1 selected')).toBeVisible()
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText(name)).toBeVisible()

    const card = packageCard(page, name)

    // --- M-10: quantity validation -------------------------------------
    const qty = card.getByRole('textbox', { name: /^Quantity for / }).first()
    await qty.fill('1,200')
    await expect(card.getByText('= 1,200')).toBeVisible()
    await expect(card.getByRole('alert')).toHaveCount(0)
    await expect(qty).toHaveValue('1,200')

    await qty.fill('abc')
    await expect(card.getByRole('alert')).toBeVisible()
    await expect(qty).toHaveValue('abc') // the user's text is kept
    // Past the 400ms debounce: invalid text must never have been written.
    await page.waitForTimeout(900)
    await page.reload()
    await settle(page)
    const reloaded = packageCard(page, name)
    await expect(
      reloaded.getByRole('textbox', { name: /^Quantity for / }).first()
    ).not.toHaveValue('abc')

    // --- created WITH phases, read-only here ----------------------------
    const toggle = reloaded.getByRole('button', { name: /^(Edit|Hide|View|Open) package/ })
    if ((await toggle.getAttribute('aria-label'))?.startsWith('Edit')) await toggle.click()
    const phaseRows = reloaded.locator('table').last().locator('tbody tr')
    await expect(phaseRows.first()).toBeVisible()
    const phaseCount = await phaseRows.count()
    expect(phaseCount).toBeGreaterThan(1)
    await expect(reloaded.getByRole('button', { name: 'Apply Template' })).toHaveCount(0)

    // --- M-23: package delete confirm names the phases -----------------
    await reloaded.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(reloaded.getByRole('alertdialog')).toContainText(`${phaseCount} phases`)
    await reloaded.getByRole('button', { name: 'Cancel' }).last().click()
    await expect(page.getByText(name)).toBeVisible()
  } finally {
    await deleteTempPackageIfAny()
  }
})
