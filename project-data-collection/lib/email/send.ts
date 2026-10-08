import 'server-only'

import type { RenderedEmail } from './templates'

/**
 * Sends one email. All SHIP auth email goes through here (D-6): Supabase's own
 * mailer is never used, because it is capped at a few emails an hour for the
 * whole Supabase project — shared with an unrelated production app — and its
 * templates link through Supabase's implicit-flow `/verify` endpoint, which our
 * PKCE browser client cannot use.
 *
 * Transport:
 * - `RESEND_API_KEY` set  → Resend's REST API (`POST /emails`), via fetch.
 *   No SDK: one endpoint does not justify a dependency.
 * - otherwise, outside production → the local Supabase stack's Mailpit
 *   (`POST /api/v1/send`, http://127.0.0.1:55424 by default, override with
 *   `MAILPIT_URL`). Every flow is then testable end to end on a laptop, and
 *   the Playwright spec reads the message back from Mailpit's API.
 * - otherwise, in production → a soft error. We never silently "send" to
 *   localhost from a deployed server.
 *
 * Never throws: callers send per recipient inside a batch (invites) and must
 * report a per-recipient failure rather than 500 the whole request (M-29).
 */

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string }

type Address = { email: string; name: string | null }

const DEFAULT_FROM = 'Master Plan Dashboard <no-reply@localhost.test>'

/** "Name <a@b.c>" or "a@b.c" → parts (Mailpit wants them separately). */
export function parseFromAddress(raw: string): Address {
  const match = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^>]+?)\s*>\s*$/)
  if (match) return { name: match[1]?.trim() || null, email: match[2] }
  return { name: null, email: raw.trim() }
}

function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_FROM
}

// Resend's default API limit is 2 requests/second per team. An admin inviting
// ten people sends ten emails back to back, so space our calls out (per
// server instance) and retry once on a 429 instead of reporting a failure the
// admin would have to chase.
const RESEND_MIN_GAP_MS = 550
let resendQueue: Promise<void> = Promise.resolve()

function nextResendSlot(): Promise<void> {
  const slot = resendQueue.then(() => new Promise<void>((r) => setTimeout(r, RESEND_MIN_GAP_MS)))
  const turn = resendQueue
  resendQueue = slot
  return turn
}

async function sendViaResend(apiKey: string, to: string, email: RenderedEmail): Promise<SendResult> {
  await nextResendSlot()
  let result = await postToResend(apiKey, to, email)
  if (!result.ok && result.retryable) {
    await new Promise((r) => setTimeout(r, 1200))
    result = await postToResend(apiKey, to, email)
  }
  return result.ok ? { ok: true, id: result.id } : { ok: false, error: result.error }
}

type ResendAttempt =
  | { ok: true; id: string | null }
  | { ok: false; error: string; retryable: boolean }

async function postToResend(apiKey: string, to: string, email: RenderedEmail): Promise<ResendAttempt> {
  const replyTo = process.env.EMAIL_REPLY_TO?.trim()
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
    // A hung provider must not hang the invite batch.
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { message?: string; name?: string }
      if (body?.message) detail = `${detail}: ${body.message}`
    } catch {
      // keep the status-only detail
    }
    return {
      ok: false,
      error: `Email provider rejected the message (${detail})`,
      retryable: res.status === 429 || res.status >= 500,
    }
  }

  const body = (await res.json().catch(() => null)) as { id?: string } | null
  return { ok: true, id: body?.id ?? null }
}

async function sendViaMailpit(to: string, email: RenderedEmail): Promise<SendResult> {
  const base = (process.env.MAILPIT_URL?.trim() || 'http://127.0.0.1:55424').replace(/\/+$/, '')
  const from = parseFromAddress(fromAddress())
  const res = await fetch(`${base}/api/v1/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      From: { Email: from.email, Name: from.name ?? '' },
      To: [{ Email: to }],
      Subject: email.subject,
      HTML: email.html,
      Text: email.text,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    return { ok: false, error: `Local mail catcher (Mailpit) returned HTTP ${res.status}` }
  }
  const body = (await res.json().catch(() => null)) as { ID?: string } | null
  return { ok: true, id: body?.ID ?? null }
}

export async function sendEmail(to: string, email: RenderedEmail): Promise<SendResult> {
  try {
    const apiKey = process.env.RESEND_API_KEY?.trim()
    if (apiKey) return await sendViaResend(apiKey, to, email)

    if (process.env.NODE_ENV === 'production' && !process.env.MAILPIT_URL) {
      console.error('sendEmail: RESEND_API_KEY is not set; email not sent.')
      return { ok: false, error: 'Email is not configured on this server.' }
    }
    return await sendViaMailpit(to, email)
  } catch (err) {
    console.error('sendEmail failed:', err)
    return {
      ok: false,
      error:
        err instanceof Error && err.name === 'TimeoutError'
          ? 'The email provider did not respond in time.'
          : 'Could not reach the email provider.',
    }
  }
}
