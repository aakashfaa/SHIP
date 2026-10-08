'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQueryParam } from '@/lib/supabase/use-location'
import {
  CARD,
  ErrorNote,
  Eyebrow,
  INPUT,
  InfoNote,
  PAGE_SHELL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from '../auth-shell'

// "Set up your account" for someone their admin put on the invite list but
// who didn't use (or lost) the invite email.
//
// This used to call the browser's `supabase.auth.signUp`, which (a) made
// Supabase send its own email (D-6 says all auth mail is ours) and (b) with
// confirmations off, handed out a session to whoever typed an invited address
// first (M-16 invite hijack). Now it posts to /api/auth/sign-up, which creates
// an unconfirmed account and emails a confirmation link; nobody is signed in
// until they click it.
//
// Whatever happens, the page says the same thing: "check your email". It
// never says "you already have an account" or "you're not invited", because
// auth.users is shared with another app and either answer would tell a
// stranger who has an account there (SEC-8). The email itself tells the real
// owner which case they're in.

const MIN_PASSWORD = 8

type Status = 'idle' | 'submitting' | 'check-email'

export default function SignUpPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [sentMessage, setSentMessage] = useState('')
  const [resendNote, setResendNote] = useState('')
  const next = useQueryParam('next')

  async function submit(): Promise<boolean> {
    try {
      const res = await fetch('/api/auth/sign-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          next,
        }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        message?: string
        error?: string
      }
      if (!res.ok) {
        setError(payload.error ?? 'Something went wrong. Please try again.')
        return false
      }
      setSentMessage(payload.message ?? "If this email is on the invite list, we've sent it a link.")
      return true
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.")
      return false
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!email.trim()) {
      setError('Enter the email address your project admin invited.')
      return
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`)
      return
    }
    if (password !== confirmPassword) {
      setError("The two passwords don't match.")
      return
    }

    setStatus('submitting')
    const ok = await submit()
    setStatus(ok ? 'check-email' : 'idle')
  }

  async function handleResend() {
    setError('')
    setResendNote('')
    setStatus('submitting')
    const ok = await submit()
    setStatus('check-email')
    if (ok) setResendNote('Sent again. Give it a minute, and check your spam folder.')
  }

  function useDifferentEmail() {
    setStatus('idle')
    setError('')
    setResendNote('')
    setPassword('')
    setConfirmPassword('')
  }

  if (status === 'check-email' || (status === 'submitting' && sentMessage)) {
    return (
      <main className={PAGE_SHELL}>
        <div className={`${CARD} text-center`}>
          <Eyebrow />
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            Check your email
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">{sentMessage}</p>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            We sent it to <span className="font-medium text-slate-800">{email.trim()}</span>.
            The link finishes your setup and signs you in.
          </p>

          <div className="mt-6 space-y-3 text-left">
            {resendNote ? <InfoNote>{resendNote}</InfoNote> : null}
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={status === 'submitting'}
              className={SECONDARY_BUTTON}
            >
              {status === 'submitting' ? 'Sending...' : 'Send the email again'}
            </button>
            <button type="button" onClick={useDifferentEmail} className={SECONDARY_BUTTON}>
              Use a different email
            </button>
          </div>

          <Link
            href="/"
            className="mt-6 inline-block text-sm font-medium text-teal-700 hover:text-teal-800"
          >
            Back to sign in
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className={PAGE_SHELL}>
      <div className={CARD}>
        <div className="mb-8">
          <Eyebrow />
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
            Set up your account
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Use the email your project admin invited. If you got an invite email, its
            button is the quickest way in.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="signup-email" className="mb-2 block text-sm font-medium text-slate-700">
              Email
            </label>
            <input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className={INPUT}
            />
          </div>

          <div>
            <label
              htmlFor="signup-password"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Password
            </label>
            <input
              id="signup-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD} characters`}
              className={INPUT}
            />
          </div>

          <div>
            <label
              htmlFor="signup-confirm-password"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Confirm password
            </label>
            <input
              id="signup-confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Type it again"
              className={INPUT}
            />
          </div>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <button type="submit" disabled={status === 'submitting'} className={PRIMARY_BUTTON}>
            {status === 'submitting' ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link href="/" className="font-medium text-teal-700 hover:text-teal-800">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  )
}
