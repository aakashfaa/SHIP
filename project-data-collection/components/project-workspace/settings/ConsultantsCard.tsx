'use client'

import { ProjectConsultant } from '@/lib/types'

type Props = {
  consultants: ProjectConsultant[]
  invitingEmails: Set<string>
  onAdd: () => void
  onEditOrg: (type: ProjectConsultant['type']) => void
  onRemoveOrg: (type: ProjectConsultant['type']) => void
  onRemoveEmail: (type: ProjectConsultant['type'], email: string) => void
  onResend: (email: string) => void
}

// Icon buttons stay out of the way until the row is hovered or focused.
const REVEAL =
  'opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'
const ICON_BTN =
  'flex h-6 w-6 flex-none items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40'

export default function ConsultantsCard({
  consultants,
  invitingEmails,
  onAdd,
  onEditOrg,
  onRemoveOrg,
  onRemoveEmail,
  onResend,
}: Props) {
  return (
    <section
      aria-label="Consultants"
      className="rounded-2xl border border-slate-200 bg-white/70 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-slate-950">Consultants</h3>
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add consultants"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-black text-white transition hover:bg-slate-700"
        >
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M10 4v12M4 10h12" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <ul className="mt-3 space-y-3">
        {consultants.map((consultant) => (
          <li key={consultant.type}>
            <div className="group flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-slate-900">
                {consultant.orgName || consultant.type}
                {consultant.orgName ? (
                  <span className="ml-2 text-xs font-normal text-slate-400">{consultant.type}</span>
                ) : null}
              </p>
              <div className={`flex flex-none items-center ${REVEAL}`}>
              <button
                type="button"
                onClick={() => onEditOrg(consultant.type)}
                aria-label={`Edit ${consultant.orgName || consultant.type}`}
                className={ICON_BTN}
              >
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4 16l1-4 8.5-8.5a1.4 1.4 0 012 2L7 14l-3 2z" strokeLinejoin="round" />
                </svg>
              </button>
                {consultant.type !== 'Architecture' ? (
                  <button
                    type="button"
                    onClick={() => onRemoveOrg(consultant.type)}
                    aria-label={`Remove organization ${consultant.orgName || consultant.type}`}
                    title="Remove organization"
                    className={ICON_BTN}
                  >
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                ) : null}
              </div>
            </div>
            {consultant.emails.length === 0 ? (
              <p className="text-xs text-slate-400">—</p>
            ) : (
              <ul className="mt-1 space-y-0.5 border-l border-slate-100 pl-3">
                {consultant.emails.map((email) => (
                  <li key={email} className="group flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[13px] leading-tight text-slate-700">{email}</p>
                    <div className={`flex flex-none items-center ${REVEAL}`}>
                      <button
                        type="button"
                        disabled={invitingEmails.has(email)}
                        onClick={() => onResend(email)}
                        aria-label={`Resend invite to ${email}`}
                        title="Resend invite"
                        className={ICON_BTN}
                      >
                        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M3 5h14v10H3zM3 5l7 6 7-6" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveEmail(consultant.type, email)}
                        aria-label={`Remove ${email}`}
                        className={ICON_BTN}
                      >
                        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
