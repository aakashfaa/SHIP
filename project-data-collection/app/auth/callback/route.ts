import { NextRequest, NextResponse } from 'next/server'
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

// LEGACY. Every email SHIP sends now links to /auth/confirm (token-hash
// flow, see that route). This PKCE `?code=` handler is kept only so links
// issued before that change, or any future OAuth provider, still resolve.
//
// What changed (UX-5): a missing or failed code used to redirect to a bare
// `/`, so an expired or already-used link looked exactly like "nothing
// happened". It now lands on the sign-in page with ?auth_error=, which shows
// a banner explaining what to do.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNextPath(searchParams.get('next'))

  const fail = (reason: 'link_expired' | 'link_invalid') => {
    const url = new URL('/', origin)
    url.searchParams.set('auth_error', reason)
    if (next) url.searchParams.set('next', next)
    return redirectTo(url)
  }

  if (!code) {
    // Supabase reports a dead link as ?error=…&error_code=otp_expired.
    return fail(searchParams.get('error_code') === 'otp_expired' ? 'link_expired' : 'link_invalid')
  }

  const supabase = await createSupabaseServerClient()
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

  if (exchangeError) {
    return fail('link_expired')
  }

  // A 42501 here just means there's no matching pending_invites row for
  // this email — the profile check below decides where they go.
  const { error: claimError } = await supabase.rpc('claim_invite')
  if (claimError && claimError.code !== '42501') {
    console.error('claim_invite failed in auth callback:', claimError)
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle()

    if (profile) {
      return redirectTo(new URL(next ?? '/projects', origin))
    }
  }

  return redirectTo(new URL('/no-access', origin))
}
