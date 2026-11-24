import 'server-only'

import type { ShipSupabaseClient } from '@/lib/supabase/client'
import { needsPassword } from '@/lib/join-links'

/**
 * How the caller will use the answer:
 *   'email' -- Settings Resend / Forgot password. The link goes to the
 *              mailbox owner, so platform admins count too, and when the
 *              password_set_at column is missing (database without 0035)
 *              a SHIP-invite account counts as "needs password": better a
 *              set-up email than the tokenless "sign in" dead end.
 *   'join'  -- a join link sets the password for whoever holds the link.
 *              Never for a platform admin, and never on a guess.
 */
export type NeedsPasswordMode = 'email' | 'join'

export type ShipAccount = {
  userId: string
  needsPassword: boolean
  /** auth.users.recovery_sent_at: when the last recovery token was made. */
  recoverySentAt: string | null
}

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return Boolean(
    error &&
      (error.code === '42703' ||
        error.code === 'PGRST204' ||
        /password_set_at/.test(error.message ?? ''))
  )
}

/**
 * The SHIP account behind `email` (null when the address has no SHIP
 * profile). Starts from ship.profiles, so it only ever reads the auth row
 * of a SHIP user (auth.users is shared with another app). Service-role
 * client. A lookup failure answers null: callers then fall back to the
 * ordinary path.
 */
export async function lookupShipAccount(
  admin: ShipSupabaseClient,
  email: string,
  mode: NeedsPasswordMode
): Promise<ShipAccount | null> {
  let columnKnown = true
  let { data: profile, error } = await admin
    .from('profiles')
    .select('id, role, password_set_at')
    .eq('email', email)
    .maybeSingle()
  if (error && isMissingColumn(error)) {
    columnKnown = false
    ;({ data: profile, error } = await admin
      .from('profiles')
      .select('id, role')
      .eq('email', email)
      .maybeSingle())
  }
  if (error) {
    console.error('needs-password: profile lookup failed', error)
    return null
  }
  const row = profile as { id: string; role: string; password_set_at?: string | null } | null
  if (!row) return null

  const { data, error: userError } = await admin.auth.admin.getUserById(row.id)
  if (userError || !data.user) {
    if (userError) console.error('needs-password: auth user lookup failed', userError)
    return null
  }
  const needs =
    mode === 'join'
      ? columnKnown && needsPassword(row, data.user)
      : needsPassword(columnKnown ? row : { ...row, password_set_at: null }, data.user, {
          includeAdmins: true,
        })
  return {
    userId: row.id,
    needsPassword: needs,
    recoverySentAt: (data.user as { recovery_sent_at?: string | null }).recovery_sent_at ?? null,
  }
}

/** The user id when `email` is a "needs password" account for a join link. */
export async function findNeedsPasswordUser(
  admin: ShipSupabaseClient,
  email: string
): Promise<string | null> {
  const account = await lookupShipAccount(admin, email, 'join')
  return account?.needsPassword ? account.userId : null
}

/**
 * Stamps password_set_at as the user signed in on `supabase` (a cookie
 * client). Never throws: a failure here must not block the person.
 */
export async function markPasswordSet(supabase: ShipSupabaseClient, where: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('mark_password_set')
    if (error) console.error(`${where}: mark_password_set failed`, error)
  } catch (err) {
    console.error(`${where}: mark_password_set failed`, err)
  }
}
