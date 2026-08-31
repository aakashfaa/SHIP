'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { CONSULTANT_TYPES } from '@/lib/mock-projects'
import { createProject, getDefaultConsultantPassword } from '@/lib/store'
import { ConsultantType, ProjectConsultant, SafeUser } from '@/lib/types'

type ConsultantDraft = ProjectConsultant & {
  emailInput: string
}

type CreatedUserSummary = {
  email: string
  password: string
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
  const [user] = useState<SafeUser | null>(() => getCurrentUser())
  const [projectName, setProjectName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createdUsers, setCreatedUsers] = useState<CreatedUserSummary[]>([])
  const [consultants, setConsultants] = useState<ConsultantDraft[]>([
    createConsultantDraft('Architecture', 'FAA', ['admin@gmail.com']),
  ])

  useEffect(() => {
    if (!user) {
      router.replace('/')
      return
    }

    if (user.role !== 'admin') {
      router.replace('/projects')
    }
  }, [user, router])

  const selectedTypes = useMemo(
    () => consultants.map((consultant) => consultant.type),
    [consultants]
  )

  if (!user || user.role !== 'admin') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  function updateConsultant(
    type: ConsultantType,
    field: keyof ConsultantDraft,
    value: string | string[]
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
    if (consultant.emails.includes(email)) return

    updateConsultant(type, 'emails', [...consultant.emails, email])
    updateConsultant(type, 'emailInput', '')
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

  function validateForm() {
    if (!projectName.trim()) {
      alert('Please enter a project name.')
      return false
    }

    for (const consultant of consultants) {
      if (!consultant.orgName.trim()) {
        alert(`Please enter an organization name for ${consultant.type}.`)
        return false
      }

      if (consultant.emails.length === 0) {
        alert(`Please add at least one email for ${consultant.type}.`)
        return false
      }
    }

    return true
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!validateForm()) return

    setSubmitting(true)

    const result = createProject({
      name: projectName,
      consultants: consultants.map((consultant) => ({
        type: consultant.type,
        orgName: consultant.orgName,
        emails: consultant.emails,
      })),
    })

    setCreatedUsers(
      result.newUsers.map((user) => ({
        email: user.email,
        password: getDefaultConsultantPassword(),
      }))
    )

    setSubmitting(false)

    setTimeout(() => {
      router.push(`/projects/${result.project.id}`)
    }, 1400)
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

        {createdUsers.length > 0 ? (
          <div className="mb-6 rounded-[2rem] border border-emerald-200 bg-emerald-50/90 p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-emerald-900">
              Project created
            </h2>
            <p className="mt-1 text-sm text-emerald-800">
              New consultant login accounts were created with default password{' '}
              <span className="font-semibold">{getDefaultConsultantPassword()}</span>.
            </p>

            <div className="mt-4 space-y-2">
              {createdUsers.map((user) => (
                <div
                  key={user.email}
                  className="rounded-2xl bg-white px-4 py-3 text-sm text-emerald-900"
                >
                  {user.email}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-5">
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
                          updateConsultant(
                            consultant.type,
                            'emailInput',
                            e.target.value
                          )
                        }
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
      </div>
    </main>
  )
}
