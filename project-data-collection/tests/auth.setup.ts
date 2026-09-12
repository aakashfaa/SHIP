import { test as setup, expect } from '@playwright/test'
import path from 'node:path'

/**
 * Signs in once per run and freezes the session to disk for the `app` project
 * to reuse as `storageState`.
 *
 * This runs as a real test (a setup *project*, not `globalSetup`) so that when
 * auth breaks it produces a trace and an HTML report entry instead of an opaque
 * stack in the runner's stdout.
 *
 * It signs in through the actual UI rather than minting a session against
 * GoTrue directly. That is slower, but it is also the only version of this that
 * exercises `ship.claim_invite()` — the RPC that turns an `auth.users` row into
 * a `ship.profiles` row. A user who can authenticate but has no profile sees an
 * empty app, so "can log in" and "is a SHIP user" are genuinely different
 * assertions and the setup should prove the second one.
 */

const ADMIN_STATE = path.join(__dirname, '../playwright/.auth/admin.json')

setup('authenticate as admin', async ({ page }) => {
  await page.goto('/')

  await page.getByLabel(/email/i).fill('admin@gmail.com')
  await page.getByLabel(/password/i).fill('localdev123')
  await page.getByRole('button', { name: /sign in/i }).click()

  // Landing on /projects is the proof that claim_invite() minted a profile.
  // /no-access is the failure mode where auth succeeded but membership did not.
  await page.waitForURL('**/projects', { timeout: 30_000 })

  // A project card is the real proof: RLS returns rows only to a user who has a
  // ship.profiles row, so an empty list here would mean claim_invite() did not
  // fire even though the redirect succeeded.
  await expect(page.getByRole('link', { name: /Federal Campus Master Plan/i })).toBeVisible({
    timeout: 20_000,
  })

  const state = await page.context().storageState({ path: ADMIN_STATE })

  // Supabase's @supabase/ssr writes the session to a cookie (chunked as
  // `.0`/`.1` past ~3180 bytes) while the browser client also keeps it in
  // localStorage under the same key. An SSR + client-component app needs both:
  // cookies alone and the client renders logged-out on first paint; localStorage
  // alone and the server does. Assert we captured at least one before freezing.
  const hasSession =
    state.cookies.some((c) => c.name.startsWith('sb-')) ||
    state.origins.some((o) => o.localStorage.some((i) => i.name.startsWith('sb-')))

  expect(hasSession, 'no Supabase session was captured into storageState').toBe(true)
})
