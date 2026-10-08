'use client'

import { useState } from 'react'
import Link from 'next/link'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import {
  authErrorFromHash,
  readAuthErrorCode,
  type AuthErrorCode,
} from '@/lib/supabase/redirects'
import { useLocationHash, useQueryParam } from '@/lib/supabase/use-location'

// The sign-in card on `/`.
//
// Navigation after a successful sign-in is deliberately NOT done here. The
// page (`app/page.tsx`) redirects as soon as the auth context has loaded the
// ship.profiles row — to `?next=` if it's a safe same-origin path, else
// /projects, or /no-access. Navigating from here, before the profile arrived,
// is what caused the /projects → / → /projects bounce with a flash of an
// empty sign-in form (UX-7). Until then the button simply stays on
// "Signing in...".
//
// `?auth_error=` (set by /auth/confirm and /auth/callback when an email link
// is expired, already used, or mangled) and Supabase's own `#error_code=`
// fragment become a plain-language banner instead of the silent "nothing
// happened" users used to get (UX-5).

const BANNERS: Record<AuthErrorCode, string> = {
  link_expired:
    "That link has expired or has already been used. Sign in with your password, or reset it below. If you were invited and haven't set a password yet, ask your project admin to resend the invite.",
  link_invalid:
    "That link didn't work. It may have been copied incompletely. Try the button in the email again, or sign in below.",
  session_expired: 'You were signed out. Please sign in again.',
}

function friendlySignInError(error: { code?: string; message: string }): string {
  if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message)) {
    return "That email and password don't match. Try again, or reset your password."
  }
  if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message)) {
    return 'Please confirm your email first. Check your inbox for the link we sent.'
  }
  if (error.code === 'over_request_rate_limit' || error.code === 'too_many_requests') {
    return 'Too many attempts. Please wait a minute and try again.'
  }
  return 'Could not sign you in. Please try again.'
}

export default function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [loading, setLoading] = useState(false)

  const authErrorParam = useQueryParam('auth_error')
  const hash = useLocationHash()
  const banner: AuthErrorCode | null = bannerDismissed
    ? null
    : (readAuthErrorCode(authErrorParam) ?? authErrorFromHash(hash))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setBannerDismissed(true)

    const supabase = getSupabaseBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (signInError) {
      setError(friendlySignInError(signInError))
      setLoading(false)
      return
    }
    // Success: stay in the "Signing in..." state; app/page.tsx redirects
    // once the profile has loaded.
  }

  const forgotHref = email.trim()
    ? `/auth/forgot?email=${encodeURIComponent(email.trim())}`
    : '/auth/forgot'

  return (
    <div className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
      <div className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">
          Master Plan Dashboard
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
          Welcome back
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Sign in to access your project workspaces, line-item data, and package views.
        </p>
      </div>

      {banner ? (
        <div
          role="alert"
          data-testid="auth-error-banner"
          className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"
        >
          {BANNERS[banner]}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="login-email"
            className="mb-2 block text-sm font-medium text-slate-700"
          >
            Email
          </label>
          <input
            id="login-email"
            name="email"
            autoComplete="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your email"
            className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
          />
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <label
              htmlFor="login-password"
              className="block text-sm font-medium text-slate-700"
            >
              Password
            </label>
            <Link
              href={forgotHref}
              className="text-sm font-medium text-teal-700 hover:text-teal-800"
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="login-password"
            name="password"
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
          />
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <div className="mt-6 text-center text-sm text-slate-600">
        First time here?{' '}
        <Link href="/auth/sign-up" className="font-medium text-teal-700 hover:text-teal-800">
          Set up your account
        </Link>
      </div>
    </div>
  )
}
