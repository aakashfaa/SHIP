'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

// "You're signed in, but not set up here."
//
// Fixed in M-31:
// - Sign out actually goes somewhere (auth-context's signOut now always ends
//   on `/`); before, the session cleared but this page stayed put.
// - "Check again" goes to /projects when the claim succeeds. It used to
//   reload /no-access, which has no "you're fine now" logic, so success
//   looked identical to failure.
// - The page redirects by itself when there's nothing to show: a loaded user
//   goes to /projects, no session at all goes to `/` (back button, bookmark).
// - A deactivated account gets its own copy and no "Check again" button —
//   claim_invite returns the existing (inactive) profile, so retrying could
//   never change anything.

export default function NoAccessPage() {
  const router = useRouter()
  const { user, loading, noAccess, deactivated, unconfirmed, signOut } = useAuth()
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [checking, setChecking] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [checkError, setCheckError] = useState('')
  const [email, setEmail] = useState('')

  useEffect(() => {
    if (loading) return
    if (user) {
      router.replace('/projects')
      return
    }
    if (!noAccess) router.replace('/')
  }, [user, loading, noAccess, router])

  useEffect(() => {
    void getSupabaseBrowserClient()
      .auth.getSession()
      .then(({ data }) => setEmail(data.session?.user.email ?? ''))
  }, [])

  async function handleRetry() {
    setChecking(true)
    setCheckError('')

    const supabase = getSupabaseBrowserClient()
    const { error } = await supabase.rpc('claim_invite')

    if (error) {
      // 42501 means there's still no matching pending_invites row — the
      // admin hasn't added this email yet. That's expected, not a bug.
      if (error.code === '42501') {
        setCheckError(
          "This email still isn't on the invite list. Ask your project admin to add it, then check again."
        )
      } else {
        setCheckError('Something went wrong checking access. Please try again.')
      }
      setChecking(false)
      return
    }

    // A full navigation so the auth context reloads the new profile.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- see above
    window.location.assign('/projects')
  }

  async function handleResendConfirmation() {
    setCheckError('')
    setResendState('sending')
    try {
      const res = await fetch('/api/auth/resend-confirmation', { method: 'POST' })
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setCheckError(payload.error ?? 'Could not send the email. Please try again.')
        setResendState('idle')
        return
      }
      setResendState('sent')
    } catch {
      setCheckError("Couldn't reach the server. Check your connection and try again.")
      setResendState('idle')
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    await signOut()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4">
      <div className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 text-center shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">
          Master Plan Dashboard
        </p>

        {unconfirmed && !deactivated ? (
          <>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
              Confirm your email first
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Before you can join, we need to know
              {email ? <span className="font-medium text-slate-800"> {email}</span> : ' this address'}{' '}
              is yours. Click the link in the email we sent you, or send a new one.
            </p>
            {resendState === 'sent' ? (
              <div
                role="status"
                className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
              >
                Sent. Check your inbox (and spam folder) for the link.
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => void handleResendConfirmation()}
              disabled={resendState === 'sending'}
              className="mt-6 w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50"
            >
              {resendState === 'sending' ? 'Sending...' : 'Send me the link again'}
            </button>
          </>
        ) : deactivated ? (
          <>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
              Your access has been turned off
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              An administrator has turned off access for
              {email ? <span className="font-medium text-slate-800"> {email}</span> : ' this account'}.
              If you think this is a mistake, contact your project admin.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
              You&apos;re signed in, but not set up here
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {email ? (
                <>
                  <span className="font-medium text-slate-800">{email}</span> doesn&apos;t
                  have access to this workspace yet.
                </>
              ) : (
                <>This account doesn&apos;t have access to this workspace yet.</>
              )}{' '}
              Ask your project admin to add this email, then check again below. Signed in
              with the wrong email? Sign out and use the one you were invited with.
            </p>
          </>
        )}

        {checkError ? (
          <div
            role="alert"
            className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            {checkError}
          </div>
        ) : null}

        {!deactivated && !unconfirmed ? (
          <button
            type="button"
            onClick={() => {
              void handleRetry()
            }}
            disabled={checking}
            className="mt-6 w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50"
          >
            {checking ? 'Checking...' : 'Check again'}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => {
            void handleSignOut()
          }}
          disabled={signingOut}
          className={`${deactivated ? 'mt-6' : 'mt-3'} w-full rounded-2xl border border-slate-200 bg-white/60 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-white/90 disabled:opacity-50`}
        >
          {signingOut ? 'Signing out...' : 'Sign out'}
        </button>
      </div>
    </main>
  )
}
