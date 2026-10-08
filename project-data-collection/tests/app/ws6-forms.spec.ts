import { test, expect, type Page } from '@playwright/test'
import { settle } from '../helpers/settle'

/**
 * WS-6: Add Data number / cost inputs (M-06, M-09), Master View horizontal
 * scroll with sticky columns (M-19), XSS-safe Export PDF (M-20), and the
 * two-step line-item delete (M-23).
 *
 * Writes to the local DB: the create test makes one throwaway line item as
 * consultant1 and deletes it through the UI (which doubles as the M-23 check),
 * with a fallback delete in `finally` so a failed assertion cannot leave it.
 *
 * Runs signed-out and logs in per test so one spec can act as both the
 * consultant and the admin; `storageState` from the app project is cleared.
 */

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const PROJECT = 'federal-campus-master-plan'

async function signIn(page: Page, email: string) {
  await page.goto('/')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill('localdev123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/projects', { timeout: 30_000 })
}

/** Click Next until `label` is on screen (the wizard groups fields in steps). */
async function goToField(page: Page, label: string) {
  const field = page.getByLabel(label, { exact: true })
  for (let i = 0; i < 12; i++) {
    // Steps cross-fade (exit animation first); clicking Next again before the
    // new step mounts would skip past it.
    if (await field.isVisible().catch(() => false)) return field
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await field.waitFor({ timeout: 1500 }).catch(() => {})
  }
  await expect(field).toBeVisible()
  return field
}

/** Types char by char (the real keystroke path that used to corrupt values)
 *  and asserts the box shows exactly what was typed. */
async function typeExactly(page: Page, label: string, text: string) {
  const input = await goToField(page, label)
  await input.fill('')
  await input.pressSequentially(text)
  await expect(input).toHaveValue(text)
}

test('add data: numbers keep what is typed, costs preview and validate, delete needs a confirm', async ({
  page,
}) => {
  const name = `WS6 temp ${Date.now()}`
  await signIn(page, 'consultant1@gmail.com')
  await page.goto(`/projects/${PROJECT}?tab=add-data`)
  await settle(page)

  async function deleteTempIfAny() {
    await page.goto(`/projects/${PROJECT}?tab=add-data`)
    await settle(page)
    const row = page.getByRole('heading', { name, exact: true })
    if ((await row.count()) === 0) return
    await row.click()
    await page.getByRole('button', { name: 'Delete Line Item' }).click()
    await page.getByRole('button', { name: 'Yes, delete' }).click()
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0)
  }

  try {
    await page.getByRole('button', { name: 'Add Line Item' }).click()
    await page.getByLabel('Item name', { exact: true }).fill(name)

    // M-06: each value must survive being typed one key at a time.
    for (const typed of ['12.5', '-200', '1,200', '0.5']) {
      await typeExactly(page, 'Annual energy saving', typed)
    }
    await typeExactly(page, 'Annual energy saving', '12.5')

    // Garbage in a number field: inline error after blur, and Next/Save blocked.
    const savings = await goToField(page, 'Annual utility cost saving')
    await savings.fill('abc')
    await savings.blur()
    await expect(page.getByText('Enter a number, like 12.5 or -200.')).toBeVisible()
    await savings.fill('-200')

    // M-09: shorthand previews live; unreadable and negative are errors.
    const cost = await goToField(page, 'Estimated first cost')
    await cost.fill('')
    await cost.pressSequentially('1.2 million')
    await expect(page.getByText('= $1,200,000')).toBeVisible()
    await cost.fill('TBD')
    await cost.blur()
    await expect(page.getByText(/Can't read this amount/)).toBeVisible()
    await cost.fill('-250k')
    await cost.blur()
    await expect(page.getByText("Costs can't be negative.")).toBeVisible()
    await cost.fill('850k')
    await expect(page.getByText('= $850,000')).toBeVisible()

    // Walk to the end and save.
    const save = page.getByRole('button', { name: 'Save Line Item' })
    while (!(await save.isVisible())) {
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.waitForTimeout(500)
    }
    await save.click()

    // The saved item shows the typed values, unmangled, when reopened.
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await page.reload()
    await settle(page)
    await page.getByRole('heading', { name, exact: true }).click()
    await expect(page.getByLabel('Annual energy saving', { exact: true })).toHaveValue('12.5')
    await expect(page.getByLabel('Annual utility cost saving', { exact: true })).toHaveValue('-200')
    await expect(page.getByLabel('Estimated first cost', { exact: true })).toHaveValue('850k')

    // M-23: delete is two steps, names the consequence, and Cancel keeps it.
    await page.getByRole('button', { name: 'Delete Line Item' }).click()
    await expect(page.getByText(`Delete '${name}'?`)).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Delete Line Item' }).click()
    await page.getByRole('button', { name: 'Yes, delete' }).click()
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0)
  } finally {
    await deleteTempIfAny()
  }
})

test('master view: scrolls horizontally with sticky #, Discipline and Name', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, 'admin@gmail.com')
  await page.goto(`/projects/${PROJECT}?tab=master-view`)
  await settle(page)

  const table = page.locator('table')
  await expect(table).toBeVisible()
  const wrapper = page.locator('div.overflow-x-auto', { has: table })

  const dims = await wrapper.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(dims.scroll).toBeGreaterThan(dims.client)

  const numberHeader = table.locator('th', { hasText: /^#$/ })
  const lastHeader = table.locator('th', { hasText: 'Submitted By' })
  const before = (await numberHeader.boundingBox())!.x

  await wrapper.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  // The last column is reachable and inside the wrapper...
  const wrapBox = (await wrapper.boundingBox())!
  const lastBox = (await lastHeader.boundingBox())!
  expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(wrapBox.x + wrapBox.width + 1)
  // ...while # stayed pinned where it was.
  expect(Math.abs((await numberHeader.boundingBox())!.x - before)).toBeLessThan(2)
  await expect(table.locator('th', { hasText: /^Discipline$/ })).toBeInViewport()
  await expect(table.locator('th', { hasText: /^Item name$/ })).toBeInViewport()
})

test('master view: Export PDF never renders the project name as HTML', async ({ page }) => {
  const payload = '<img src=x onerror="window.__xss=true">'

  // Rewrite the project name in the browser only; nothing is written to the DB.
  await page.route('**/rest/v1/projects*', async (route) => {
    const response = await route.fetch()
    const body = (await response.text()).replace(
      /"name":"Federal Campus Master Plan"/g,
      `"name":${JSON.stringify(payload)}`
    )
    await route.fulfill({ response, body })
  })
  // Capture what Export PDF writes instead of opening a real window.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.open = () => {
      const doc = document.implementation.createHTMLDocument('')
      const fake = { document: doc, opener: {}, focus() {}, print() {} }
      w.__printWindow = fake
      return fake
    }
  })

  await signIn(page, 'admin@gmail.com')
  await page.goto(`/projects/${PROJECT}?tab=master-view`)
  await settle(page)
  await page.getByRole('button', { name: 'Export PDF' }).click()

  const result = await page.evaluate(() => {
    const w = (window as unknown as { __printWindow: { document: Document; opener: unknown } })
      .__printWindow
    return {
      imgs: w.document.body.querySelectorAll('img').length,
      h1: w.document.querySelector('h1')?.textContent,
      title: w.document.title,
      opener: w.opener,
      tables: w.document.querySelectorAll('table').length,
      xss: (window as unknown as { __xss?: boolean }).__xss === true,
    }
  })
  expect(result.imgs).toBe(0)
  expect(result.h1).toBe(payload)
  expect(result.title).toContain(payload)
  expect(result.opener).toBeNull()
  expect(result.tables).toBe(1)
  expect(result.xss).toBe(false)
})
