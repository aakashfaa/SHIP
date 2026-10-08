// "Forgot password?" (M-17). Emails a one-time /auth/confirm?type=recovery
// link that signs the person in once and takes them to /auth/set-password.
//
// Replaces nothing — there was no reset path at all, so a forgotten password
// was permanent lock-out. We use `generateLink({ type: 'recovery' })` and our
// own email rather than the client's `resetPasswordForEmail`, because the
// latter makes Supabase send the mail (D-6).
//
// The response is ALWAYS the same neutral sentence, whether or not the
// address has an account or is a SHIP user, so the form can't be used to
// probe the shared auth pool. We only actually send to SHIP-known addresses
// (see lib/email/allowlist.ts for why).

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { safeNextPath } from '@/lib/supabase/redirects'
import { isKnownShipEmail } from '@/lib/email/allowlist'
import {
  appBaseUrl,
  buildConfirmLink,
  isPlausibleEmail,
  linkExpiryHours,
  normalizeEmail,
} from '@/lib/email/links'
import { checkRateLimit, clientIpFromHeaders } from '@/lib/email/rate-limit'
import { sendEmail } from '@/lib/email/send'
import { renderResetPasswordEmail } from '@/lib/email/templates'

export const runtime = 'nodejs'

const NEUTRAL_MESSAGE =
  "If that email has an account here, a link to reset the password is on its way. " +
  "It can take a minute or two to arrive; check your spam folder too."

const WINDOW_MS = 15 * 60 * 1000

export async function POST(request: NextRequest) {
  let body: { email?: unknown; next?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = normalizeEmail(body.email)
  if (!isPlausibleEmail(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }
  const next = safeNextPath(body.next)

  const ip = clientIpFromHeaders(request.headers)
  const byIp = checkRateLimit(`forgot:ip:${ip}`, 10, WINDOW_MS)
  const byEmail = byIp.ok ? checkRateLimit(`forgot:email:${email}`, 3, WINDOW_MS) : byIp
  if (!byIp.ok || !byEmail.ok) {
    const retry = !byIp.ok ? byIp.retryAfterSeconds : !byEmail.ok ? byEmail.retryAfterSeconds : 60
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(retry) } }
    )
  }

  let base: string
  try {
    base = appBaseUrl(request.url)
  } catch (err) {
    console.error('forgot:', err)
    return NextResponse.json({ error: 'Password reset is not available right now.' }, { status: 503 })
  }

  try {
    const admin = getSupabaseAdminClient()
    if (await isKnownShipEmail(admin, email)) {
      const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email })
      if (!error && data.properties?.hashed_token) {
        const link = buildConfirmLink(base, data.properties.hashed_token, 'recovery', next)
        const sent = await sendEmail(
          email,
          renderResetPasswordEmail({ link, expiresInHours: linkExpiryHours() })
        )
        if (!sent.ok) console.error('forgot: reset email failed', sent.error)
      } else if (error && (error as { code?: string }).code !== 'user_not_found') {
        // user_not_found = invited but never set up; nothing to reset. Their
        // admin's "Resend invite" is the right path for them.
        console.error('forgot: generateLink(recovery) failed', error)
      }
    }
  } catch (err) {
    console.error('forgot: unexpected failure', err)
  }

  return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE })
}
