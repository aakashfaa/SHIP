'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

type Status = 'idle' | 'submitting' | 'check-email' | 'no-invite'

const PAGE_SHELL =
  'flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4'

const CARD =
  'w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 text-center shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl'

export default function SignUpPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<Status>('idle')

  const loading = status === 'submitting'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setStatus('submitting')

    const supabase = getSupabaseBrowserClient()
    const normalizedEmail = email.trim().toLowerCase()

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (signUpError) {
      setError(signUpError.message)
      setStatus('idle')
      return
    }

    // Email confirmation is enabled on this project and no session was
    // issued yet. The invite gets claimed in app/auth/callback/route.ts
    // once the user clicks the confirmation link.
    if (!data.session) {
      setStatus('check-email')
      return
    }

    const { error: claimError } = await supabase.rpc('claim_invite')

    if (claimError) {
      // 42501 is Postgres's "insufficient privilege" code, which
      // claim_invite raises deliberately when there's no matching
      // pending_invites row. That's the allowlist working as intended,
      // not a bug — show a normal, expected message instead of a generic
      // error.
      if (claimError.code === '42501') {
        setStatus('no-invite')
        return
      }
      setError(claimError.message)
      setStatus('idle')
      return
    }

    router.replace('/projects')
  }

  if (status === 'check-email') {
    return (
      <main className={PAGE_SHELL}>
        <div className={CARD}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
            Master Plan Dashboard
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            Check your email
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            We sent a confirmation link to{' '}
            <span className="font-medium">{email.trim()}</span>. Click it to finish setting
            up your account.
          </p>
        </div>
      </main>
    )
  }

  if (status === 'no-invite') {
    return (
      <main className={PAGE_SHELL}>
        <div className={CARD}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
            Master Plan Dashboard
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            Not invited yet
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            This email hasn&apos;t been invited to SHIP yet. Ask your project admin to add
            it, then come back and set up your account again.
          </p>
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
      <div className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
        <div className="mb-8">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
            Master Plan Dashboard
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
            Set up your account
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Use the email your project admin invited to SHIP.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a password"
              className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Confirm password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your password"
              className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
            />
          </div>

          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Create account'}
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
