'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { CONSULTANT_TYPES } from '@/lib/constants'
import { createProject } from '@/lib/store'
import { ConsultantType, Project, ProjectConsultant } from '@/lib/types'

type ConsultantDraft = ProjectConsultant & {
  emailInput: string
  // Inline error for the email box (bad format); cleared on the next keystroke.
  emailError?: string | null
}

type InviteResult = {
  email: string
  invited: boolean
  alreadyExisted: boolean
  actionLink: string | null
  error: string | null
}

const createConsultantDraft = (
  type: ConsultantType,
  orgName = '',
  emails: string[] = []
): ConsultantDraft => ({
  type,
  orgName,
  emails,
  emailInput: '',
})

// Deliberately simple: one @, no spaces, a dot in the domain. The server is the
// real authority; this just catches typos before they are stored and invited.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const CONSULTANT_THEME: Record<
  ConsultantType,
  {
    selectedChip: string
    card: string
    badge: string
    button: string
    chip: string
  }
> = {
  Architecture: {
    selectedChip: 'bg-amber-500 text-white',
    card: 'border-amber-200 bg-amber-50/70',
    badge: 'text-amber-950',
    button: 'bg-amber-500 text-white',
    chip: 'bg-amber-100 text-amber-900',
  },
  Accessibility: {
    selectedChip: 'bg-emerald-700 text-white',
    card: 'border-emerald-200 bg-emerald-50/70',
    badge: 'text-emerald-950',
    button: 'bg-emerald-700 text-white',
    chip: 'bg-emerald-100 text-emerald-900',
  },
  Civil: {
    selectedChip: 'bg-rose-500 text-white',
    card: 'border-rose-200 bg-rose-50/70',
    badge: 'text-rose-950',
    button: 'bg-rose-500 text-white',
    chip: 'bg-rose-100 text-rose-900',
  },
  Electrical: {
    selectedChip: 'bg-violet-600 text-white',
    card: 'border-violet-200 bg-violet-50/70',
    badge: 'text-violet-950',
    button: 'bg-violet-600 text-white',
    chip: 'bg-violet-100 text-violet-900',
  },
  Envelope: {
    selectedChip: 'bg-sky-700 text-white',
    card: 'border-sky-200 bg-sky-50/70',
    badge: 'text-sky-950',
    button: 'bg-sky-700 text-white',
    chip: 'bg-sky-100 text-sky-900',
  },
  'Fire Alarm': {
    selectedChip: 'bg-red-600 text-white',
    card: 'border-red-200 bg-red-50/70',
    badge: 'text-red-950',
    button: 'bg-red-600 text-white',
    chip: 'bg-red-100 text-red-900',
  },
  'Hazardous Materials': {
    selectedChip: 'bg-orange-700 text-white',
    card: 'border-orange-200 bg-orange-50/70',
    badge: 'text-orange-950',
    button: 'bg-orange-700 text-white',
    chip: 'bg-orange-100 text-orange-900',
  },
  'Historic Preservation': {
    selectedChip: 'bg-stone-600 text-white',
    card: 'border-stone-200 bg-stone-50/70',
    badge: 'text-stone-950',
    button: 'bg-stone-600 text-white',
    chip: 'bg-stone-100 text-stone-900',
  },
  Landscape: {
    selectedChip: 'bg-lime-600 text-white',
    card: 'border-lime-200 bg-lime-50/70',
    badge: 'text-lime-950',
    button: 'bg-lime-600 text-white',
    chip: 'bg-lime-100 text-lime-900',
  },
  Mechanical: {
    selectedChip: 'bg-emerald-600 text-white',
    card: 'border-emerald-200 bg-emerald-50/70',
    badge: 'text-emerald-950',
    button: 'bg-emerald-600 text-white',
    chip: 'bg-emerald-100 text-emerald-900',
  },
  Plumbing: {
    selectedChip: 'bg-cyan-600 text-white',
    card: 'border-cyan-200 bg-cyan-50/70',
    badge: 'text-cyan-950',
    button: 'bg-cyan-600 text-white',
    chip: 'bg-cyan-100 text-cyan-900',
  },
  Structural: {
    selectedChip: 'bg-blue-600 text-white',
    card: 'border-blue-200 bg-blue-50/70',
    badge: 'text-blue-950',
    button: 'bg-blue-600 text-white',
    chip: 'bg-blue-100 text-blue-900',
  },
  Security: {
    selectedChip: 'bg-slate-700 text-white',
    card: 'border-slate-200 bg-slate-50/80',
    badge: 'text-slate-950',
    button: 'bg-slate-700 text-white',
    chip: 'bg-slate-100 text-slate-900',
  },
  Telecom: {
    selectedChip: 'bg-teal-700 text-white',
    card: 'border-teal-200 bg-teal-50/70',
    badge: 'text-teal-950',
    button: 'bg-teal-700 text-white',
    chip: 'bg-teal-100 text-teal-900',
  },
}

function getConsultantTheme(type: ConsultantType) {
  return CONSULTANT_THEME[type]
}

export default function NewProjectPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [projectName, setProjectName] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [consultants, setConsultants] = useState<ConsultantDraft[]>([
    createConsultantDraft('Architecture', 'FAA'),
  ])

  const [createdProject, setCreatedProject] = useState<Project | null>(null)
  const [invitedEmails, setInvitedEmails] = useState<string[]>([])
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(null)
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null)

  useEffect(() => {
    if (authLoading) return

    if (!user) {
      router.replace('/')
      return
    }

    if (user.role !== 'admin') {
      router.replace('/projects')
    }
  }, [user, authLoading, router])

  const selectedTypes = useMemo(
    () => consultants.map((consultant) => consultant.type),
    [consultants]
  )

  if (authLoading || !user || user.role !== 'admin') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  function updateConsultant(
    type: ConsultantType,
    field: keyof ConsultantDraft,
    value: string | string[] | null
  ) {
    setConsultants((prev) =>
      prev.map((consultant) =>
        consultant.type === type ? { ...consultant, [field]: value } : consultant
      )
    )
  }

  function addConsultantType(type: ConsultantType) {
    if (selectedTypes.includes(type)) return
    setConsultants((prev) => [...prev, createConsultantDraft(type)])
  }

  function removeConsultant(type: ConsultantType) {
    if (type === 'Architecture') return
    setConsultants((prev) =>
      prev.filter((consultant) => consultant.type !== type)
    )
  }

  function addEmail(type: ConsultantType) {
    const consultant = consultants.find((item) => item.type === type)
    if (!consultant) return

    const email = consultant.emailInput.trim().toLowerCase()
    if (!email) return
    if (!EMAIL_PATTERN.test(email)) {
      updateConsultant(type, 'emailError', `"${email}" isn't a valid email address.`)
      return
    }
    if (consultant.emails.includes(email)) {
      updateConsultant(type, 'emailError', `${email} is already in the list.`)
      return
    }

    setConsultants((prev) =>
      prev.map((item) =>
        item.type === type
          ? {
              ...item,
              emails: [...item.emails, email],
              emailInput: '',
              emailError: null,
            }
          : item
      )
    )
  }

  function removeEmail(type: ConsultantType, emailToRemove: string) {
    const consultant = consultants.find((item) => item.type === type)
    if (!consultant) return

    updateConsultant(
      type,
      'emails',
      consultant.emails.filter((email) => email !== emailToRemove)
    )
  }

  function validateForm(): string | null {
    if (!projectName.trim()) {
      return 'Please enter a project name.'
    }

    for (const consultant of consultants) {
      // Text typed into the email box but never added would be silently lost.
      if (consultant.emailInput.trim()) {
        return `You typed "${consultant.emailInput.trim()}" for ${consultant.type} but didn't add it. Click Add (or press Enter) to add it, or clear the box.`
      }
      if (!consultant.orgName.trim()) {
        return `Please enter an organization name for ${consultant.type}.`
      }

      if (consultant.emails.length === 0) {
        return `Please add at least one email for ${consultant.type}.`
      }
    }

    return null
  }

  async function sendInvites(emails: string[]) {
    setInviteLoading(true)
    setInviteError(null)

    try {
      const res = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      })

      if (!res.ok) {
        throw new Error(`Invite request failed with status ${res.status}`)
      }

      const payload = (await res.json()) as { results: InviteResult[] }
      setInviteResults(payload.results)
    } catch (err) {
      // Non-fatal: the project already exists. The admin can invite these
      // consultants manually later.
      setInviteError(
        err instanceof Error ? err.message : 'Failed to send invites.'
      )
    } finally {
      setInviteLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)

    const validationError = validateForm()
    if (validationError) {
      setFormError(validationError)
      return
    }

    setSubmitting(true)

    try {
      const result = await createProject({
        name: projectName,
        consultants: consultants.map((consultant) => ({
          type: consultant.type,
          orgName: consultant.orgName,
          emails: consultant.emails,
        })),
      })

      setCreatedProject(result.project)
      setInvitedEmails(result.invitedEmails)
      setSubmitting(false)

      if (result.invitedEmails.length > 0) {
        await sendInvites(result.invitedEmails)
      }
    } catch (err) {
      setSubmitting(false)
      setFormError(
        err instanceof Error ? err.message : 'Failed to create project.'
      )
    }
  }

  async function copyToClipboard(value: string, email: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedEmail(email)
      window.setTimeout(() => setCopiedEmail(null), 1800)
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the link
      // text is still selectable/visible, so this is a soft failure.
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_24%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_26%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_46%,_#eef2f7_100%)] px-4 py-6 md:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 overflow-hidden rounded-[2rem] border border-white/70 bg-white/72 px-6 py-6 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
              New Project
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
              Create Project
            </h1>
          </div>

          <Link
            href="/projects"
            className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300"
          >
            Back
          </Link>
          </div>
        </div>

        {createdProject ? (
          <div className="mb-6 rounded-[2rem] border border-emerald-200 bg-emerald-50/90 p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-emerald-900">
              Project created
            </h2>
            <p className="mt-1 text-sm text-emerald-800">
              {invitedEmails.length > 0
                ? "The consultants below have been invited and will receive a set-up link by email."
                : 'No new consultant accounts were needed — every email already has access.'}
            </p>

            {inviteLoading ? (
              <p className="mt-4 text-sm text-emerald-700">Sending invites...</p>
            ) : null}

            {inviteError ? (
              <div className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                The project was created, but sending invites failed ({inviteError}).
                You can invite these consultants manually from Settings.
              </div>
            ) : null}

            {inviteResults && inviteResults.length > 0 ? (
              <div className="mt-4 space-y-2">
                {inviteResults.map((result) => (
                  <div
                    key={result.email}
                    className="rounded-2xl bg-white px-4 py-3 text-sm text-emerald-900"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{result.email}</span>
                      {result.error ? (
                        <span className="text-xs text-rose-600">
                          Invite failed: {result.error}
                        </span>
                      ) : result.alreadyExisted ? (
                        <span className="text-xs text-slate-500">
                          Already has an account
                        </span>
                      ) : (
                        <span className="text-xs text-emerald-600">Invited</span>
                      )}
                    </div>

                    {result.actionLink ? (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          readOnly
                          value={result.actionLink}
                          onFocus={(e) => e.currentTarget.select()}
                          className="flex-1 truncate rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            copyToClipboard(result.actionLink as string, result.email)
                          }
                          className="whitespace-nowrap rounded-xl bg-black px-3 py-2 text-xs font-medium text-white"
                        >
                          {copiedEmail === result.email ? 'Copied' : 'Copy set-up link'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mt-5">
              <Link
                href={`/projects/${createdProject.id}`}
                className="inline-flex rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
              >
                Go to project
              </Link>
            </div>
          </div>
        ) : null}

        {!createdProject ? (
          <form onSubmit={handleSubmit} className="space-y-5">
            {formError ? (
              <div className="rounded-[2rem] border border-rose-200 bg-rose-50/90 px-5 py-4 text-sm text-rose-700 shadow-sm">
                {formError}
              </div>
            ) : null}

            <div className="rounded-[2rem] border border-white/70 bg-white/76 p-5 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
              <input
                id="project-name"
                name="project-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Project name"
                className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
              />
            </div>

            <div className="rounded-[2rem] border border-white/70 bg-white/76 p-5 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
              <div className="flex flex-wrap gap-3">
                {CONSULTANT_TYPES.map((type) => {
                  const isSelected = selectedTypes.includes(type)
                  const theme = getConsultantTheme(type)

                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => !isSelected && addConsultantType(type)}
                      disabled={isSelected}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                        isSelected
                          ? theme.selectedChip
                          : 'border border-slate-300 bg-white/95 text-slate-700 hover:-translate-y-[1px] hover:border-slate-400'
                      }`}
                    >
                      {type}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid gap-5">
              {consultants.map((consultant) => {
                const theme = getConsultantTheme(consultant.type)

                return (
                <div
                  key={consultant.type}
                  className={`rounded-[2rem] border p-5 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl ${theme.card}`}
                >
                  <div className="mb-5 flex items-start justify-between gap-4">
                    <div>
                      <h2 className={`text-xl font-semibold ${theme.badge}`}>
                        {consultant.type}
                      </h2>
                    </div>

                    {consultant.type !== 'Architecture' ? (
                      <button
                        type="button"
                        onClick={() => removeConsultant(consultant.type)}
                        className="rounded-full border border-rose-200 px-3 py-1 text-sm font-medium text-rose-600 hover:bg-rose-50"
                      >
                        Remove
                      </button>
                    ) : (
                      <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">
                        Default
                      </div>
                    )}
                  </div>

                  <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
                    <div>
                      <input
                        id={`org-name-${consultant.type}`}
                        name={`org-name-${consultant.type}`}
                        value={consultant.orgName}
                        onChange={(e) =>
                          updateConsultant(
                            consultant.type,
                            'orgName',
                            e.target.value
                          )
                        }
                        placeholder="Organization"
                        className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
                      />
                    </div>

                    <div>
                      <div className="flex gap-2">
                        <input
                          id={`email-input-${consultant.type}`}
                          name={`email-input-${consultant.type}`}
                          value={consultant.emailInput}
                          onChange={(e) =>
                            setConsultants((prev) =>
                              prev.map((item) =>
                                item.type === consultant.type
                                  ? {
                                      ...item,
                                      emailInput: e.target.value,
                                      emailError: null,
                                    }
                                  : item
                              )
                            )
                          }
                          onKeyDown={(e) => {
                            // Enter adds the email; it must never submit (create) the project.
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addEmail(consultant.type)
                            }
                          }}
                          aria-invalid={consultant.emailError ? true : undefined}
                          placeholder="name@company.com"
                          className="flex-1 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
                        />
                        <button
                          type="button"
                          onClick={() => addEmail(consultant.type)}
                          className={`rounded-2xl px-4 py-3 text-sm font-medium ${theme.button}`}
                        >
                          Add
                        </button>
                      </div>
                      {consultant.emailError && (
                        <p role="alert" className="mt-2 text-xs text-red-600">
                          {consultant.emailError}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-4">
                    {consultant.emails.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {consultant.emails.map((email) => (
                          <div
                            key={email}
                            className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs ${theme.chip}`}
                          >
                            <span>{email}</span>
                            <button
                              type="button"
                              onClick={() => removeEmail(consultant.type, email)}
                              className="text-gray-500"
                              aria-label={`Remove ${email}`}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-sm text-slate-400">
                        No emails yet
                      </div>
                    )}
                  </div>
                </div>
              )})}
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-6 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50"
              >
                {submitting ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </main>
  )
}
