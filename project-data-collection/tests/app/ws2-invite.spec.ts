import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * End-to-end auth email flows (WS-2: M-02, M-03, M-16, M-17, M-29, M-31,
 * D-6, D-7), against the LOCAL Supabase stack and its Mailpit.
 *
 * With RESEND_API_KEY unset, lib/email/send.ts delivers every email to
 * Mailpit's HTTP API, so these tests read the real email back from
 * http://127.0.0.1:55424 and click the real link:
 *
 *   1. Settings invites a brand-new address -> the email's link opens
 *      /auth/set-password -> choosing a password lands in the project.
 *      Opening the same link again shows the "expired or already used"
 *      banner on the sign-in page.
 *   2. Inviting someone who already has an account returns no link to the
 *      admin, the email carries no token, and that person sees a
 *      "You've been added to <Project>" toast when they sign in.
 *   3. Forgot password round trip, plus the neutral answer for an unknown
 *      address (no email sent).
 *
 * Every user, invite row and notice created here is removed in afterAll.
 * Each test signs in explicitly, so it ignores the project's admin
 * storageState.
 */

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:55424'
const PROJECT_ID = 'federal-campus-master-plan'
const PROJECT_NAME = 'Federal Campus Master Plan'
const ADMIN = { email: 'admin@gmail.com', password: 'localdev123' }
// On the federal project (project_roles: consultant), so the toast can
// resolve the project name through RLS.
const EXISTING = { email: 'consultant1@gmail.com', password: 'localdev123' }

const RUN = Date.now().toString(36)
const NEW_EMAIL = `ws2-invitee-${RUN}@example.com`
const UNKNOWN_EMAIL = `ws2-nobody-${RUN}@example.com`
const FIRST_PASSWORD = 'first-pass-123'
const SECOND_PASSWORD = 'second-pass-456'

// ---------------------------------------------------------------------------
// env: Playwright doesn't load .env.local, so read the two values we need.
// ---------------------------------------------------------------------------
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
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? dotenv.SUPABASE_SERVICE_ROLE_KEY

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let admin: SupabaseClient<any, 'ship'>

// ---------------------------------------------------------------------------
// Mailpit helpers
// ---------------------------------------------------------------------------
type MailSummary = { ID: string; Subject: string; Created: string }

async function listMail(to: string): Promise<MailSummary[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`)
  const body = (await res.json()) as { messages?: MailSummary[] }
  return body.messages ?? []
}

/** Waits for a NEW message to `to` (beyond `seen` ids) and returns its bodies. */
async function waitForMail(
  to: string,
  seen: Set<string>,
  subject?: RegExp
): Promise<{ id: string; subject: string; html: string; text: string }> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const fresh = (await listMail(to)).filter(
      (m) => !seen.has(m.ID) && (!subject || subject.test(m.Subject))
    )
    if (fresh.length > 0) {
      const msg = fresh[0]
      seen.add(msg.ID)
      const res = await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)
      const body = (await res.json()) as { HTML: string; Text: string; Subject: string }
      return { id: msg.ID, subject: body.Subject, html: body.HTML, text: body.Text }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`No email to ${to} arrived within 20s`)
}

async function seenIds(to: string): Promise<Set<string>> {
  return new Set((await listMail(to)).map((m) => m.ID))
}

function confirmLinkFrom(text: string): string {
  const match = text.match(/https?:\/\/\S+\/auth\/confirm\?\S+/)
  if (!match) throw new Error(`No /auth/confirm link in email:\n${text}`)
  return match[0]
}

/** Our links are built from APP_URL or the request origin; point them at
 *  whatever server this run uses so the test doesn't depend on APP_URL. */
function onThisServer(link: string, baseURL: string): string {
  const url = new URL(link)
  const base = new URL(baseURL)
  url.protocol = base.protocol
  url.host = base.host
  return url.toString()
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
async function signIn(page: Page, email: string, password: string) {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
}

async function freshPage(context: BrowserContext): Promise<Page> {
  return context.newPage()
}

// ---------------------------------------------------------------------------
// Setup / cleanup
// ---------------------------------------------------------------------------
test.beforeAll(async () => {
  expect(SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL').toBeTruthy()
  expect(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY').toBeTruthy()
  admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: 'ship' },
  })
})

test.afterAll(async () => {
  if (!admin) return
  // Restore the roster as the admin user (update_project is the only way to
  // edit it and needs a signed-in caller).
  const userClient = createClient(SUPABASE_URL!, (dotenv.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: 'ship' },
  })
  await userClient.auth.signInWithPassword(ADMIN)
  const { data: project } = await userClient.from('projects').select('id, name').eq('id', PROJECT_ID).maybeSingle()
  const { data: teams } = await userClient
    .from('project_consultants')
    .select('consultant_type, org_name')
    .eq('project_id', PROJECT_ID)
  const { data: members } = await userClient
    .from('project_members')
    .select('email, consultant_type')
    .eq('project_id', PROJECT_ID)
  if (project && teams && members && members.some((m: { email: string }) => m.email === NEW_EMAIL)) {
    // Rebuild the consultants payload update_project expects from the live
    // rows, minus the address this spec added.
    const payload = (teams as { consultant_type: string; org_name: string }[]).map((t) => ({
      type: t.consultant_type,
      orgName: t.org_name,
      emails: (members as { email: string; consultant_type: string }[])
        .filter((m) => m.consultant_type === t.consultant_type && m.email !== NEW_EMAIL)
        .map((m) => m.email),
    }))
    const { error } = await userClient.rpc('update_project', {
      p_project_id: PROJECT_ID,
      p_name: (project as { name: string }).name,
      p_consultants: payload,
    })
    if (error) console.warn('ws2 cleanup: roster restore failed', error)
  }
  await userClient.auth.signOut()

  // Users we created.
  for (const email of [NEW_EMAIL, UNKNOWN_EMAIL]) {
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const user = list?.users.find((u) => u.email === email)
    if (user) {
      await admin.from('profiles').delete().eq('id', user.id)
      await admin.auth.admin.deleteUser(user.id)
    }
  }
  await admin.from('pending_invites').delete().in('email', [NEW_EMAIL, UNKNOWN_EMAIL])
  await admin.from('project_access_notices').delete().in('email', [NEW_EMAIL, EXISTING.email])
})

// ---------------------------------------------------------------------------
// 1. New invitee: Settings -> email -> set password -> in the project.
// ---------------------------------------------------------------------------
test('a new invitee gets an email, sets a password and lands in the project; the link then reports expired', async ({
  browser,
  baseURL,
}) => {
  const adminContext = await browser.newContext()
  const page = await freshPage(adminContext)
  await signIn(page, ADMIN.email, ADMIN.password)
  await page.waitForURL('**/projects')

  await page.goto(`/projects/${PROJECT_ID}?tab=settings`)
  // Settings -> Consultants (+) opens the "Add consultants" popup. Picking a
  // discipline that already has an organization (Architecture) merges the
  // new people into it.
  await page.getByRole('button', { name: 'Add consultants', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add consultants' })
  await dialog.getByLabel('Discipline').selectOption('Architecture')
  const box = dialog.getByLabel('Email 1', { exact: true })

  // M-22: a malformed address is refused -- the popup stays open with an
  // inline error and nothing reaches the roster or the mailer.
  await box.fill('not-an-email')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog.getByText(/doesn't look like an email address/)).toBeVisible()
  await expect(dialog).toBeVisible()

  const before = await seenIds(NEW_EMAIL)
  await box.fill(NEW_EMAIL)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByLabel('Consultants').getByText(NEW_EMAIL)).toBeVisible()

  const result = page.getByTestId('invite-result').filter({ hasText: NEW_EMAIL })
  await expect(result).toContainText('Invite emailed', { timeout: 20_000 })
  // Brand-new account created by this invite -> copy link allowed.
  await expect(result.getByRole('button', { name: 'Copy set-up link' })).toBeVisible()

  const mail = await waitForMail(NEW_EMAIL, before, /invited/i)
  expect(mail.subject).toContain(PROJECT_NAME)
  const link = onThisServer(confirmLinkFrom(mail.text), baseURL!)
  expect(new URL(link).searchParams.get('type')).toBe('invite')
  await adminContext.close()

  // The invitee, in a clean browser.
  const inviteeContext = await browser.newContext()
  const invitee = await freshPage(inviteeContext)
  await invitee.goto(link)
  await invitee.waitForURL('**/auth/set-password**')
  await expect(invitee.getByRole('heading', { name: /choose a password/i })).toBeVisible()
  await invitee.getByLabel('New password').fill('short')
  await invitee.getByLabel('Confirm password').fill('short')
  await invitee.getByRole('button', { name: /save password/i }).click()
  await expect(invitee.getByText(/at least 8 characters/)).toBeVisible()

  await invitee.getByLabel('New password').fill(FIRST_PASSWORD)
  await invitee.getByLabel('Confirm password').fill(FIRST_PASSWORD)
  await invitee.getByRole('button', { name: /save password/i }).click()
  await invitee.waitForURL(`**/projects/${PROJECT_ID}**`, { timeout: 30_000 })
  await expect(invitee.getByText(PROJECT_NAME).first()).toBeVisible({ timeout: 20_000 })
  await inviteeContext.close()

  // The same link again: used -> banner on the sign-in page (M-03 / UX-5).
  const againContext = await browser.newContext()
  const again = await freshPage(againContext)
  await again.goto(link)
  await again.waitForURL((url) => url.pathname === '/')
  await expect(again.getByTestId('auth-error-banner')).toContainText(/expired or has already been used/)
  await againContext.close()
})

// ---------------------------------------------------------------------------
// 2. Existing account: no token anywhere, toast on sign-in (M-02, D-7).
// ---------------------------------------------------------------------------
test('inviting an existing account sends a token-free email and shows a toast on sign-in', async ({
  browser,
}) => {
  await admin.from('project_access_notices').delete().eq('email', EXISTING.email)

  const adminContext = await browser.newContext()
  const page = await freshPage(adminContext)
  await signIn(page, ADMIN.email, ADMIN.password)
  await page.waitForURL('**/projects')

  const before = await seenIds(EXISTING.email)
  const res = await page.request.post('/api/admin/invite', {
    data: { emails: [EXISTING.email, 'not-an-email'], projectId: PROJECT_ID },
  })
  expect(res.status()).toBe(200)
  const { results } = (await res.json()) as {
    results: { email: string; status: string; actionLink: string | null; error: string | null }[]
  }
  const existing = results.find((r) => r.email === EXISTING.email)!
  expect(existing.status).toBe('added')
  expect(existing.actionLink).toBeNull() // never a bearer link for an existing account
  // M-22 / M-29: a bad address fails alone, the batch still succeeds.
  expect(results.find((r) => r.email === 'not-an-email')?.status).toBe('failed')
  await adminContext.close()

  const mail = await waitForMail(EXISTING.email, before, /added to/i)
  expect(mail.subject).toContain(PROJECT_NAME)
  expect(mail.text).not.toMatch(/token|auth\/confirm/)
  expect(mail.html).not.toMatch(/token_hash|auth\/confirm/)
  expect(mail.text).toContain(`next=${encodeURIComponent(`/projects/${PROJECT_ID}`)}`)

  const userContext = await browser.newContext()
  const user = await freshPage(userContext)
  await signIn(user, EXISTING.email, EXISTING.password)
  await expect(user.getByTestId('access-notice')).toContainText(`You've been added to ${PROJECT_NAME}`, {
    timeout: 20_000,
  })
  await userContext.close()

  const { data: notices } = await admin
    .from('project_access_notices')
    .select('seen_at')
    .eq('email', EXISTING.email)
  expect(notices?.every((n: { seen_at: string | null }) => n.seen_at !== null)).toBe(true)
})

// ---------------------------------------------------------------------------
// 3. Forgot password (M-17).
// ---------------------------------------------------------------------------
test('forgot password emails a reset link that sets a new password; unknown emails get the same answer and no mail', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext()
  const page = await freshPage(context)

  // Unknown address: neutral answer, nothing sent.
  await page.goto('/')
  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await page.waitForURL('**/auth/forgot**')
  await page.getByLabel('Email').fill(UNKNOWN_EMAIL)
  await page.getByRole('button', { name: /send reset link/i }).click()
  await expect(page.getByRole('status')).toContainText(/If that email has an account here/)
  await new Promise((r) => setTimeout(r, 1500))
  expect(await listMail(UNKNOWN_EMAIL)).toHaveLength(0)

  // The invitee from test 1.
  const before = await seenIds(NEW_EMAIL)
  await page.goto(`/auth/forgot?email=${encodeURIComponent(NEW_EMAIL)}`)
  await expect(page.getByLabel('Email')).toHaveValue(NEW_EMAIL)
  await page.getByRole('button', { name: /send reset link/i }).click()
  await expect(page.getByRole('status')).toContainText(/If that email has an account here/)

  const mail = await waitForMail(NEW_EMAIL, before, /reset/i)
  const link = onThisServer(confirmLinkFrom(mail.text), baseURL!)
  expect(new URL(link).searchParams.get('type')).toBe('recovery')

  await page.goto(link)
  await page.waitForURL('**/auth/set-password**')
  await page.getByLabel('New password').fill(SECOND_PASSWORD)
  await page.getByLabel('Confirm password').fill(SECOND_PASSWORD)
  await page.getByRole('button', { name: /save password/i }).click()
  await page.waitForURL('**/projects', { timeout: 30_000 })
  await context.close()

  // New password works, old one doesn't.
  const check = await browser.newContext()
  const p2 = await freshPage(check)
  await signIn(p2, NEW_EMAIL, FIRST_PASSWORD)
  await expect(p2.getByText(/email and password don't match/)).toBeVisible()
  await p2.getByLabel('Password', { exact: true }).fill(SECOND_PASSWORD)
  await p2.getByRole('button', { name: /^sign in$/i }).click()
  await p2.waitForURL('**/projects', { timeout: 30_000 })
  await check.close()
})

// ---------------------------------------------------------------------------
// 4. A mangled link -> "didn't work" banner; ?next= is restricted.
// ---------------------------------------------------------------------------
test('a bad link shows the banner, and ?next= only accepts same-origin paths', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await freshPage(context)
  await page.goto('/auth/confirm?token_hash=nope&type=invite')
  await page.waitForURL((url) => url.pathname === '/')
  await expect(page.getByTestId('auth-error-banner')).toBeVisible()

  // An off-site next is ignored: after sign-in we land on /projects.
  await page.goto('/?next=https://evil.example/')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL('**/projects', { timeout: 30_000 })
  await context.close()

  // A same-origin next is honoured.
  const c2 = await browser.newContext()
  const p2 = await freshPage(c2)
  await p2.goto(`/?next=${encodeURIComponent(`/projects/${PROJECT_ID}`)}`)
  await p2.getByLabel('Email').fill(ADMIN.email)
  await p2.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await p2.getByRole('button', { name: /^sign in$/i }).click()
  await p2.waitForURL(`**/projects/${PROJECT_ID}**`, { timeout: 30_000 })
  await c2.close()
})
