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
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 overflow-hidden rounded-[2rem] border border-white/70 bg-white/72 px-6 py-6 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
              New Project
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
              Create Project
            </h1>
            <p className="mt-3 text-base text-slate-600">
              Start with FAA for architecture, then add consultant teams.
            </p>
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

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-[2rem] border border-white/70 bg-white/76 p-6 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
            <label
              htmlFor="project-name"
              className="mb-2 block text-sm font-medium text-gray-700"
            >
              Project Name
            </label>
            <input
              id="project-name"
              name="project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Enter project name"
              className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
            />
          </div>

          <div className="rounded-[2rem] border border-white/70 bg-white/76 p-6 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-slate-950">
                Add Consultant Types
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Click a consultant type to add its section below.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {CONSULTANT_TYPES.map((type) => {
                const isSelected = selectedTypes.includes(type)

                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => !isSelected && addConsultantType(type)}
                    disabled={isSelected}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                      isSelected
                        ? 'bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] text-white'
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
            {consultants.map((consultant) => (
              <div
                key={consultant.type}
                className="rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl"
              >
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <div className="mb-2 inline-flex rounded-full bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-3 py-1 text-xs font-medium text-white">
                      {consultant.type}
                    </div>
                    <h2 className="text-xl font-semibold text-slate-950">
                      {consultant.type} Consultant
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
                    <label
                      htmlFor={`org-name-${consultant.type}`}
                      className="mb-2 block text-sm font-medium text-slate-700"
                    >
                      Organization Name
                    </label>
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
                      placeholder="Enter organization name"
                      className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`email-input-${consultant.type}`}
                      className="mb-2 block text-sm font-medium text-slate-700"
                    >
                      Add Email
                    </label>
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
                        className="rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <p className="mb-2 text-sm font-medium text-slate-700">Emails</p>

                  {consultant.emails.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {consultant.emails.map((email) => (
                        <div
                          key={email}
                          className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2 text-xs text-slate-700"
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
                      No emails added yet.
                    </div>
                  )}
                </div>
              </div>
            ))}
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
