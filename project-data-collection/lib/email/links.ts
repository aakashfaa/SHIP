/**
 * Building the URLs that go into emails.
 *
 * WHY APP_URL AND NOT THE REQUEST'S HOST. The forgot-password and sign-up
 * routes are reachable by anyone. If we built the link from the incoming
 * request's Host header, an attacker could send `Host: evil.example` with a
 * victim's email address, and the victim would receive a genuine reset email
 * from us whose link carries a live token to the attacker's site ("password
 * reset poisoning"). So in production the base URL comes only from the
 * `APP_URL` env var. Locally (no APP_URL) we fall back to the request origin,
 * which is what a developer on 127.0.0.1:3410 wants.
 *
 * WHY /auth/confirm?token_hash=… AND NOT action_link. `generateLink` also
 * returns an `action_link` pointing at Supabase's `/verify`, which answers
 * with tokens in the URL fragment (implicit flow). Our browser client is
 * PKCE-only and refuses those (MASTER §0.1), so the user would land signed
 * out with no message. A `token_hash` sent to our own route is verified
 * server-side with `verifyOtp`, works in any browser (no stored PKCE
 * verifier), and lets us show a proper error when the link is dead.
 *
 * Pure module; see `tests/unit/ws2-auth-helpers.test.ts`.
 */

export type EmailLinkType = 'invite' | 'signup' | 'recovery' | 'magiclink' | 'email'

export function appBaseUrl(requestUrl: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')

  if (env.NODE_ENV === 'production' || !requestUrl) {
    throw new Error(
      'APP_URL is not set. Email links must be built from a fixed, trusted origin ' +
        '(see .env.example). Set APP_URL to the public URL of this deployment.'
    )
  }
  return new URL(requestUrl).origin
}

export function buildConfirmLink(
  base: string,
  tokenHash: string,
  type: EmailLinkType,
  next?: string | null
): string {
  const url = new URL('/auth/confirm', base)
  url.searchParams.set('token_hash', tokenHash)
  url.searchParams.set('type', type)
  if (next) url.searchParams.set('next', next)
  return url.toString()
}

/** Plain sign-in link (no token) that lands on `next` after sign-in. D-7. */
export function buildSignInLink(base: string, next?: string | null): string {
  const url = new URL('/', base)
  if (next) url.searchParams.set('next', next)
  return url.toString()
}

export function buildForgotLink(base: string): string {
  return new URL('/auth/forgot', base).toString()
}

/**
 * How long the links we send stay valid, for the email copy. This must match
 * the Supabase project's "Email OTP expiration" (`otp_expiry` in
 * supabase/config.toml, set to 86400 = 24h; PREFLIGHT.md asks for the same on
 * the hosted project). Override with AUTH_LINK_EXPIRY_HOURS if they differ.
 */
export function linkExpiryHours(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.AUTH_LINK_EXPIRY_HOURS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24
}

/**
 * Deliberately loose: one `@`, something on each side, a dot in the domain,
 * no whitespace or angle brackets. The real test of an address is whether
 * mail arrives; this only rejects obvious typos ("not-an-email", "a@b") before
 * they reach the allowlist and the mail provider.
 */
export function isPlausibleEmail(value: string): boolean {
  if (value.length > 254) return false
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(value)
}

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * `auth.admin.generateLink` answers 422 `email_exists` ("A user with this
 * email address has already been registered") for a CONFIRMED account. That is
 * how the invite and sign-up routes tell "existing account" from "new" without
 * ever querying auth.users (which is shared with another app).
 */
export function isEmailExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { status?: number; code?: string; message?: string }
  const message = (e.message ?? '').toLowerCase()
  return (
    e.code === 'email_exists' ||
    e.code === 'user_already_exists' ||
    message.includes('already been registered') ||
    message.includes('already registered') ||
    message.includes('user already exists')
  )
}
