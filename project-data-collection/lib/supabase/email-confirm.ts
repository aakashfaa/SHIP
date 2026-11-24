/**
 * Shared pieces of the email-link flow: the page every emailed link opens
 * (GET /auth/confirm) and the route that actually uses the link (POST
 * /auth/confirm/verify).
 *
 * WHY OPENING A LINK NEVER USES IT. Corporate mail scanners (Microsoft Safe
 * Links and friends) open every link in an email before the person does.
 * When opening /auth/confirm verified the one-time token, the scanner used it
 * up and the real person got "link expired" (production logs: ~143
 * dead-token failures against ~10 successes). Scanners fetch links but don't
 * submit forms, so the token is only used by a form POST:
 *
 *   * invite / recovery links ("password links") open a "Choose a password"
 *     form. Submitting it verifies the token AND sets the password in the
 *     same request, so the token is used up only when the person actually
 *     finishes. The password is checked before the token is touched, so a
 *     typo can't burn the link.
 *   * every other type (signup, email, magiclink, email_change) has nothing
 *     to choose, so it opens a page with a Continue button.
 *
 * Pure (no Next, no Supabase runtime) so `node --test` can load it. See
 * `tests/unit/email-confirm.test.ts`.
 */

import type { EmailOtpType } from '@supabase/supabase-js'

export const OTP_TYPES: readonly EmailOtpType[] = [
  'invite',
  'signup',
  'recovery',
  'magiclink',
  'email',
  'email_change',
]

export function isOtpType(value: unknown): value is EmailOtpType {
  return typeof value === 'string' && (OTP_TYPES as readonly string[]).includes(value)
}

/** Links whose page is "Choose a password" rather than a Continue button. */
export function isPasswordLinkType(type: unknown): type is 'invite' | 'recovery' {
  return type === 'invite' || type === 'recovery'
}

/**
 * A recovery link we send to someone who has an account but never chose a
 * password ("needs password", migration 0035) carries `setup=1`, so the page
 * says "Finish setting up your account" rather than "Reset your password".
 */
export function isSetupFlag(value: unknown): boolean {
  return value === '1'
}

export type ConfirmCopy = { heading: string; body: string }

/** What the page says for each kind of link. */
export function confirmCopy(type: EmailOtpType, options: { setup?: boolean } = {}): ConfirmCopy {
  if (type === 'invite' || (type === 'recovery' && options.setup)) {
    return {
      heading: 'Finish setting up your account',
      body: "Choose a password. You'll use it to sign in from now on.",
    }
  }
  switch (type) {
    case 'recovery':
      return {
        heading: 'Reset your password',
        body: "Choose a new password. You'll use it to sign in from now on.",
      }
    case 'signup':
    case 'email':
      return {
        heading: 'Confirm your email',
        body: 'Press Continue to confirm this is your email address and sign in.',
      }
    case 'email_change':
      return {
        heading: 'Confirm your new email',
        body: 'Press Continue to confirm your new email address.',
      }
    case 'magiclink':
    default:
      return {
        heading: 'Sign in',
        body: 'Press Continue to sign in.',
      }
  }
}

export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 72 // bcrypt's limit; GoTrue rejects longer

/** Errors the password-link page can show (as `?error=` after a POST). */
export type PasswordLinkError =
  | 'password_short'
  | 'password_long'
  | 'password_mismatch'
  | 'link_expired'
  | 'link_invalid'

export const PASSWORD_LINK_ERRORS: Record<PasswordLinkError, string> = {
  password_short: `Password must be at least ${MIN_PASSWORD} characters.`,
  password_long: `Password must be at most ${MAX_PASSWORD} characters.`,
  password_mismatch: "The two passwords don't match.",
  link_expired: 'This link has expired or was already used.',
  link_invalid: "This link didn't work. It may have been copied incompletely.",
}

export function readPasswordLinkError(value: unknown): PasswordLinkError | null {
  return typeof value === 'string' && Object.hasOwn(PASSWORD_LINK_ERRORS, value)
    ? (value as PasswordLinkError)
    : null
}

/** True for the errors after which the link itself can't be used. */
export function isDeadLinkError(error: PasswordLinkError | null): boolean {
  return error === 'link_expired' || error === 'link_invalid'
}

/**
 * Checked in the browser before submitting and again on the server BEFORE
 * the token is verified, so a typo never uses up the link.
 */
export function validateNewPassword(
  password: unknown,
  confirm: unknown
): 'password_short' | 'password_long' | 'password_mismatch' | null {
  const p = typeof password === 'string' ? password : ''
  const c = typeof confirm === 'string' ? confirm : ''
  if (p.length < MIN_PASSWORD) return 'password_short'
  if (p.length > MAX_PASSWORD) return 'password_long'
  if (p !== c) return 'password_mismatch'
  return null
}
