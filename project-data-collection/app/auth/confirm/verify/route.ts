import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/supabase/redirects'
import { markPasswordSet } from '@/lib/supabase/needs-password'
import {
  isOtpType,
  isPasswordLinkType,
  isSetupFlag,
  validateNewPassword,
  type PasswordLinkError,
} from '@/lib/supabase/email-confirm'

export const runtime = 'nodejs'

// Redirect with a RELATIVE Location. Building it from `request.url` breaks
// locally: Next reports the origin as `localhost` while the browser is on
// 127.0.0.1, so the session cookies we just set (for 127.0.0.1) were not
// sent to the page we redirected to, and the user arrived signed out.
// A relative Location always stays on the host the browser actually used.
function redirectTo(url: URL): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${url.pathname}${url.search}`, 'Referrer-Policy': 'no-referrer' },
  })
}

// Uses an email link. Reached ONLY by a form POST from /auth/confirm (the
// emailed link is a GET of that page, which uses nothing, so a mail scanner
// that pre-opens links no longer burns the one-time token; see
// lib/supabase/email-confirm.ts).
//
// INVITE / RECOVERY (the "Choose a password" form: token_hash, type, next,
// setup, password, confirm_password):
//   1. The password is checked FIRST. Too short / too long / mismatch goes
//      back to the form with the token untouched, so a typo can't burn it.
//   2. verifyOtp uses the token and signs them in on this browser.
//   3. updateUser sets the password on that session, in the same request.
//   4. claim_invite (creates the ship.profiles row for a new invitee) and
//      mark_password_set (migration 0035), then 303 to `next` or /projects.
//   A dead token goes back to the form page with ?error=link_expired, which
//   offers a new link. If GoTrue rejects the password AFTER the token was
//   used (e.g. a leaked-password check), they are signed in, so they go on
//   to /auth/set-password to pick another one.
//
// OTHER TYPES (the Continue button: token_hash, type, next): verifyOtp,
// claim_invite, then `next` / /projects / /no-access. A dead link goes to
// the sign-in page with ?auth_error=, which LoginForm turns into a banner.
//
// WHY A TOKEN HASH VERIFIED HERE. Supabase's own `/verify` hands back tokens
// in the URL fragment (implicit flow), which our PKCE-only browser client
// rejects (MASTER §0.1). `verifyOtp({ token_hash, type })` on the server
// needs no PKCE verifier, works in any browser, and writes the session
// cookies the browser client reads.

function field(form: FormData | null, name: string): string | null {
  const value = form?.get(name)
  return typeof value === 'string' ? value : null
}

function deadLinkCode(error: { code?: string; status?: number } | null): 'link_expired' | 'link_invalid' {
  // GoTrue reports both "expired" and "already used" as otp_expired (the
  // token row is gone either way); a 403 with no code means the same.
  return error?.code === 'otp_expired' || error?.status === 403 ? 'link_expired' : 'link_invalid'
}

export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url)
  const form = await request.formData().catch(() => null)
  const tokenHash = field(form, 'token_hash')
  const type = field(form, 'type')
  const next = safeNextPath(field(form, 'next'))

  if (isPasswordLinkType(type) && tokenHash) {
    return finishPasswordLink(origin, {
      tokenHash,
      type,
      next,
      setup: isSetupFlag(field(form, 'setup')),
      password: field(form, 'password'),
      confirm: field(form, 'confirm_password'),
    })
  }

  const fail = (code: 'link_expired' | 'link_invalid') => {
    const url = new URL('/', origin)
    url.searchParams.set('auth_error', code)
    if (next) url.searchParams.set('next', next)
    return redirectTo(url)
  }

  if (!tokenHash || !isOtpType(type)) return fail('link_invalid')

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })

  if (error || !data.session) return fail(deadLinkCode(error))

  // 42501 = not on the allowlist. Not fatal: an outsider simply ends up on
  // /no-access below.
  const { error: claimError } = await supabase.rpc('claim_invite')
  if (claimError && claimError.code !== '42501') {
    console.error('claim_invite failed in /auth/confirm/verify:', claimError)
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', data.session.user.id)
    .maybeSingle()

  if (!profile) return redirectTo(new URL('/no-access', origin))
  return redirectTo(new URL(next ?? '/projects', origin))
}

async function finishPasswordLink(
  origin: string,
  input: {
    tokenHash: string
    type: 'invite' | 'recovery'
    next: string | null
    setup: boolean
    password: string | null
    confirm: string | null
  }
): Promise<NextResponse> {
  const { tokenHash, type, next, setup } = input

  // Back to the form. `keepToken` false = the link is dead; the page then
  // offers a new one instead of password fields.
  const backToForm = (error: PasswordLinkError, keepToken: boolean) => {
    const url = new URL('/auth/confirm', origin)
    if (keepToken) url.searchParams.set('token_hash', tokenHash)
    url.searchParams.set('type', type)
    if (next) url.searchParams.set('next', next)
    if (setup) url.searchParams.set('setup', '1')
    url.searchParams.set('error', error)
    return redirectTo(url)
  }

  // 1. Before the token is touched.
  const problem = validateNewPassword(input.password, input.confirm)
  if (problem) return backToForm(problem, true)
  const password = input.password as string

  // 2. Use the token.
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
  if (error || !data.session) return backToForm(deadLinkCode(error), false)

  // 3. Set the password on the session verifyOtp just created.
  const { error: updateError } = await supabase.auth.updateUser({ password })
  // same_password: a reset to the password they already had. They know it;
  // nothing to change.
  if (updateError && (updateError as { code?: string }).code !== 'same_password') {
    console.error('/auth/confirm/verify: updateUser failed', updateError)
    // Signed in, token used: let them pick another password there.
    const url = new URL('/auth/set-password', origin)
    if (type === 'invite') url.searchParams.set('welcome', '1')
    if (setup) url.searchParams.set('setup', '1')
    url.searchParams.set('error', (updateError as { code?: string }).code === 'weak_password' ? 'weak_password' : 'save_failed')
    if (next) url.searchParams.set('next', next)
    return redirectTo(url)
  }

  // 4. Profile (a new invitee has none yet) and the password stamp.
  const { error: claimError } = await supabase.rpc('claim_invite')
  if (claimError && claimError.code !== '42501') {
    console.error('claim_invite failed in /auth/confirm/verify:', claimError)
  }
  await markPasswordSet(supabase, '/auth/confirm/verify')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', data.session.user.id)
    .maybeSingle()
  if (!profile) return redirectTo(new URL('/no-access', origin))
  return redirectTo(new URL(next ?? '/projects', origin))
}
