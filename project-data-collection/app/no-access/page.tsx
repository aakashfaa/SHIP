'use client'

import { useState } from 'react'
import { useAuth } from '@/lib/auth-context'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

export default function NoAccessPage() {
  const { signOut } = useAuth()
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')

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
          "Still not on the invite list. Ask your project admin to add this email, then try again."
        )
      } else {
        setCheckError('Something went wrong checking access. Please try again.')
      }
      setChecking(false)
      return
    }

    window.location.reload()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4">
      <div className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 text-center shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
          Master Plan Dashboard
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
          You&apos;re signed in, but not set up here
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          This account doesn&apos;t have access to this workspace yet. Reach out to your
          project admin and ask them to add your email, then check again below.
        </p>

        {checkError ? (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {checkError}
          </div>
        ) : null}

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

        <button
          type="button"
          onClick={() => {
            void signOut()
          }}
          className="mt-3 w-full rounded-2xl border border-slate-200 bg-white/60 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-white/90"
        >
          Sign out
        </button>
      </div>
    </main>
  )
}
