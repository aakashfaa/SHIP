import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * The per-package phase summary in Phasing.
 *
 * Phase STRUCTURE is one project-level choice (the phase template in the
 * Timeline's cost model) and timing is moved on the Timeline, so Phasing shows
 * each package's phases read-only: what each phase costs as a share of TPC,
 * its duration, and whether the shares add up to 100%.
 */

test.describe.configure({ mode: 'serial' })


async function openPhasingPackage(page: Page, chunkNumber: string) {
  await page.goto('/projects/federal-campus-master-plan?tab=phasing')
  await settle(page)
  await page.getByRole('button', { name: `Edit package ${chunkNumber}` }).click()
  await settle(page)
}

test('a package shows its phases with costs and a running allocation', async ({ page }) => {
  await openPhasingPackage(page, 'PP10')

  // The editor lives below the line-item table inside the expanded card.
  const editor = page.getByText('Phases', { exact: true }).first()
  await editor.scrollIntoViewIfNeeded()
  await expect(editor).toBeVisible()

  // Read-only now: phase names are table cells, and nothing on the package
  // offers to restructure its phases (that is the project template's job).
  await expect(page.getByRole('cell', { name: 'Draft Study (Study Tasks 1-5)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply Template' })).toHaveCount(0)
  await expect(page.getByText(/% of TPC allocated$/).first()).toBeVisible()
  // The derived cost is what makes a percentage mean something to an estimator.
  await expect(page.getByText('TPC base: $14,896,000 ($11,200,000 ECC × 1.33)')).toBeVisible()

  await settle(page)
  await expect(page).toHaveScreenshot('phase-editor.png', { fullPage: true })
})

test('an incomplete allocation is surfaced on the package that has one', async ({ page }) => {
  await openPhasingPackage(page, 'PP14')
  // PP14's construction phase is seeded at 80%, so the package sits at 90%.
  await expect(page.getByRole('status').filter({ hasText: '90.0% of TPC allocated' })).toBeVisible()
})
