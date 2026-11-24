'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  MAX_PASSWORD,
  MIN_PASSWORD,
  PASSWORD_LINK_ERRORS,
  type PasswordLinkError,
  validateNewPassword,
} from '@/lib/supabase/email-confirm'
import {
  CARD,
  ErrorNote,
  Eyebrow,
  INPUT,
  InfoNote,
  PAGE_SHELL,
  PRIMARY_BUTTON,
} from '../auth-shell'

// "Choose a password" for invite and recovery links (/auth/confirm). Opening
// the page uses nothing. The form is a plain HTML POST to
// /auth/confirm/verify, which checks the password, then verifies the token
// and sets the password in one request: the link is used up only when the
// person finishes. The password is checked here first too, so a typo never
// reaches the server, and the server checks it again before touching the
// token.
//
// With tokenHash null the link is dead (expired or already used): no
// password fields, just a way to get a new link.

export function PasswordLinkForm(props: {
  heading: string
  body: string
  tokenHash: string | null
  type: 'invite' | 'recovery'
  next: string | null
  setup: boolean
  error: PasswordLinkError | null
}) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [clientError, setClientError] = useState<PasswordLinkError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const error = clientError ?? props.error

  return (
    <main className={PAGE_SHELL}>
      <div className={CARD}>
        <div className="mb-8">
          <Eyebrow />
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950">{props.heading}</h1>
          {props.tokenHash ? (
            <p className="mt-2 text-sm leading-6 text-slate-600">{props.body}</p>
          ) : null}
        </div>

        {props.tokenHash ? (
          <form
            method="post"
            action="/auth/confirm/verify"
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              if (submitting) {
                e.preventDefault()
                return
              }
              const problem = validateNewPassword(password, confirmPassword)
              if (problem) {
                e.preventDefault()
                setClientError(problem)
                return
              }
              setClientError(null)
              setSubmitting(true)
            }}
          >
            <input type="hidden" name="token_hash" value={props.tokenHash} />
            <input type="hidden" name="type" value={props.type} />
            {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
            {props.setup ? <input type="hidden" name="setup" value="1" /> : null}
            <div>
              <label htmlFor="new-password" className="mb-2 block text-sm font-medium text-slate-700">
                New password
              </label>
              <input
                id="new-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD}
                maxLength={MAX_PASSWORD}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_PASSWORD} characters`}
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className="mb-2 block text-sm font-medium text-slate-700">
                Confirm password
              </label>
              <input
                id="confirm-password"
                name="confirm_password"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Type it again"
                className={INPUT}
              />
            </div>

            {error ? <ErrorNote>{PASSWORD_LINK_ERRORS[error]}</ErrorNote> : null}

            <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
              {submitting ? 'Saving...' : 'Save password and continue'}
            </button>
          </form>
        ) : (
          <NewLinkRequest error={error} next={props.next} />
        )}

        <div className="mt-6 text-center text-sm text-slate-600">
          Already have a password?{' '}
          <Link
            href={props.next ? `/?next=${encodeURIComponent(props.next)}` : '/'}
            className="font-medium text-teal-700 hover:text-teal-800"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  )
}

// A dead link. We don't know whose it was (the token is gone), so ask for
// the address and send a fresh link in one click, through the same neutral
// endpoint as "Forgot password?".
function NewLinkRequest({ error, next }: { error: PasswordLinkError | null; next: string | null }) {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState('')
  const [sendError, setSendError] = useState('')

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setSendError('')
    if (!email.trim()) {
      setSendError('Enter the email address this link was sent to.')
      return
    }
    setSending(true)
    try {
      const res = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), next }),
      })
      const payload = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
      if (!res.ok) setSendError(payload.error ?? 'Something went wrong. Please try again.')
      else setSent(payload.message ?? 'If that email has an account here, a new link is on its way.')
    } catch {
      setSendError("Couldn't reach the server. Check your connection and try again.")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <ErrorNote>{PASSWORD_LINK_ERRORS[error ?? 'link_expired']}</ErrorNote>
      <p className="text-sm leading-6 text-slate-600">
        If you asked more than once, use the newest email. Each new link replaces the ones
        before it. Or get a fresh one here:
      </p>
      {sent ? (
        <InfoNote>{sent}</InfoNote>
      ) : (
        <form onSubmit={send} className="space-y-4" noValidate>
          <div>
            <label htmlFor="new-link-email" className="mb-2 block text-sm font-medium text-slate-700">
              Your email
            </label>
            <input
              id="new-link-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className={INPUT}
            />
          </div>
          {sendError ? <ErrorNote>{sendError}</ErrorNote> : null}
          <button type="submit" disabled={sending} className={PRIMARY_BUTTON}>
            {sending ? 'Sending...' : 'Email me a new link'}
          </button>
        </form>
      )}
    </div>
  )
}
