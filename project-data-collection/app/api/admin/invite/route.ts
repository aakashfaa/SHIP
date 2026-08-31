// This route is the source of truth for adding a person to the SHIP
// allowlist (ship.pending_invites) and getting them a working sign-up
// link. Supabase's built-in mailer is rate-limited to roughly 2-4
// emails/hour for the ENTIRE Supabase project, and that quota is shared
// with an unrelated production project living in the same project — so a
// single SHIP rollout of a handful of consultants can starve everyone's
// password/invite emails. `auth.admin.inviteUserByEmail` (which sends
// mail) is therefore best-effort only and must never fail the request.
// The `actionLink` returned per email (from `auth.admin.generateLink`) is
// the reliable path: a URL the admin can copy into Slack/email directly.

import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

type InviteResult = {
  email: string
  invited: boolean
  alreadyExisted: boolean
  actionLink: string | null
  error: string | null
}

function isAlreadyRegisteredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: number }).status
  const message = ((error as { message?: string }).message ?? '').toLowerCase()
  return (
    status === 422 ||
    message.includes('already registered') ||
    message.includes('already been registered') ||
    message.includes('user already exists')
  )
}

export async function POST(request: NextRequest) {
  let body: { emails?: unknown; role?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.emails)) {
    return NextResponse.json(
      { error: '"emails" must be an array of strings' },
      { status: 400 }
    )
  }

  const role: 'admin' | 'consultant' = body.role === 'admin' ? 'admin' : 'consultant'

  const emails = Array.from(
    new Set(
      body.emails
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0)
    )
  )

  if (emails.length === 0) {
    return NextResponse.json({ error: 'No valid emails provided' }, { status: 400 })
  }

  // 1 & 2. Identify the caller and verify they're a SHIP admin by reading
  // their ship.profiles row. Never trust a role/identity claim from the
  // request body.
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: callerProfile, error: callerProfileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (callerProfileError || !callerProfile || callerProfile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const admin = getSupabaseAdminClient()

  // 3. Upsert the allowlist with the service-role client. pending_invites
  // is not readable/writable by `authenticated` at all (only reachable via
  // RPC), so this has to go through the service role — which is safe here
  // because we've already verified the caller is a SHIP admin above.
  const { error: upsertError } = await admin.from('pending_invites').upsert(
    emails.map((email) => ({
      email,
      role,
      invited_by: user.id,
    })),
    { onConflict: 'email' }
  )

  if (upsertError) {
    return NextResponse.json(
      { error: `Failed to update allowlist: ${upsertError.message}` },
      { status: 500 }
    )
  }

  const origin = new URL(request.url).origin
  const redirectTo = `${origin}/auth/callback`

  const results: InviteResult[] = await Promise.all(
    emails.map(async (email): Promise<InviteResult> => {
      let alreadyExisted = false
      let invited = false
      let softError: string | null = null

      // 4. Best-effort: Supabase's built-in invite email. Subject to the
      // shared project-wide mailer rate limit, so a failure here is
      // expected and must not fail the request. auth.users is shared with
      // another project, so "already registered" is a normal outcome —
      // treat it as success, not an error.
      const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
      })

      if (inviteError) {
        if (isAlreadyRegisteredError(inviteError)) {
          alreadyExisted = true
          invited = true
        } else {
          softError = inviteError.message
        }
      } else {
        invited = true
      }

      // 5. Reliable path: generate a copyable action link regardless of
      // whether the mail step above succeeded. `type: 'invite'` only
      // works for a brand-new auth.users row, so fall back to
      // `magiclink` for an address that already exists (e.g. a user of
      // the other project that shares this Supabase project's
      // auth.users table).
      let actionLink: string | null = null
      const { data: inviteLinkData, error: inviteLinkError } =
        await admin.auth.admin.generateLink({
          type: 'invite',
          email,
          options: { redirectTo },
        })

      if (!inviteLinkError) {
        actionLink = inviteLinkData.properties?.action_link ?? null
      } else if (isAlreadyRegisteredError(inviteLinkError)) {
        alreadyExisted = true
        const { data: magicLinkData, error: magicLinkError } =
          await admin.auth.admin.generateLink({
            type: 'magiclink',
            email,
            options: { redirectTo },
          })

        if (!magicLinkError) {
          actionLink = magicLinkData.properties?.action_link ?? null
        } else {
          softError = softError ?? magicLinkError.message
        }
      } else {
        softError = softError ?? inviteLinkError.message
      }

      return {
        email,
        invited,
        alreadyExisted,
        actionLink,
        error: softError,
      }
    })
  )

  return NextResponse.json({ results })
}
