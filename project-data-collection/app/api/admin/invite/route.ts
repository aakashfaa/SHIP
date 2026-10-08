// Adds people to the SHIP allowlist (ship.pending_invites) and emails them.
// Called by Settings (with `projectId`) and by the new-project page.
//
// Rewritten for M-02 / M-15 / M-22 / M-29 and decisions D-6, D-7, D-8:
//
// WHO MAY CALL (M-15, D-8). An ACTIVE caller who is either a platform admin
// or an admin of `projectId`. A project admin may only invite people who are
// already on that project's roster, and always as 'consultant' — only a
// platform admin can put `role: 'admin'` (the global platform-admin bit that
// claim_invite copies onto the new profile) into pending_invites. Without a
// projectId, only a platform admin may call.
//
// WHAT EACH EMAIL GETS (D-6, D-7). Every email is sent by us via Resend
// (lib/email/send.ts), never by Supabase's mailer:
// - A NEW address → `generateLink({ type: 'invite' })` creates an
//   unconfirmed account; we email a /auth/confirm?token_hash=… link that signs
//   them in once and asks them to choose a password.
// - An address that ALREADY HAS AN ACCOUNT (generateLink answers
//   `email_exists`) → no token at all. They get a "You've been added to
//   <Project>" email linking to the normal sign-in page with
//   ?next=/projects/<id>, and a row in ship.project_access_notices so the app
//   shows them a toast next time they sign in.
//
// NO LOGIN TOKEN FOR AN EXISTING ACCOUNT EVER REACHES THE ADMIN (M-02).
// auth.users is shared with an unrelated production app. The old route
// returned a magic link for any address — a bearer credential for someone
// else's account in that app. Now `actionLink` (the copyable set-up link) is
// returned ONLY for an account a SHIP invite created and that has never been
// activated (see `isUnactivatedShipInvite`). Everyone else: null.
//
// PER-EMAIL RESULTS, NEVER A FAILED BATCH (M-22, M-29). Bad addresses,
// mail-provider errors and lookup failures become `error` on that one
// result. The route returns 200 with every result; Settings shows each one.

import { NextRequest, NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import type { ShipSupabaseClient } from '@/lib/supabase/client'
import {
  appBaseUrl,
  buildConfirmLink,
  buildForgotLink,
  buildSignInLink,
  isEmailExistsError,
  isPlausibleEmail,
  linkExpiryHours,
  normalizeEmail,
} from '@/lib/email/links'
import { checkRateLimit } from '@/lib/email/rate-limit'
import { sendEmail } from '@/lib/email/send'
import { renderAddedToProjectEmail, renderInviteEmail } from '@/lib/email/templates'

export const runtime = 'nodejs'

const MAX_EMAILS_PER_REQUEST = 50

type InviteStatus = 'invited' | 'added' | 'failed'

type InviteResult = {
  email: string
  /** invited = new account, set-password link sent; added = existing
   *  account, plain sign-in email sent; failed = see `error`. */
  status: InviteStatus
  /** Kept for app/projects/new/page.tsx: true unless status is 'failed'. */
  invited: boolean
  alreadyExisted: boolean
  emailSent: boolean
  /** Copyable set-up link. ONLY for a brand-new, never-activated account a
   *  SHIP invite created — never for an existing account (M-02, D-7). */
  actionLink: string | null
  error: string | null
}

function failed(email: string, error: string, alreadyExisted = false): InviteResult {
  return {
    email,
    status: 'failed',
    invited: false,
    alreadyExisted,
    emailSent: false,
    actionLink: null,
    error,
  }
}

/**
 * True when this auth user was created by a SHIP invite (we tag new invitees
 * with user_metadata.ship_invite at creation; GoTrue never rewrites metadata
 * on a re-invite — verified locally) and nobody has ever activated it: email
 * unconfirmed and never signed in. Such an account has no owner yet but the
 * mailbox holder, so handing the admin a link to it gives away nothing that
 * belongs to anyone. An unconfirmed account the OTHER app created is not
 * tagged, so it still gets the email but never a copyable link.
 */
function isUnactivatedShipInvite(user: User | null | undefined): boolean {
  if (!user) return false
  return (
    user.user_metadata?.ship_invite === true &&
    !user.email_confirmed_at &&
    !user.last_sign_in_at
  )
}

/** Column-missing errors from PostgREST (0013 not applied yet). */
function isMissingColumnOrTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    error.code === '42703' ||
    error.code === '42P01' ||
    /column .* does not exist|could not find the .* column|relation .* does not exist|could not find the table/i.test(
      error.message ?? ''
    )
  )
}

async function upsertAllowlist(
  admin: ShipSupabaseClient,
  emails: string[],
  role: 'admin' | 'consultant',
  invitedBy: string,
  projectId: string | null
): Promise<string | null> {
  if (emails.length === 0) return null
  const rows = emails.map((email) => ({
    email,
    role,
    invited_by: invitedBy,
    ...(projectId ? { project_id: projectId } : {}),
  }))

  // A consultant invite must never DOWNGRADE an existing row (a platform
  // admin re-added to a project's roster would otherwise lose admin at
  // claim time), so it only inserts missing rows. An explicit admin invite
  // (platform admins only) does update the role.
  const options =
    role === 'admin'
      ? { onConflict: 'email' }
      : { onConflict: 'email', ignoreDuplicates: true }

  let { error } = await admin.from('pending_invites').upsert(rows, options)
  if (error && projectId && isMissingColumnOrTable(error)) {
    // pending_invites.project_id arrives with WS-1's 0013. Until it is
    // applied, record the invite without it rather than failing everyone.
    console.warn('invite: pending_invites.project_id missing; inviting without it')
    ;({ error } = await admin
      .from('pending_invites')
      .upsert(rows.map(({ email, role: r, invited_by }) => ({ email, role: r, invited_by })), options))
  }
  return error ? error.message : null
}

async function recordAccessNotice(admin: ShipSupabaseClient, email: string, projectId: string) {
  // One unseen notice per (email, project) is enough; a second "Resend"
  // shouldn't stack two identical toasts.
  const { data: existing, error: lookupError } = await admin
    .from('project_access_notices')
    .select('id')
    .eq('email', email)
    .eq('project_id', projectId)
    .is('seen_at', null)
    .limit(1)
  if (lookupError) {
    if (isMissingColumnOrTable(lookupError)) {
      console.warn('invite: ship.project_access_notices not present yet (0013); skipping notice')
    } else {
      console.error('invite: access-notice lookup failed', lookupError)
    }
    return
  }
  if (existing && existing.length > 0) return

  const { error } = await admin
    .from('project_access_notices')
    .insert({ email, project_id: projectId })
  if (error) console.error('invite: could not record access notice', error)
}

export async function POST(request: NextRequest) {
  let body: { emails?: unknown; role?: unknown; projectId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.emails)) {
    return NextResponse.json({ error: '"emails" must be an array of strings' }, { status: 400 })
  }
  const projectId =
    typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null

  const emails = Array.from(
    new Set(body.emails.map(normalizeEmail).filter((value) => value.length > 0))
  )
  if (emails.length === 0) {
    return NextResponse.json({ error: 'No emails provided' }, { status: 400 })
  }
  if (emails.length > MAX_EMAILS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Invite at most ${MAX_EMAILS_PER_REQUEST} people at a time.` },
      { status: 400 }
    )
  }

  // 1. Who is calling? Never trust a role or identity from the body.
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: callerProfile, error: callerProfileError } = await supabase
    .from('profiles')
    .select('name, role, is_active')
    .eq('id', user.id)
    .maybeSingle()

  // An inactive profile is no profile (M-15: the old check let a
  // deactivated platform admin keep inviting).
  if (callerProfileError || !callerProfile || callerProfile.is_active !== true) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const isPlatformAdmin = callerProfile.role === 'admin'

  // 2. May they invite to this project? project_role() answers as the
  //    caller (RLS context), returns 'admin' for platform admins and null for
  //    inactive users or non-members.
  const admin = getSupabaseAdminClient()
  let projectName: string | null = null

  if (projectId) {
    const { data: role, error: roleError } = await supabase.rpc('project_role', {
      p_project_id: projectId,
    })
    if (roleError) {
      console.error('invite: project_role failed', roleError)
      return NextResponse.json({ error: 'Could not check your access to this project.' }, { status: 500 })
    }
    if (!isPlatformAdmin && role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { data: project } = await admin
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .maybeSingle()
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    projectName = (project as { name: string }).name
  } else if (!isPlatformAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // D-8: only a platform admin can mint a platform admin.
  const role: 'admin' | 'consultant' =
    isPlatformAdmin && body.role === 'admin' ? 'admin' : 'consultant'

  // 3. A generous per-admin cap so a stuck loop or a pasted list of 5,000
  //    addresses can't burn the Resend quota or get the domain flagged.
  const limit = checkRateLimit(`invite:user:${user.id}`, 200, 60 * 60 * 1000)
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many invites in the last hour. Please wait and try again.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    )
  }

  let base: string
  try {
    base = appBaseUrl(request.url)
  } catch (err) {
    console.error('invite:', err)
    return NextResponse.json({ error: 'Email links are not configured (APP_URL).' }, { status: 500 })
  }

  // 4. Per-email validation. Bad ones become failed results, not a 400.
  const results = new Map<string, InviteResult>()
  let candidates: string[] = []
  for (const email of emails) {
    if (!isPlausibleEmail(email)) results.set(email, failed(email, 'Not a valid email address'))
    else candidates.push(email)
  }

  // A project admin may only invite people already on that project's roster
  // (Settings saves the roster first, then calls us). This is what keeps a
  // project admin from using the route to mint allowlist rows for arbitrary
  // addresses.
  if (projectId && !isPlatformAdmin && candidates.length > 0) {
    const { data: members, error: membersError } = await admin
      .from('project_members')
      .select('email')
      .eq('project_id', projectId)
      .in('email', candidates)
    if (membersError) {
      console.error('invite: roster lookup failed', membersError)
      for (const email of candidates) results.set(email, failed(email, 'Could not check the project roster'))
      candidates = []
    } else {
      const onRoster = new Set((members ?? []).map((m: { email: string }) => m.email))
      for (const email of candidates) {
        if (!onRoster.has(email)) {
          results.set(email, failed(email, "Add this email to the project's team first, then save"))
        }
      }
      candidates = candidates.filter((email) => onRoster.has(email))
    }
  }

  // 5. Allowlist. Done for the whole batch at once; on failure, every
  //    candidate gets the error and nothing is emailed (an email whose
  //    recipient then can't claim access would be worse than no email).
  const allowlistError = await upsertAllowlist(admin, candidates, role, user.id, projectId)
  if (allowlistError) {
    console.error('invite: allowlist upsert failed', allowlistError)
    for (const email of candidates) {
      results.set(email, failed(email, 'Could not add this email to the invite list'))
    }
    candidates = []
  }

  // 6. Link + email, one address at a time (keeps us inside Resend's rate
  //    limit; see lib/email/send.ts). Each wrapped so one failure can't
  //    take down the rest (M-29: the old un-wrapped Promise.all 500'd).
  const inviterName = callerProfile.name?.trim() || null
  const next = projectId ? `/projects/${encodeURIComponent(projectId)}` : null
  const hours = linkExpiryHours()

  for (const email of candidates) {
    try {
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { data: { ship_invite: true } },
      })

      if (!error && data.properties?.hashed_token) {
        const link = buildConfirmLink(base, data.properties.hashed_token, 'invite', next)
        const sent = await sendEmail(
          email,
          renderInviteEmail({ link, projectName, inviterName, expiresInHours: hours })
        )
        results.set(email, {
          email,
          status: 'invited',
          invited: true,
          alreadyExisted: false,
          emailSent: sent.ok,
          actionLink: isUnactivatedShipInvite(data.user) ? link : null,
          error: sent.ok ? null : `Account created, but the email didn't send: ${sent.error}`,
        })
        continue
      }

      if (isEmailExistsError(error)) {
        // Existing account: no token, ever (D-7).
        if (projectId) await recordAccessNotice(admin, email, projectId)
        const sent = await sendEmail(
          email,
          renderAddedToProjectEmail({
            link: buildSignInLink(base, next),
            forgotLink: buildForgotLink(base),
            projectName,
            inviterName,
          })
        )
        results.set(email, {
          email,
          status: 'added',
          invited: true,
          alreadyExisted: true,
          emailSent: sent.ok,
          actionLink: null,
          error: sent.ok ? null : `Access granted, but the email didn't send: ${sent.error}`,
        })
        continue
      }

      console.error('invite: generateLink(invite) failed', email, error)
      results.set(email, failed(email, 'Could not create an invite for this email'))
    } catch (err) {
      console.error('invite: unexpected failure for', email, err)
      results.set(email, failed(email, 'Something went wrong inviting this email'))
    }
  }

  // Preserve the caller's order.
  return NextResponse.json({ results: emails.map((email) => results.get(email)!) })
}
