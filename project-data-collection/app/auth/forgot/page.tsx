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
} from '../auth-shell'

// "Forgot password?" (M-17). Posts to /api/auth/forgot, which emails a
// one-time reset link through our own mailer (D-6). The answer shown here is
// always the same neutral sentence, whether or not the email has an account,
// so this page can't be used to find out who uses the product.

export default function ForgotPasswordPage() {
  // null = not typed yet, so show the address carried over from the sign-in
  // form (`/auth/forgot?email=`).
  const [typedEmail, setTypedEmail] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [sentMessage, setSentMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const prefill = useQueryParam('email') ?? ''
  const next = useQueryParam('next')
  const email = typedEmail ?? prefill
  const setEmail = setTypedEmail

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const trimmed = email.trim()
    if (!trimmed) {
      setError('Enter the email address you sign in with.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, next }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        message?: string
        error?: string
      }
      if (!res.ok) {
        setError(payload.error ?? 'Something went wrong. Please try again.')
        return
      }
      setSentMessage(payload.message ?? 'If that email has an account here, a reset link is on its way.')
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className={PAGE_SHELL}>
      <div className={CARD}>
        <div className="mb-8">
          <Eyebrow />
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
            Reset your password
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Enter the email you sign in with and we&apos;ll send you a link to choose a new
            password.
          </p>
        </div>

        {sentMessage ? (
          <div className="space-y-4">
            <InfoNote>{sentMessage}</InfoNote>
            <button
              type="button"
              onClick={() => setSentMessage('')}
              className="w-full text-center text-sm font-medium text-teal-700 hover:text-teal-800"
            >
              Didn&apos;t get it? Send again
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="forgot-email" className="mb-2 block text-sm font-medium text-slate-700">
                Email
              </label>
              <input
                id="forgot-email"
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

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
              {submitting ? 'Sending...' : 'Send reset link'}
            </button>
          </form>
        )}

        <div className="mt-6 text-center text-sm text-slate-600">
          Remembered it?{' '}
          <Link href="/" className="font-medium text-teal-700 hover:text-teal-800">
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  )
}
