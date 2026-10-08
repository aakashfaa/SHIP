'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Modal from '@/components/ui/Modal'
import { useAuth } from '@/lib/auth-context'
import {
  CONSULTANT_TYPES,
  MAX_DISCIPLINE_LENGTH,
  customDisciplineError,
  isKnownConsultantType,
  normalizeDisciplineName,
} from '@/lib/constants'
import { createProject } from '@/lib/store'
import { ConsultantType, KnownConsultantType, ProjectConsultant, SafeUser } from '@/lib/types'

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

// Architecture is FAA's own discipline: always on the project.
const OWN_DISCIPLINE: KnownConsultantType = 'Architecture'

type Theme = {
  selectedChip: string
  card: string
  badge: string
  button: string
  chip: string
}

const CONSULTANT_THEME: Record<KnownConsultantType, Theme> = {
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

// Custom ("Other") disciplines share one neutral look.
const CUSTOM_THEME: Theme = {
  selectedChip: 'bg-slate-900 text-white',
  card: 'border-slate-200 bg-white/80',
  badge: 'text-slate-950',
  button: 'bg-slate-900 text-white',
  chip: 'bg-slate-100 text-slate-900',
}

function getConsultantTheme(type: ConsultantType): Theme {
  return isKnownConsultantType(type) ? CONSULTANT_THEME[type] : CUSTOM_THEME
}

const INPUT =
  'w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100'
const CARD =
  'rounded-[2rem] border border-white/70 bg-white/76 p-5 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl'
const IDLE_CHIP =
  'border border-slate-300 bg-white/95 text-slate-700 hover:-translate-y-[1px] hover:border-slate-400'

export default function NewProjectPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()

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

  if (authLoading || !user || user.role !== 'admin') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  // Mounted only once the user is known, so the form can start with their
  // email already on Architecture.
  return <NewProjectForm user={user} />
}

function NewProjectForm({ user }: { user: SafeUser }) {
  const router = useRouter()
  const [projectName, setProjectName] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [consultants, setConsultants] = useState<ConsultantDraft[]>(() => [
    createConsultantDraft(OWN_DISCIPLINE, 'FAA', user.email ? [user.email.toLowerCase()] : []),
  ])

  // "Other" discipline entry.
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherName, setOtherName] = useState('')
  const [otherError, setOtherError] = useState<string | null>(null)

  // Discipline awaiting "Are you sure?" before it is dropped.
  const [confirmRemove, setConfirmRemove] = useState<ConsultantType | null>(null)

  // Set only when the project was created but some invites need attention;
  // otherwise the admin goes straight to the new project's Settings.
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(null)
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null)

  const selectedTypes = consultants.map((consultant) => consultant.type)
  const customTypes = selectedTypes.filter((type) => !isKnownConsultantType(type))

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
    if (type === OWN_DISCIPLINE) return
    setConsultants((prev) => prev.filter((consultant) => consultant.type !== type))
  }

  // Clicking a selected chip deselects it; asks first if anything was entered.
  function toggleConsultantType(type: ConsultantType) {
    if (type === OWN_DISCIPLINE) return
    const existing = consultants.find((consultant) => consultant.type === type)
    if (!existing) {
      addConsultantType(type)
      return
    }
    const hasData =
      existing.emails.length > 0 ||
      existing.orgName.trim() !== '' ||
      existing.emailInput.trim() !== ''
    if (hasData) setConfirmRemove(type)
    else removeConsultant(type)
  }

  function addOtherDiscipline() {
    const name = normalizeDisciplineName(otherName)
    const error = customDisciplineError(name, selectedTypes)
    if (error) {
      setOtherError(error)
      return
    }
    addConsultantType(name)
    setOtherName('')
    setOtherError(null)
    setOtherOpen(false)
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

  // Returns true when every invite went out cleanly.
  async function sendInvites(emails: string[], projectId: string): Promise<boolean> {
    try {
      const res = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails, projectId }),
      })

      if (!res.ok) {
        throw new Error(`Invite request failed with status ${res.status}`)
      }

      const payload = (await res.json()) as { results: InviteResult[] }
      setInviteResults(payload.results)
      return payload.results.every((result) => !result.error)
    } catch (err) {
      // Non-fatal: the project already exists. The admin can invite these
      // consultants again from Settings.
      setInviteError(err instanceof Error ? err.message : 'Failed to send invites.')
      return false
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

    let projectId: string
    try {
      const result = await createProject({
        name: projectName,
        consultants: consultants.map((consultant) => ({
          type: consultant.type,
          orgName: consultant.orgName,
          emails: consultant.emails,
        })),
      })
      projectId = result.project.id
    } catch (err) {
      setSubmitting(false)
      setFormError(err instanceof Error ? err.message : 'Failed to create project.')
      return
    }

    // Everyone on the new roster, not just result.invitedEmails: that list
    // only holds addresses that had no pending invite yet, so a person who
    // already has an account would get neither the "added to <project>"
    // email nor the in-app notice. The route works out which is which.
    // The creator (pre-filled on Architecture) is left out: they would only
    // be emailing themselves.
    const self = user.email.toLowerCase()
    const rosterEmails = [
      ...new Set(consultants.flatMap((consultant) => consultant.emails)),
    ].filter((email) => email.toLowerCase() !== self)
    const invitesOk = rosterEmails.length === 0 || (await sendInvites(rosterEmails, projectId))

    const settingsHref = `/projects/${encodeURIComponent(projectId)}?tab=settings`
    if (invitesOk) {
      router.push(settingsHref)
      return
    }
    setSubmitting(false)
    setCreatedProjectId(projectId)
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
        <div className="mb-6 flex items-center justify-between gap-4 rounded-[2rem] border border-white/70 bg-white/72 px-6 py-5 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">New project</h1>
          <Link
            href="/projects"
            className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300"
          >
            Back
          </Link>
        </div>

        {createdProjectId ? (
          <div className="rounded-[2rem] border border-amber-200 bg-amber-50/90 p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-amber-950">Project created</h2>
            <p className="mt-1 text-sm text-amber-900">
              {inviteError
                ? `Invites weren't sent (${inviteError}). You can send them from Settings.`
                : 'Some invites need attention.'}
            </p>

            {inviteResults && inviteResults.length > 0 ? (
              <div className="mt-4 space-y-2">
                {inviteResults.map((result) => (
                  <div key={result.email} className="rounded-2xl bg-white px-4 py-3 text-sm text-slate-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{result.email}</span>
                      {result.error ? (
                        <span className="text-xs text-rose-600">{result.error}</span>
                      ) : result.alreadyExisted ? (
                        <span className="text-xs text-slate-500">Already has an account</span>
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
                          onClick={() => copyToClipboard(result.actionLink as string, result.email)}
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
                href={`/projects/${encodeURIComponent(createdProjectId)}?tab=settings`}
                className="inline-flex rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
              >
                Go to Settings
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {formError ? (
              <div
                role="alert"
                className="rounded-[2rem] border border-rose-200 bg-rose-50/90 px-5 py-4 text-sm text-rose-700 shadow-sm"
              >
                {formError}
              </div>
            ) : null}

            <div className={CARD}>
              <input
                id="project-name"
                name="project-name"
                aria-label="Project name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Project name"
                className={INPUT}
              />
            </div>

            <div className={CARD}>
              <div className="flex flex-wrap gap-3" role="group" aria-label="Disciplines">
                {[...CONSULTANT_TYPES, ...customTypes].map((type) => {
                  const isSelected = selectedTypes.includes(type)
                  const isFixed = type === OWN_DISCIPLINE

                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleConsultantType(type)}
                      aria-pressed={isSelected}
                      disabled={isFixed}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                        isSelected ? getConsultantTheme(type).selectedChip : IDLE_CHIP
                      } ${isFixed ? 'cursor-default' : ''}`}
                    >
                      {type}
                    </button>
                  )
                })}
                {!otherOpen ? (
                  <button
                    type="button"
                    onClick={() => setOtherOpen(true)}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition ${IDLE_CHIP}`}
                  >
                    Other…
                  </button>
                ) : null}
              </div>

              {otherOpen ? (
                <div className="mt-4">
                  <div className="flex gap-2">
                    <input
                      id="other-discipline"
                      aria-label="Discipline name"
                      value={otherName}
                      maxLength={MAX_DISCIPLINE_LENGTH}
                      autoFocus
                      onChange={(e) => {
                        setOtherName(e.target.value)
                        setOtherError(null)
                      }}
                      onKeyDown={(e) => {
                        // Enter adds the discipline; it must never submit the project.
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addOtherDiscipline()
                        } else if (e.key === 'Escape') {
                          setOtherOpen(false)
                          setOtherName('')
                          setOtherError(null)
                        }
                      }}
                      aria-invalid={otherError ? true : undefined}
                      placeholder="Discipline name"
                      className={`${INPUT} flex-1`}
                    />
                    <button
                      type="button"
                      onClick={addOtherDiscipline}
                      className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOtherOpen(false)
                        setOtherName('')
                        setOtherError(null)
                      }}
                      className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm font-medium text-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                  {otherError ? (
                    <p role="alert" className="mt-2 text-xs text-red-600">
                      {otherError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="grid gap-5">
              {consultants.map((consultant) => {
                const theme = getConsultantTheme(consultant.type)

                return (
                  <section
                    key={consultant.type}
                    aria-label={consultant.type}
                    className={`rounded-[2rem] border p-5 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl ${theme.card}`}
                  >
                    <h2 className={`mb-4 text-xl font-semibold ${theme.badge}`}>{consultant.type}</h2>

                    <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
                      <input
                        id={`org-name-${consultant.type}`}
                        name={`org-name-${consultant.type}`}
                        aria-label={`${consultant.type} organization`}
                        value={consultant.orgName}
                        onChange={(e) => updateConsultant(consultant.type, 'orgName', e.target.value)}
                        placeholder="Organization"
                        className={INPUT}
                      />

                      <div>
                        <div className="flex gap-2">
                          <input
                            id={`email-input-${consultant.type}`}
                            name={`email-input-${consultant.type}`}
                            aria-label={`${consultant.type} email`}
                            value={consultant.emailInput}
                            onChange={(e) =>
                              setConsultants((prev) =>
                                prev.map((item) =>
                                  item.type === consultant.type
                                    ? { ...item, emailInput: e.target.value, emailError: null }
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
                            className={`${INPUT} flex-1`}
                          />
                          <button
                            type="button"
                            onClick={() => addEmail(consultant.type)}
                            className={`rounded-2xl px-4 py-3 text-sm font-medium ${theme.button}`}
                          >
                            Add
                          </button>
                        </div>
                        {consultant.emailError ? (
                          <p role="alert" className="mt-2 text-xs text-red-600">
                            {consultant.emailError}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {consultant.emails.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
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
                    ) : null}
                  </section>
                )
              })}
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-6 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50"
              >
                {submitting ? 'Creating...' : 'Create project'}
              </button>
            </div>
          </form>
        )}
      </div>

      <Modal
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        size="sm"
        title={`Remove ${confirmRemove ?? ''}?`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmRemove(null)}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirmRemove) removeConsultant(confirmRemove)
                setConfirmRemove(null)
              }}
              className="rounded-xl bg-rose-600 px-5 py-2 text-sm font-medium text-white"
            >
              Remove
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          Are you sure? The organization and emails entered for {confirmRemove} will be cleared.
        </p>
      </Modal>
    </main>
  )
}
