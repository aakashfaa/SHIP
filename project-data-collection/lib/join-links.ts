/**
 * Per-person join links (migration 0035). An admin copies one from Settings
 * and sends it by hand; the person opens /join/<token>, chooses a password
 * and lands in the project, with no email round-trip that a mail scanner
 * could burn.
 *
 * Only the SHA-256 of the token is stored. Pure module (node:crypto only) so
 * it can be unit tested.
 */
import { createHash, randomBytes } from 'node:crypto'

export const JOIN_LINK_DAYS = 14

/** 32 random bytes, base64url: 43 URL-safe characters. */
export function newJoinToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashJoinToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Rejects anything that can't be one of our tokens before touching the DB. */
export function isWellFormedJoinToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function buildJoinUrl(base: string, token: string): string {
  return new URL(`/join/${token}`, base).toString()
}

/**
 * True when this auth user was created by a SHIP invite (tagged
 * user_metadata.ship_invite at creation) and nobody has ever activated it:
 * email unconfirmed and never signed in. Such an account has no owner yet, so
 * a join link may set its password. Any other existing account (a real SHIP
 * user, or someone from the other app that shares auth.users) is never
 * touched: its owner signs in with their own password.
 */
export function isUnactivatedShipInvite(
  user:
    | {
        user_metadata?: Record<string, unknown> | null
        email_confirmed_at?: string | null
        last_sign_in_at?: string | null
      }
    | null
    | undefined
): boolean {
  if (!user) return false
  return (
    user.user_metadata?.ship_invite === true && !user.email_confirmed_at && !user.last_sign_in_at
  )
}

export type JoinLinkRow = {
  id: string
  project_id: string
  email: string
  created_by: string | null
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

export type JoinLinkState = 'ok' | 'invalid' | 'expired' | 'used'

export function joinLinkState(row: JoinLinkRow | null, now: Date = new Date()): JoinLinkState {
  if (!row || row.revoked_at) return 'invalid'
  if (row.used_at) return 'used'
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired'
  return 'ok'
}

/**
 * "Needs password" (migration 0035): a SHIP user whose account SHIP created
 * (user_metadata.ship_invite) and who has never set or used a password
 * (profiles.password_set_at is null) -- typically because a mail scanner
 * opened the invite link and confirmed the account before the person did.
 *
 * For these accounts a join link sets the password, and Resend / Forgot
 * password send "Finish setting up your account" instead of "sign in".
 * Nothing can be taken over: the ship_invite tag means SHIP made the account
 * and no owner ever chose a password for it.
 *
 * Platform admins are excluded unless `includeAdmins`: a join link (which
 * sets the password for whoever holds it) must never do that to an admin
 * account, but an emailed set-up link goes to the mailbox owner, so the
 * email paths pass includeAdmins.
 */
export function needsPassword(
  profile: { role?: string | null; password_set_at?: string | null } | null | undefined,
  user: { user_metadata?: Record<string, unknown> | null } | null | undefined,
  options: { includeAdmins?: boolean } = {}
): boolean {
  if (!profile || !user) return false
  return (
    !profile.password_set_at &&
    (options.includeAdmins === true || profile.role !== 'admin') &&
    user.user_metadata?.ship_invite === true
  )
}

/** Don't mint another recovery token within this long of the last one. */
export const RECOVERY_DEBOUNCE_MS = 2 * 60 * 1000

/**
 * True when a recovery token was made for this account less than
 * RECOVERY_DEBOUNCE_MS ago. Each new token kills the previous one, and
 * people who ask three times in a minute end up clicking a dead link, so
 * the email routes send nothing new inside this window. Reads
 * auth.users.recovery_sent_at, which every instance sees (the in-memory rate
 * limiter does not).
 */
export function recoveryRecentlySent(
  recoverySentAt: string | null | undefined,
  now: Date = new Date(),
  windowMs: number = RECOVERY_DEBOUNCE_MS
): boolean {
  if (!recoverySentAt) return false
  const sent = new Date(recoverySentAt).getTime()
  if (!Number.isFinite(sent)) return false
  const age = now.getTime() - sent
  return age >= 0 && age < windowMs
}
