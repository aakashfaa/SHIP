'use client'

import { InviteResult, describeInvite } from './invites'

type Props = {
  results: InviteResult[]
  invitingEmails: Set<string>
  copiedEmail: string | null
  onClear: () => void
  onResend: (email: string) => void
  onCopyLink: (link: string, email: string) => void
}

export default function InviteResults({
  results,
  invitingEmails,
  copiedEmail,
  onClear,
  onResend,
  onCopyLink,
}: Props) {
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
      data-testid="invite-results"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-800">Invites</p>
        <button
          type="button"
          onClick={onClear}
          className="text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          Clear
        </button>
      </div>
      <ul className="mt-2 divide-y divide-slate-100">
        {results.map((result) => {
          const info = describeInvite(result)
          const busy = invitingEmails.has(result.email)
          return (
            <li key={result.email} className="py-2 text-sm" data-testid="invite-result">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-slate-900">{result.email}</span>
                <div className="flex items-center gap-2">
                  {result.actionLink ? (
                    <button
                      type="button"
                      onClick={() => onCopyLink(result.actionLink as string, result.email)}
                      className="rounded-xl bg-black px-3 py-1.5 text-xs font-medium text-white"
                    >
                      {copiedEmail === result.email ? 'Copied' : 'Copy set-up link'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onResend(result.email)}
                    className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50"
                  >
                    {busy ? 'Sending...' : 'Resend'}
                  </button>
                </div>
              </div>
              <p
                className={`mt-1 text-xs ${
                  info.tone === 'bad'
                    ? 'text-rose-600'
                    : info.tone === 'warn'
                      ? 'text-amber-700'
                      : 'text-emerald-700'
                }`}
              >
                {info.text}
              </p>
            </li>
          )
        })}
      </ul>
      {results.some((r) => r.actionLink) ? (
        <p className="mt-2 text-xs text-slate-500">
          A set-up link signs that person in once, so only send it to them directly.
        </p>
      ) : null}
    </div>
  )
}
