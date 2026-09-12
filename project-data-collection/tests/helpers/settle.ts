import { expect, type Page } from '@playwright/test'

/**
 * Wait until the page has stopped changing for reasons that are nothing to do
 * with the thing under test.
 *
 * This lived as five near-identical copies, one per spec, which is how the
 * role-resolution wait below came to be missing from four of them.
 *
 * The subtle one is `permissions.loading`. `useProjectRole` resolves the
 * caller's role over an RPC, and several surfaces render DIFFERENT COPY while
 * that is in flight — the timeline grid caption reads "Checking your access…"
 * and then becomes either the drag instructions or the read-only notice. Those
 * strings wrap to different numbers of lines, which changes the header row's
 * height, which shifts every row below it.
 *
 * Screenshot a page mid-resolution and you get a ~2% whole-body pixel diff
 * that looks exactly like a layout regression and is not one. That cost an
 * investigation once; hence this function rather than another local copy.
 */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle')

  // The shell renders a placeholder card instead of a tab panel until the role
  // is known, so nothing below mounts twice.
  await expect(page.getByText('Checking your access…')).toHaveCount(0, { timeout: 15_000 })

  // `useAsyncData` renders a "Loading…" string until its promise resolves;
  // waiting on the network alone races that render. Tolerated rather than
  // asserted, because a page with no async data never shows one.
  await expect(page.getByText(/loading/i).first())
    .toBeHidden({ timeout: 15_000 })
    .catch(() => {})

  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}
