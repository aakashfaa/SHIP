import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * WS-7: form builder reordering (M-18), two-step delete confirms for packages
 * and phases (M-23), and package quantity validation (M-10).
 *
 * These write to the local DB, so each test puts everything back: the reorder
 * test moves a field down and then back up, and the package test creates its
 * own throwaway package and deletes it (also in a finally).
 */

test.describe.configure({ mode: 'serial' })

const PROJECT = 'federal-campus-master-plan'

async function fieldOrder(page: Page): Promise<string[]> {
  // Each field row has "Move <label> up" / "Move <label> down" buttons. Read
  // the labels off the "up" buttons, in DOM order (option-level buttons only
  // exist once a field's options are shown, which this test never opens).
  const names = await page
    .getByRole('button', { name: /^Move .+ up$/ })
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  return names.map((n) => n.replace(/^Move /, '').replace(/ up$/, ''))
}

test('form builder: field up/down persists and survives a reload', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}?tab=settings`)
  await settle(page)

  const before = await fieldOrder(page)
  expect(before.length).toBeGreaterThan(2)

  // Second field of the first group moves above the first.
  const [first, second] = before
  const downOfFirst = page.getByRole('button', { name: `Move ${first} down` })
  try {
    await downOfFirst.click()
    await expect(page.getByText(/Failed to reorder|violates not-null/i)).toHaveCount(0)
    await expect.poll(async () => (await fieldOrder(page)).slice(0, 2)).toEqual([second, first])

    await page.reload()
    await settle(page)
    expect((await fieldOrder(page)).slice(0, 2)).toEqual([second, first])
  } finally {
    // Put it back so the seed order is unchanged for every other spec.
    const upOfFirst = page.getByRole('button', { name: `Move ${first} up` })
    if (await upOfFirst.isEnabled()) {
      await upOfFirst.click()
      await expect.poll(async () => (await fieldOrder(page)).slice(0, 2)).toEqual([first, second])
    }
  }
})

test('chunking: package and phase deletes need a second click; quantity is validated', async ({
  page,
}) => {
  const name = `WS7 temp ${Date.now()}`
  await page.goto(`/projects/${PROJECT}?tab=chunking`)
  await settle(page)

  async function deleteTempPackageIfAny() {
    const card = page.locator('div.overflow-hidden', { hasText: name }).first()
    if ((await card.count()) === 0) return
    await card.getByRole('button', { name: 'Delete', exact: true }).click()
    await card.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(page.getByText(name)).toHaveCount(0)
  }

  try {
    // Create a package holding one line item.
    await page.getByRole('button', { name: 'Create Package' }).click()
    await page.getByPlaceholder('Package name').fill(name)
    await page.locator('input[type="checkbox"]').first().check()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByText(name)).toBeVisible()

    const card = page.locator('div.overflow-hidden', { hasText: name }).first()

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
    const reloaded = page.locator('div.overflow-hidden', { hasText: name }).first()
    await expect(
      reloaded.getByRole('textbox', { name: /^Quantity for / }).first()
    ).not.toHaveValue('abc')

    // --- M-23: phase delete confirm ------------------------------------
    await reloaded.getByRole('button', { name: /^(Edit|Hide|View|Open) package/ }).click()
    await reloaded.getByRole('button', { name: 'Apply Template' }).click()
    await expect(reloaded.getByRole('button', { name: /^Delete / }).first()).toBeVisible()
    const phaseDeletes = reloaded.getByRole('button', { name: /^Delete / })
    const phaseCount = await phaseDeletes.count()
    expect(phaseCount).toBeGreaterThan(1)

    await phaseDeletes.first().click()
    await expect(reloaded.getByText(/Delete this phase\?/)).toBeVisible()
    await reloaded.getByRole('button', { name: 'Cancel' }).click()
    await expect(reloaded.getByRole('button', { name: /^Delete / })).toHaveCount(phaseCount)

    await reloaded.getByRole('button', { name: /^Delete / }).first().click()
    await reloaded.getByRole('button', { name: /^Confirm delete / }).click()
    await expect(reloaded.getByRole('button', { name: /^Delete / })).toHaveCount(phaseCount - 1)

    // --- M-23: package delete confirm names the phases -----------------
    await reloaded.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(reloaded.getByRole('alertdialog')).toContainText(
      `${phaseCount - 1} phases`
    )
    await reloaded.getByRole('button', { name: 'Cancel' }).last().click()
    await expect(page.getByText(name)).toBeVisible()
  } finally {
    await deleteTempPackageIfAny()
  }
})
