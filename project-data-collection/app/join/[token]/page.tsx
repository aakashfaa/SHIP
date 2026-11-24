'use client'

// /join/<token>: the per-person join link an admin copied from Settings.
// Opening the page only LOOKS the link up; nothing is used until the person
// submits the form, so a mail or chat scanner that pre-fetches the URL can't
// burn it. See app/api/join/route.ts for what the link may and may not do.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  CARD,
  ErrorNote,
  Eyebrow,
  INPUT,
  PAGE_SHELL,
  PRIMARY_BUTTON,
} from '../../auth/auth-shell'

const MIN_PASSWORD = 8

// The token is in this page's URL. Keep it out of the Referer header of
// anything the page links to or loads (React 19 hoists this into <head>).
const NO_REFERRER = <meta name="referrer" content="no-referrer" />

type Lookup =
  | { state: 'loading' }
  | { state: 'new'; email: string; projectName: string }
  | { state: 'existing'; email: string; projectName: string; next: string }
  | { state: 'joined'; email: string; next: string; signedIn: boolean }
  | { state: 'invalid' | 'expired' | 'used' | 'error' }

async function callJoin(body: Record<string, unknown>) {
  const res = await fetch('/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, payload }
}

export default function JoinPage() {
  const params = useParams<{ token: string }>()
  const token = params?.token ?? ''
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' })
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    callJoin({ action: 'lookup', token })
      .then(({ ok, payload }) => {
        if (cancelled) return
        setLookup(ok ? (payload as Lookup) : { state: 'error' })
      })
      .catch(() => {
        if (!cancelled) setLookup({ state: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`)
      return
    }
    if (password !== confirmPassword) {
      setError("The two passwords don't match.")
      return
    }
    setSubmitting(true)
    try {
      const { ok, payload } = await callJoin({ action: 'accept', token, password })
      if (!ok) {
        setError((payload.error as string) ?? 'Something went wrong. Please try again.')
        setSubmitting(false)
        return
      }
      const result = payload as Lookup
      if (result.state === 'joined' && result.signedIn) {
        // Full load so the app picks up the session cookies just set.
        window.location.assign(result.next)
        return
      }
      setLookup(result)
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.")
    }
    setSubmitting(false)
  }

  if (lookup.state === 'loading') {
    return (
      <main className={PAGE_SHELL}>
        {NO_REFERRER}
        <div className={`${CARD} text-center`}>
          <Eyebrow />
          <p className="text-sm text-slate-600">Checking your link...</p>
        </div>
      </main>
    )
  }

  if (lookup.state === 'new') {
    return (
      <main className={PAGE_SHELL}>
        {NO_REFERRER}
        <div className={CARD}>
          <div className="mb-8">
            <Eyebrow />
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">Join {lookup.projectName}</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Choose a password for{' '}
              <span className="font-medium text-slate-800">{lookup.email}</span>. You&apos;ll go
              straight to the project.
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {/* Lets password managers save the right username. */}
            <input type="email" name="email" autoComplete="username" value={lookup.email} readOnly hidden />
            <div>
              <label htmlFor="join-password" className="mb-2 block text-sm font-medium text-slate-700">
                Password
              </label>
              <input
                id="join-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_PASSWORD} characters`}
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="join-confirm" className="mb-2 block text-sm font-medium text-slate-700">
                Confirm password
              </label>
              <input
                id="join-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Type it again"
                className={INPUT}
              />
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
              {submitting ? 'Setting up...' : 'Join project'}
            </button>
          </form>
          <p className="mt-6 text-center text-xs text-slate-500">
            Not {lookup.email}? Ask your project admin for your own link.
          </p>
        </div>
      </main>
    )
  }

  if (lookup.state === 'existing' || lookup.state === 'joined') {
    const signInHref = `/?next=${encodeURIComponent(lookup.next)}`
    return (
      <main className={PAGE_SHELL}>
        {NO_REFERRER}
        <div className={`${CARD} text-center`}>
          <Eyebrow />
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            {lookup.state === 'joined' ? "You're all set" : 'You already have an account'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {lookup.state === 'joined' ? (
              <>Sign in as <span className="font-medium text-slate-800">{lookup.email}</span> with the password you just chose.</>
            ) : (
              <>
                <span className="font-medium text-slate-800">{lookup.email}</span> already has an
                account and has been added to{' '}
                <span className="font-medium text-slate-800">{lookup.projectName}</span>. Sign in with
                your password to open it.
              </>
            )}
          </p>
          <div className="mt-6 space-y-3">
            <Link href={signInHref} className={`${PRIMARY_BUTTON} block`}>
              Sign in
            </Link>
            {lookup.state === 'existing' ? (
              <Link
                href="/auth/forgot"
                className="block text-sm font-medium text-teal-700 hover:text-teal-800"
              >
                Forgot your password?
              </Link>
            ) : null}
          </div>
        </div>
      </main>
    )
  }

  const messages: Record<string, { title: string; body: string }> = {
    expired: { title: 'This link has expired', body: 'Join links last 14 days. Ask your project admin for a new one.' },
    used: { title: 'This link was already used', body: 'If that was you, just sign in. Otherwise ask your project admin for a new link.' },
    invalid: { title: "This link doesn't work", body: 'It may have been replaced by a newer link. Ask your project admin for a new one.' },
    error: { title: 'Something went wrong', body: 'Please reload the page in a minute.' },
  }
  const m = messages[lookup.state] ?? messages.invalid
  return (
    <main className={PAGE_SHELL}>
        {NO_REFERRER}
      <div className={`${CARD} text-center`}>
        <Eyebrow />
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{m.title}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">{m.body}</p>
        <Link href="/" className="mt-6 inline-block text-sm font-medium text-teal-700 hover:text-teal-800">
          Go to sign in
        </Link>
      </div>
    </main>
  )
}
