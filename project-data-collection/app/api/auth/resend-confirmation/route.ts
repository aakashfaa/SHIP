// "Confirm your email first" -> "Send me the link again".
//
// claim_invite (0013) refuses an account whose email isn't confirmed (hint
// `email_not_confirmed`), because confirmation is the proof of mailbox
// ownership that stops invite hijacking (M-16). Someone can still hold a
// session for such an account (e.g. a project where Supabase confirmations
// are off), and /no-access shows them this button.
//
// Only works for the SIGNED-IN user's own address, so it can't be pointed at
// anyone else. The link is a one-time `magiclink` token-hash link to
// /auth/confirm; verifying it confirms the email, after which claim_invite
// succeeds and they land in /projects.

import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { appBaseUrl, buildConfirmLink, linkExpiryHours } from '@/lib/email/links'
import { checkRateLimit } from '@/lib/email/rate-limit'
import { sendEmail } from '@/lib/email/send'
import { renderConfirmSignupEmail } from '@/lib/email/templates'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.email) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }
  if (user.email_confirmed_at) {
    return NextResponse.json({ ok: true, alreadyConfirmed: true })
  }

  const limit = checkRateLimit(`resend-confirmation:${user.id}`, 3, 15 * 60 * 1000)
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    )
  }

  try {
    const base = appBaseUrl(request.url)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    })
    if (error || !data.properties?.hashed_token) {
      console.error('resend-confirmation: generateLink failed', error)
      return NextResponse.json({ error: "Couldn't create a link. Please try again." }, { status: 500 })
    }
    const link = buildConfirmLink(base, data.properties.hashed_token, 'magiclink')
    const sent = await sendEmail(
      user.email,
      renderConfirmSignupEmail({ link, expiresInHours: linkExpiryHours() })
    )
    if (!sent.ok) {
      return NextResponse.json({ error: "The email didn't send. Please try again." }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('resend-confirmation: unexpected failure', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
