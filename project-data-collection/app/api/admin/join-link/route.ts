// Makes a per-person join link for someone on a project's roster
// (Settings > Consultants > "Copy join link"). See lib/join-links.ts and
// migration 0035.
//
// WHO MAY CALL: the same rule as /api/admin/invite — an ACTIVE platform
// admin or an admin of `projectId` — and the email must already be on that
// project's roster. A new link revokes every older link for the same
// person on the same project, so "copy again" is also "cancel the old one".
//
// The email is also put on the allowlist (pending_invites, as consultant,
// never downgrading an existing row) exactly as the invite route does.

import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { appBaseUrl, isPlausibleEmail, normalizeEmail } from '@/lib/email/links'
import { checkRateLimit } from '@/lib/email/rate-limit'
import { JOIN_LINK_DAYS, buildJoinUrl, hashJoinToken, newJoinToken } from '@/lib/join-links'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  let body: { email?: unknown; projectId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const email = normalizeEmail(body.email)
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
  if (!projectId || !isPlausibleEmail(email)) {
    return NextResponse.json({ error: 'A project and a valid email are required.' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .maybeSingle()
  if (!callerProfile || callerProfile.is_active !== true) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: role, error: roleError } = await supabase.rpc('project_role', {
    p_project_id: projectId,
  })
  if (roleError) {
    console.error('join-link: project_role failed', roleError)
    return NextResponse.json({ error: 'Could not check your access to this project.' }, { status: 500 })
  }
  if (callerProfile.role !== 'admin' && role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const limit = checkRateLimit(`join-link:user:${user.id}`, 100, 60 * 60 * 1000)
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many links in the last hour. Please wait and try again.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    )
  }

  let base: string
  try {
    base = appBaseUrl(request.url)
  } catch (err) {
    console.error('join-link:', err)
    return NextResponse.json({ error: 'Links are not configured on this server (APP_URL).' }, { status: 500 })
  }

  const admin = getSupabaseAdminClient()

  const { data: member, error: memberError } = await admin
    .from('project_members')
    .select('email')
    .eq('project_id', projectId)
    .eq('email', email)
    .limit(1)
  if (memberError) {
    console.error('join-link: roster lookup failed', memberError)
    return NextResponse.json({ error: 'Could not check the project roster.' }, { status: 500 })
  }
  if (!member || member.length === 0) {
    return NextResponse.json(
      { error: "Add this email to the project's team first, then save." },
      { status: 400 }
    )
  }

  // A pending platform-admin invite makes whoever creates the account a
  // platform admin (claim_invite copies the role). Only a platform admin may
  // hand out a link that does that. app/api/join re-checks at use time.
  if (callerProfile.role !== 'admin') {
    const { data: invite, error: inviteError } = await admin
      .from('pending_invites')
      .select('role')
      .eq('email', email)
      .maybeSingle()
    if (inviteError) {
      console.error('join-link: invite lookup failed', inviteError)
      return NextResponse.json({ error: 'Could not check the invite list.' }, { status: 500 })
    }
    if ((invite as { role?: string } | null)?.role === 'admin') {
      return NextResponse.json(
        { error: 'This person was invited as a platform admin. Ask a platform admin for their link.' },
        { status: 403 }
      )
    }
  }

  const { error: allowError } = await admin
    .from('pending_invites')
    .upsert(
      [{ email, role: 'consultant', invited_by: user.id, project_id: projectId }],
      { onConflict: 'email', ignoreDuplicates: true }
    )
  if (allowError) {
    console.error('join-link: allowlist upsert failed', allowError)
    return NextResponse.json({ error: 'Could not add this email to the invite list.' }, { status: 500 })
  }

  // Revoke EVERY older link for this person, used ones included: a link that
  // is mid-accept has used_at set and app/api/join clears it again if the
  // accept fails, which would bring a supposedly replaced link back to life.
  const now = new Date()
  const { error: revokeError } = await admin
    .from('join_links')
    .update({ revoked_at: now.toISOString() })
    .eq('project_id', projectId)
    .eq('email', email)
    .is('revoked_at', null)
  if (revokeError) {
    console.error('join-link: revoke failed', revokeError)
    return NextResponse.json({ error: 'Could not create a link. Please try again.' }, { status: 500 })
  }

  const token = newJoinToken()
  const expiresAt = new Date(now.getTime() + JOIN_LINK_DAYS * 24 * 60 * 60 * 1000)
  const { error: insertError } = await admin.from('join_links').insert({
    project_id: projectId,
    email,
    token_hash: hashJoinToken(token),
    created_by: user.id,
    expires_at: expiresAt.toISOString(),
  })
  if (insertError) {
    console.error('join-link: insert failed', insertError)
    return NextResponse.json({ error: 'Could not create a link. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ url: buildJoinUrl(base, token), expiresAt: expiresAt.toISOString() })
}
