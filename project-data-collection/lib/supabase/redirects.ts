/**
 * `?next=` handling, shared by the sign-in form, the email-link handler
 * (`app/auth/confirm/route.ts`), the set-password page and the project page's
 * signed-out redirect.
 *
 * WHY THIS IS STRICT. `next` arrives from a URL anyone can craft, and we
 * navigate to it right after a successful sign-in — the exact moment a user
 * trusts whatever appears next. Accepting `https://evil.example/login` (or the
 * sneakier `//evil.example`, `/\evil.example`, `\/evil.example`, which browsers
 * normalise into a different host) would turn our sign-in page into a phishing
 * relay. So only a same-origin, root-relative path is ever returned; anything
 * else is `null` and the caller falls back to its normal destination.
 *
 * Pure (no Next, no Supabase) so it runs in client components, route handlers
 * and `node --test` alike. See `tests/unit/ws2-auth-helpers.test.ts`.
 */

const SENTINEL_ORIGIN = 'http://ship.invalid'

export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length === 0 || value.length > 2048) return null

  // Root-relative only. `//host` is protocol-relative (another site), and a
  // backslash anywhere is treated as `/` by browsers, so `/\host` is too.
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('\\')) return null
  // Control characters (tabs/newlines are stripped by the URL parser, which
  // is how `/\t/evil.example` sneaks through naive checks).
  if (/[\u0000-\u001f\u007f]/.test(value)) return null

  let parsed: URL
  try {
    parsed = new URL(value, SENTINEL_ORIGIN)
  } catch {
    return null
  }
  if (parsed.origin !== SENTINEL_ORIGIN) return null

  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

/**
 * The `?auth_error=` codes the sign-in page knows how to explain. Anything
 * else in the URL is ignored rather than echoed, so the banner can never be
 * used to paint attacker-chosen text onto our sign-in page.
 */
export type AuthErrorCode = 'link_expired' | 'link_invalid' | 'session_expired'

export function readAuthErrorCode(raw: unknown): AuthErrorCode | null {
  return raw === 'link_expired' || raw === 'link_invalid' || raw === 'session_expired'
    ? raw
    : null
}

/**
 * Supabase's own `/verify` endpoint reports a dead link in the URL *fragment*
 * (`#error=access_denied&error_code=otp_expired&…`). We no longer send links
 * that go through it, but links already sitting in inboxes from before this
 * change still do, so `/` maps that fragment onto the same banner.
 */
export function authErrorFromHash(hash: string): AuthErrorCode | null {
  if (!hash || hash.length < 2) return null
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const code = params.get('error_code')
  if (code === 'otp_expired') return 'link_expired'
  if (params.get('error') || code) return 'link_invalid'
  return null
}
