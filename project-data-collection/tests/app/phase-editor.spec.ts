import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * The per-package phase editor in Chunking.
 *
 * Timeline can move phases; this is where they are defined — which template a
 * package uses, what each phase costs as a share of TPC, and whether its
 * duration is locked.
 */

test.describe.configure({ mode: 'serial' })


async function openChunkingPackage(page: Page, chunkNumber: string) {
  await page.goto('/projects/federal-campus-master-plan?tab=chunking')
  await settle(page)
  await page.getByRole('button', { name: `Edit package ${chunkNumber}` }).click()
  await settle(page)
}

test('a package shows its phases with costs and a running allocation', async ({ page }) => {
  await openChunkingPackage(page, 'PP10')

  // The editor lives below the line-item table inside the expanded card.
  const editor = page.getByText('Phases', { exact: true }).first()
  await editor.scrollIntoViewIfNeeded()
  await expect(editor).toBeVisible()

  // Phase names are editable inputs here, not text nodes — getByText would
  // never match them.
  await expect(
    page.locator('input[value="Draft Study (Study Tasks 1-5)"]')
  ).toBeVisible()
  await expect(page.getByRole('combobox').first()).toBeVisible()
  // The derived cost is what makes a percentage mean something to an estimator.
  await expect(page.getByText('TPC base: $14,896,000 ($11,200,000 ECC × 1.33)')).toBeVisible()

  await settle(page)
  await expect(page).toHaveScreenshot('phase-editor.png', { fullPage: true })
})

test('an incomplete allocation is surfaced on the package that has one', async ({ page }) => {
  await openChunkingPackage(page, 'PP14')
  // PP14's construction phase is seeded at 80%, so the package sits at 90%.
  await expect(page.getByText(/90(\.0)?%/).first()).toBeVisible()
})
