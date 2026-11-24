// Server-side sign-up. Replaces the browser's `supabase.auth.signUp`, which
// made Supabase send its own confirmation email (D-6: every auth email is
// ours, sent through Resend).
//
// SIGN-UP IS OPEN (owner decision 2026-11-24, migration 0035). Anyone may
// create an account; claim_invite gives a confirmed, uninvited user a plain
// consultant profile that sees no projects until an admin adds them to a
// roster.
//
// What it does, in order:
//   1. Validates the input and rate-limits per IP and per email address.
//   2. `generateLink({ type: 'signup', password })`:
//      a. New address -> creates an UNCONFIRMED account and we email a
//         /auth/confirm link. Nobody gets a session until they click it,
//         which is what stops the invite hijack in M-16: claim_invite (0013,
//         0035) only grants a profile to a confirmed email.
//      b. The account already exists (`email_exists`) -> we email a "you
//         already have an account" message with a password-reset link, but
//         ONLY if the address is one SHIP knows (pending_invites or
//         ship.profiles, see isKnownShipEmail). auth.users is shared with an
//         unrelated production app; a stranger typing one of ITS users'
//         addresses here must not make us mail that person a reset link.
//
// THE RESPONSE IS THE SAME IN EVERY CASE ("check your email"). A sign-up
// form that answers "already registered" is an oracle for the other app's
// user list (SEC-8). The only non-neutral answers are input errors (bad email
// format, short or weak password) and the rate limit, none of which depend on
// whether an account exists.

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { safeNextPath } from '@/lib/supabase/redirects'
import { isKnownShipEmail } from '@/lib/email/allowlist'
import {
  appBaseUrl,
  buildConfirmLink,
  isEmailExistsError,
  isPlausibleEmail,
  linkExpiryHours,
  normalizeEmail,
} from '@/lib/email/links'
import { checkRateLimit, clientIpFromHeaders } from '@/lib/email/rate-limit'
import { sendEmail } from '@/lib/email/send'
import { renderConfirmSignupEmail, renderResetPasswordEmail } from '@/lib/email/templates'

export const runtime = 'nodejs'

const NEUTRAL_MESSAGE =
  "Check your email: we've sent a link to finish setting up your account. " +
  "It can take a minute or two to arrive; check your spam folder too."

const WINDOW_MS = 15 * 60 * 1000
const MIN_PASSWORD = 8
const MAX_PASSWORD = 72 // bcrypt ignores anything past 72 bytes

export async function POST(request: NextRequest) {
  let body: { email?: unknown; password?: unknown; next?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = normalizeEmail(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  const next = safeNextPath(body.next)

  if (!isPlausibleEmail(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD} characters.` },
      { status: 400 }
    )
  }
  if (password.length > MAX_PASSWORD) {
    return NextResponse.json(
      { error: `Password must be at most ${MAX_PASSWORD} characters.` },
      { status: 400 }
    )
  }

  const ip = clientIpFromHeaders(request.headers)
  const byIp = checkRateLimit(`sign-up:ip:${ip}`, 10, WINDOW_MS)
  const byEmail = byIp.ok ? checkRateLimit(`sign-up:email:${email}`, 3, WINDOW_MS) : byIp
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
    console.error('sign-up:', err)
    return NextResponse.json({ error: 'Sign-up is not available right now.' }, { status: 503 })
  }

  const admin = getSupabaseAdminClient()
  const hours = linkExpiryHours()

  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'signup',
      email,
      password,
    })

    if (!error && data.properties?.hashed_token) {
      const link = buildConfirmLink(base, data.properties.hashed_token, 'signup', next)
      const sent = await sendEmail(email, renderConfirmSignupEmail({ link, expiresInHours: hours }))
      if (!sent.ok) console.error('sign-up: confirmation email failed', sent.error)
    } else if (isEmailExistsError(error)) {
      // Existing account. Only mail SHIP's own people (see the header).
      if (!(await isKnownShipEmail(admin, email))) {
        return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE })
      }
      const recovery = await admin.auth.admin.generateLink({ type: 'recovery', email })
      if (!recovery.error && recovery.data.properties?.hashed_token) {
        const link = buildConfirmLink(base, recovery.data.properties.hashed_token, 'recovery', next)
        const sent = await sendEmail(
          email,
          renderResetPasswordEmail({ link, existingAccountOnSignUp: true, expiresInHours: hours })
        )
        if (!sent.ok) console.error('sign-up: existing-account email failed', sent.error)
      } else {
        console.error('sign-up: recovery link for existing account failed', recovery.error)
      }
    } else if (error && (error as { code?: string }).code === 'weak_password') {
      // Depends only on the password, never on the account, so safe to say.
      return NextResponse.json(
        { error: 'That password is too weak. Try a longer one.' },
        { status: 400 }
      )
    } else {
      console.error('sign-up: generateLink(signup) failed', error)
    }
  } catch (err) {
    // Still neutral: a failure here must not look different from success to
    // the person typing, or the timing/text becomes the oracle.
    console.error('sign-up: unexpected failure', err)
  }

  return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE })
}
