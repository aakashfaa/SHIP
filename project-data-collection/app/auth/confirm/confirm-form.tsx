'use client'

import { useState } from 'react'
import { CARD, Eyebrow, PAGE_SHELL, PRIMARY_BUTTON } from '../auth-shell'

// The Continue card for /auth/confirm (links with no password to choose:
// signup, email, magiclink, email_change; invite/recovery use
// password-link-form.tsx). A plain HTML form POST (works with
// JavaScript off; mail scanners don't submit forms). The only JS is
// disabling the button after the first press so a double-click can't send
// the one-time token twice.

export function ConfirmForm(props: {
  heading: string
  body: string
  tokenHash: string
  type: string
  next: string | null
}) {
  const [submitting, setSubmitting] = useState(false)

  return (
    <main className={PAGE_SHELL}>
      <div className={CARD}>
        <Eyebrow />
        <h1 className="mb-2 text-2xl font-semibold text-slate-900">{props.heading}</h1>
        <p className="mb-6 text-sm text-slate-600">{props.body}</p>
        <form
          method="post"
          action="/auth/confirm/verify"
          onSubmit={(e) => {
            if (submitting) e.preventDefault()
            else setSubmitting(true)
          }}
        >
          <input type="hidden" name="token_hash" value={props.tokenHash} />
          <input type="hidden" name="type" value={props.type} />
          {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
          <button type="submit" className={PRIMARY_BUTTON} disabled={submitting}>
            {submitting ? 'Continuing…' : 'Continue'}
          </button>
        </form>
      </div>
    </main>
  )
}
