import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { settle } from '../helpers/settle'

/**
 * The per-view Filter (Master View, Phasing): a personal filter hides a
 * column for this browser only, and a column the project admin hid for
 * everyone cannot be brought back by anyone else.
 *
 * The personal layer is localStorage, so the first test writes nothing to the
 * database. The second one has to save a project default -- that is the
 * feature -- so it reads the project's `view_settings` first and writes the
 * exact original value back in `finally`, through the same admin-only RPC the
 * app uses.
 */

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const PROJECT = 'federal-campus-master-plan'
const ADMIN = { email: 'admin@gmail.com', password: 'localdev123' }
const VIEWER = 'electrical@voltworks.com'

function envFromDotLocal(): Record<string, string> {
  const file = path.join(__dirname, '../../.env.local')
  if (!fs.existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
const dotenv = envFromDotLocal()
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? dotenv.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? dotenv.NEXT_PUBLIC_SUPABASE_ANON_KEY

async function adminClient() {
  const client = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: 'ship' },
  })
  const { error } = await client.auth.signInWithPassword(ADMIN)
  if (error) throw error
  return client
}

async function signIn(page: Page, email: string) {
  await page.goto('/')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(ADMIN.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/projects', { timeout: 30_000 })
}

function filterDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Filter' })
}

function columnToggle(page: Page, label: string) {
  return filterDialog(page).getByRole('checkbox', { name: new RegExp(`^${label}`) })
}

test('phasing: a personal filter hides a column, and Reset brings it back', async ({ page }) => {
  await signIn(page, ADMIN.email)
  await page.goto(`/projects/${PROJECT}?tab=phasing`)
  await settle(page)

  const header = page.getByRole('columnheader', { name: 'Discipline', exact: true })
  await expect(header.first()).toBeVisible()
  await expect(page.getByTestId('view-filter-badge')).toHaveCount(0)

  await page.getByTestId('view-filter-button').click()
  // Locked columns are listed but cannot be unticked.
  await expect(columnToggle(page, 'Qty')).toBeDisabled()
  await columnToggle(page, 'Discipline').uncheck()

  await expect(header).toHaveCount(0)
  await expect(page.getByTestId('view-filter-badge')).toHaveText('1')

  // Personal only: it survives a reload in this browser...
  await page.reload()
  await settle(page)
  await expect(header).toHaveCount(0)

  // ...and Reset follows the project default again.
  await page.getByTestId('view-filter-button').click()
  await filterDialog(page).getByRole('button', { name: 'Reset to project default' }).click()
  await expect(header.first()).toBeVisible()
  await expect(page.getByTestId('view-filter-badge')).toHaveCount(0)
})

test('master view: a column the admin hid for everyone cannot be un-hidden by a viewer', async ({
  browser,
}) => {
  const db = await adminClient()
  const { data: before, error } = await db.from('projects').select('view_settings').eq('id', PROJECT).single()
  expect(error).toBeNull()
  const original = before!.view_settings

  const adminContext = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const viewerContext = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  try {
    // Admin hides Category and saves it as the default for everyone.
    const page = await adminContext.newPage()
    await signIn(page, ADMIN.email)
    await page.goto(`/projects/${PROJECT}?tab=master-view`)
    await settle(page)
    const adminHeader = page.getByRole('columnheader', { name: 'Category' })
    await expect(adminHeader).toBeVisible()
    await page.getByTestId('view-filter-button').click()
    await columnToggle(page, 'Category').uncheck()
    await filterDialog(page).getByRole('button', { name: 'Save as default for everyone' }).click()
    // Saved: the personal layer is dropped, so the default now IS the hidden state.
    await expect(filterDialog(page).getByRole('button', { name: 'Reset to project default' })).toHaveCount(0)
    await expect(adminHeader).toHaveCount(0)

    // A viewer sees it hidden, listed as "Hidden by admin", and cannot tick it.
    const viewer = await viewerContext.newPage()
    await signIn(viewer, VIEWER)
    await viewer.goto(`/projects/${PROJECT}?tab=master-view`)
    await settle(viewer)
    await expect(viewer.getByRole('columnheader', { name: 'Category' })).toHaveCount(0)
    await viewer.getByTestId('view-filter-button').click()
    const toggle = columnToggle(viewer, 'Category')
    await expect(toggle).toBeDisabled()
    await expect(toggle).not.toBeChecked()
    await expect(filterDialog(viewer).getByText('Hidden by admin')).toBeVisible()
    // No route to publish a default either.
    await expect(filterDialog(viewer).getByRole('button', { name: /Save as default/ })).toHaveCount(0)

    // "Show all" only touches what the viewer may change.
    await filterDialog(viewer).getByRole('button', { name: /Show all|Hide all/ }).click()
    await expect(viewer.getByRole('columnheader', { name: 'Category' })).toHaveCount(0)
  } finally {
    await adminContext.close()
    await viewerContext.close()
    const { error: restoreError } = await db.rpc('update_project_view_settings', {
      p_project_id: PROJECT,
      p_settings: original,
    })
    expect(restoreError).toBeNull()
  }
})
