'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import { safeNextPath } from '@/lib/supabase/redirects'
import { useQueryParam } from '@/lib/supabase/use-location'
import {
  CARD,
  ErrorNote,
  Eyebrow,
  INPUT,
  PAGE_SHELL,
  PRIMARY_BUTTON,
} from '../auth-shell'

// "Choose a password". Reached only from /auth/confirm after an invite link
// (a brand-new account that has no password yet) or a reset link (M-03,
// M-17). By the time this renders, /auth/confirm has already verified the
// link and set the session cookies, so all this page does is
// `updateUser({ password })` and send them on to `next` or /projects.
//
// If there's no session (someone bookmarked this page, or the cookies didn't
// stick), we say so and point at "Forgot password?" rather than showing a
// form that can only fail.

const MIN_PASSWORD = 8

type Phase = 'checking' | 'ready' | 'no-session'

function friendlyUpdateError(error: { code?: string; message: string }): string {
  if (error.code === 'same_password') {
    return "That's already your password. Choose a different one, or just sign in."
  }
  if (error.code === 'weak_password') {
    return 'That password is too weak. Try a longer one.'
  }
  if (error.code === 'session_not_found' || error.code === 'session_expired') {
    return 'Your link has expired. Request a new one below.'
  }
  return 'Could not save your password. Please try again.'
}

export default function SetPasswordPage() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [email, setEmail] = useState('')
  const welcome = useQueryParam('welcome') === '1'
  const next = safeNextPath(useQueryParam('next'))
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setEmail(data.session.user.email ?? '')
        setPhase('ready')
      } else {
        setPhase('no-session')
      }
    })
  }, [])

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

    setSaving(true)
    const supabase = getSupabaseBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(friendlyUpdateError(updateError))
      setSaving(false)
      return
    }

    // A full navigation (not router.replace) so the auth context reloads the
    // profile fresh — an invitee's ship.profiles row was only just created by
    // claim_invite in /auth/confirm.
    window.location.assign(next ?? '/projects')
  }

  if (phase === 'checking') {
    return (
      <main className={PAGE_SHELL}>
        <p className="text-sm text-slate-500">Loading...</p>
      </main>
    )
  }

  if (phase === 'no-session') {
    return (
      <main className={PAGE_SHELL}>
        <div className={`${CARD} text-center`}>
          <Eyebrow />
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            This link has expired
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Links in our emails work once and only for a limited time. Ask for a new
            password link, or sign in if you already have a password.
          </p>
          <Link
            href="/auth/forgot"
            className="mt-6 inline-block w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg"
          >
            Send me a new link
          </Link>
          <Link
            href="/"
            className="mt-4 inline-block text-sm font-medium text-teal-700 hover:text-teal-800"
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
            {welcome ? 'Welcome! Choose a password' : 'Choose a new password'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {email ? (
              <>
                For <span className="font-medium text-slate-800">{email}</span>. You&apos;ll
                use it to sign in from now on.
              </>
            ) : (
              "You'll use it to sign in from now on."
            )}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Hidden username field so password managers file the new
              password under the right account. */}
          <input
            type="email"
            name="username"
            autoComplete="username"
            value={email}
            readOnly
            hidden
          />
          <div>
            <label
              htmlFor="new-password"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              New password
            </label>
            <input
              id="new-password"
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
              htmlFor="confirm-password"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Confirm password
            </label>
            <input
              id="confirm-password"
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

          <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
            {saving ? 'Saving...' : 'Save password and continue'}
          </button>
        </form>
      </div>
    </main>
  )
}
