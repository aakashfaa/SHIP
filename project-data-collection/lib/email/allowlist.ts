import 'server-only'

import type { ShipSupabaseClient } from '@/lib/supabase/client'

/**
 * Is this email someone SHIP knows about — on the invite allowlist
 * (`ship.pending_invites`) or already holding a `ship.profiles` row?
 *
 * The public sign-up and forgot-password routes only send mail to these
 * addresses. auth.users is shared with an unrelated production app, so a
 * stranger typing an address into OUR forgot-password form must not make us
 * send a "Reset your Master Plan Dashboard password" email to a user of the
 * other product who has never heard of us. Callers always answer with the
 * same neutral message either way, so this check never reveals anything.
 *
 * Takes the service-role client: neither table is readable by `anon`.
 */
export async function isKnownShipEmail(admin: ShipSupabaseClient, email: string): Promise<boolean> {
  const [invite, profile] = await Promise.all([
    admin.from('pending_invites').select('email').eq('email', email).maybeSingle(),
    admin.from('profiles').select('id').eq('email', email).maybeSingle(),
  ])
  if (invite.error) console.error('isKnownShipEmail: pending_invites lookup failed', invite.error)
  if (profile.error) console.error('isKnownShipEmail: profiles lookup failed', profile.error)
  return Boolean(invite.data || profile.data)
}
