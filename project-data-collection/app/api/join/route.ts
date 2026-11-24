// Public endpoint behind /join/<token> (see lib/join-links.ts, migration 0035).
//
//   { action: 'lookup', token }           -> what the join page should show
//   { action: 'accept', token, password } -> create the account, sign in
//
// The token is the only credential. It names one email on one project's
// roster; whoever holds it may create THAT account and choose its password,
// because the admin who copied the link vouches for the person they sent it
// to. That is the whole point: no email round-trip.
//
// What a link can NEVER do is take over an account that already has an
// owner. auth.users is shared with another production app, so:
//   * no account yet                      -> created, confirmed, signed in
//   * an untouched SHIP invite account    -> its password is set, confirmed
//     (made by our invite, never confirmed, never signed in)
//   * a "needs password" SHIP user        -> its password is set, signed in
//     (has a profile, never set or used a password, account made by a SHIP
//     invite -- typically a mail scanner confirmed it before the person
//     could; see needsPassword in lib/join-links.ts, migration 0035)
//   * anything else (a SHIP user with a password, an account of the other
//     app, an admin)                       -> "sign in with your password";
//     the link is NOT used up, and nothing on the account changes.
// They are already on the roster, so signing in is all they need.

import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { findNeedsPasswordUser, markPasswordSet } from '@/lib/supabase/needs-password'
import type { ShipSupabaseClient } from '@/lib/supabase/client'
import { isEmailExistsError } from '@/lib/email/links'
import { checkRateLimit, clientIpFromHeaders } from '@/lib/email/rate-limit'
import {
  type JoinLinkRow,
  hashJoinToken,
  isUnactivatedShipInvite,
  isWellFormedJoinToken,
  joinLinkState,
} from '@/lib/join-links'

export const runtime = 'nodejs'

const MIN_PASSWORD = 8
const MAX_PASSWORD = 72

type Found = { link: JoinLinkRow; projectName: string }

async function findLink(
  admin: ShipSupabaseClient,
  token: string
): Promise<{ found: Found | null; state: 'ok' | 'invalid' | 'expired' | 'used' }> {
  const { data, error } = await admin
    .from('join_links')
    .select('id, project_id, email, created_by, expires_at, used_at, revoked_at')
    .eq('token_hash', hashJoinToken(token))
    .maybeSingle()
  if (error) throw error
  const link = (data as JoinLinkRow | null) ?? null
  const state = joinLinkState(link)
  if (!link || state !== 'ok') return { found: null, state }

  // Removed from the roster since the link was made -> the link is dead.
  const [{ data: member }, { data: project }, invite] = await Promise.all([
    admin
      .from('project_members')
      .select('email')
      .eq('project_id', link.project_id)
      .eq('email', link.email)
      .limit(1),
    admin.from('projects').select('name').eq('id', link.project_id).maybeSingle(),
    admin.from('pending_invites').select('role').eq('email', link.email).maybeSingle(),
  ])
  if (!member || member.length === 0 || !project) return { found: null, state: 'invalid' }
  if (invite.error) throw invite.error

  // A pending PLATFORM-admin invite: claim_invite will make whoever creates
  // this account a platform admin. Only a link made by an active platform
  // admin may do that; otherwise a project admin could put the address on
  // their roster, copy a link, open it themselves and become a platform
  // admin. Checked here, at use time, because a platform admin may upgrade
  // the invite to 'admin' after a project admin already copied a link.
  if ((invite.data as { role?: string } | null)?.role === 'admin') {
    if (!(await isActivePlatformAdmin(admin, link.created_by))) {
      return { found: null, state: 'invalid' }
    }
  }
  return { found: { link, projectName: (project as { name: string }).name }, state: 'ok' }
}

async function isActivePlatformAdmin(admin: ShipSupabaseClient, userId: string | null): Promise<boolean> {
  if (!userId) return false
  const { data, error } = await admin
    .from('profiles')
    .select('role, is_active')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  const row = data as { role?: string; is_active?: boolean } | null
  return row?.role === 'admin' && row.is_active === true
}

async function hasShipProfile(admin: ShipSupabaseClient, email: string): Promise<boolean> {
  const { data } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()
  return Boolean(data)
}

function existing(found: Found) {
  return NextResponse.json({
    state: 'existing',
    email: found.link.email,
    projectName: found.projectName,
    next: `/projects/${encodeURIComponent(found.link.project_id)}`,
  })
}

export async function POST(request: NextRequest) {
  let body: { action?: unknown; token?: unknown; password?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const ip = clientIpFromHeaders(request.headers)
  const limit = checkRateLimit(`join:ip:${ip}`, 30, 15 * 60 * 1000)
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    )
  }

  if (!isWellFormedJoinToken(body.token)) {
    return NextResponse.json({ state: 'invalid' })
  }
  const token = body.token
  const admin = getSupabaseAdminClient()

  let lookup: Awaited<ReturnType<typeof findLink>>
  try {
    lookup = await findLink(admin, token)
  } catch (err) {
    console.error('join: link lookup failed', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  const found = lookup.found
  if (!found) return NextResponse.json({ state: lookup.state })
  const { link } = found

  // A SHIP user who never chose a password gets the same form as a new
  // person. null = no profile; 'needs-password' / 'active' otherwise.
  const accountKind = async (): Promise<'none' | 'needs-password' | 'active'> => {
    if (!(await hasShipProfile(admin, link.email))) return 'none'
    return (await findNeedsPasswordUser(admin, link.email)) ? 'needs-password' : 'active'
  }

  if (body.action === 'lookup') {
    if ((await accountKind()) === 'active') return existing(found)
    return NextResponse.json({ state: 'new', email: link.email, projectName: found.projectName })
  }

  if (body.action !== 'accept') {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const password = typeof body.password === 'string' ? body.password : ''
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return NextResponse.json(
      { error: `Password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.` },
      { status: 400 }
    )
  }

  const kind = await accountKind()
  if (kind === 'active') return existing(found)

  // Claim the link first, atomically, so two tabs can't both use it.
  const nowIso = new Date().toISOString()
  const { data: claimed, error: claimError } = await admin
    .from('join_links')
    .update({ used_at: nowIso })
    .eq('id', link.id)
    .is('used_at', null)
    .is('revoked_at', null)
    .gt('expires_at', nowIso)
    .select('id')
  if (claimError) {
    console.error('join: claim failed', claimError)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  if (!claimed || claimed.length === 0) return NextResponse.json({ state: 'used' })

  const release = async () => {
    const { error } = await admin.from('join_links').update({ used_at: null }).eq('id', link.id)
    if (error) console.error('join: could not release link', error)
  }

  const weakOrFailed = async (updateError: { code?: string } | null, what: string) => {
    await release()
    if (updateError?.code === 'weak_password') {
      return NextResponse.json({ error: 'That password is too weak. Try a longer one.' }, { status: 400 })
    }
    console.error(`join: ${what} failed`, updateError)
    return NextResponse.json({ error: 'Could not set up your account. Please try again.' }, { status: 500 })
  }

  if (kind === 'needs-password') {
    try {
      // Re-checked after the claim: only an account that still needs a
      // password may have one set here.
      const userId = await findNeedsPasswordUser(admin, link.email)
      if (!userId) {
        await release()
        return existing(found)
      }
      const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
      })
      if (updateError) return await weakOrFailed(updateError as { code?: string }, 'updateUserById (needs password)')
      // Stamp it now, so even if sign-in below fails they are never again
      // treated as "needs password".
      const { error: stampError } = await admin
        .from('profiles')
        .update({ password_set_at: new Date().toISOString() })
        .eq('id', userId)
        .is('password_set_at', null)
      if (stampError) console.error('join: could not stamp password_set_at', stampError)
    } catch (err) {
      console.error('join: unexpected failure (needs password)', err)
      await release()
      return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
    }
    return signInAndFinish(link, password)
  }

  try {
    // Creates an unconfirmed, SHIP-tagged account for a new address, or
    // returns the existing unconfirmed one; a confirmed account answers
    // email_exists. Sends no email.
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'invite',
      email: link.email,
      options: { data: { ship_invite: true } },
    })

    if (isEmailExistsError(error) || (!error && !isUnactivatedShipInvite(data.user))) {
      await release()
      return existing(found)
    }
    if (error || !data.user) {
      console.error('join: generateLink(invite) failed', error)
      await release()
      return NextResponse.json({ error: 'Could not create your account. Please try again.' }, { status: 500 })
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(data.user.id, {
      password,
      email_confirm: true,
    })
    if (updateError) return await weakOrFailed(updateError as { code?: string }, 'updateUserById')
  } catch (err) {
    console.error('join: unexpected failure', err)
    await release()
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }

  return signInAndFinish(link, password)
}

// Account is ready. Sign them in on this browser, create their profile if
// they have none yet, and record that they chose a password.
async function signInAndFinish(link: JoinLinkRow, password: string) {
  const next = `/projects/${encodeURIComponent(link.project_id)}`
  const supabase = await createSupabaseServerClient()
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: link.email,
    password,
  })
  if (signInError) {
    console.error('join: sign-in after join failed', signInError)
    // The account exists; they can sign in by hand.
    return NextResponse.json({ state: 'joined', signedIn: false, email: link.email, next })
  }
  const { error: profileError } = await supabase.rpc('claim_invite')
  if (profileError) console.error('join: claim_invite failed', profileError)
  await markPasswordSet(supabase, 'join')

  return NextResponse.json({ state: 'joined', signedIn: true, email: link.email, next })
}
