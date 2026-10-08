import { NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/supabase/redirects'

export const runtime = 'nodejs'

// Redirect with a RELATIVE Location. Building it from `request.url` breaks
// locally: Next reports the origin as `localhost` while the browser is on
// 127.0.0.1, so the session cookies we just set (for 127.0.0.1) were not
// sent to the page we redirected to, and the user arrived signed out.
// A relative Location always stays on the host the browser actually used.
function redirectTo(url: URL): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${url.pathname}${url.search}` },
  })
}

// Where every link in every SHIP email lands (M-03):
//   /auth/confirm?token_hash=…&type=invite|signup|recovery|magiclink|email&next=/projects/…
//
// WHY A TOKEN HASH VERIFIED HERE. The old invite links went through
// Supabase's `/verify`, which hands back tokens in the URL fragment (implicit
// flow). `createBrowserClient` from @supabase/ssr is hard-wired to PKCE and
// rejects those, so invitees landed signed-out with no message (MASTER §0.1).
// `verifyOtp({ token_hash, type })` here, on the server, needs no PKCE
// verifier, so it also works when the link is opened in a different browser
// or on a phone — and it writes the session cookies the browser client reads.
//
// After verifying we run claim_invite (turns an allowlisted, now-confirmed
// email into a ship.profiles row; 0013 makes it require email_confirmed_at and
// safe to call twice), then:
//   invite / recovery → /auth/set-password  (they have no password yet, or
//                                            asked to change it)
//   everything else   → `next`, else /projects (or /no-access if no profile)
//
// A dead link (expired, already used — including by a mail scanner that
// pre-clicks links — or mangled) goes to the sign-in page with
// ?auth_error=link_expired|link_invalid, which LoginForm turns into a banner,
// instead of silently dumping the user on a sign-in form (UX-5).

const OTP_TYPES: readonly EmailOtpType[] = [
  'invite',
  'signup',
  'recovery',
  'magiclink',
  'email',
  'email_change',
]

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value)
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const next = safeNextPath(searchParams.get('next'))

  const fail = (code: 'link_expired' | 'link_invalid') => {
    const url = new URL('/', origin)
    url.searchParams.set('auth_error', code)
    if (next) url.searchParams.set('next', next)
    return redirectTo(url)
  }

  if (!tokenHash || !isOtpType(type)) return fail('link_invalid')

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })

  if (error || !data.session) {
    const code = (error as { code?: string } | null)?.code
    // GoTrue reports both "expired" and "already used" as otp_expired (the
    // token row is gone either way); a 403 with no code means the same.
    return fail(code === 'otp_expired' || error?.status === 403 ? 'link_expired' : 'link_invalid')
  }

  // 42501 = not on the allowlist. Not fatal here: a recovery link for an
  // existing SHIP user already has a profile, and an outsider simply ends up
  // on /no-access below.
  const { error: claimError } = await supabase.rpc('claim_invite')
  if (claimError && claimError.code !== '42501') {
    console.error('claim_invite failed in /auth/confirm:', claimError)
  }

  if (type === 'invite' || type === 'recovery') {
    const url = new URL('/auth/set-password', origin)
    if (type === 'invite') url.searchParams.set('welcome', '1')
    if (next) url.searchParams.set('next', next)
    return redirectTo(url)
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', data.session.user.id)
    .maybeSingle()

  if (!profile) return redirectTo(new URL('/no-access', origin))
  return redirectTo(new URL(next ?? '/projects', origin))
}
