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
      consultants: consultants.map(({ emailInput, ...rest }) => rest),
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
    <main className="min-h-screen bg-gradient-to-b from-zinc-100 via-white to-zinc-50 px-4 py-6 md:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-gray-400">
              New Project
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-gray-900">
              Create Project
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              Start with FAA for architecture, then add consultant teams.
            </p>
          </div>

          <Link
            href="/projects"
            className="rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-sm"
          >
            Back
          </Link>
        </div>

        {createdUsers.length > 0 ? (
          <div className="mb-6 rounded-[2rem] border border-emerald-200 bg-emerald-50 p-5">
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
          <div className="rounded-[2rem] border border-white/60 bg-white/85 p-6 shadow-2xl backdrop-blur-xl">
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
              className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
            />
          </div>

          <div className="rounded-[2rem] border border-white/60 bg-white/85 p-6 shadow-2xl backdrop-blur-xl">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-900">
                Add Consultant Types
              </h2>
              <p className="mt-1 text-sm text-gray-500">
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
                        ? 'bg-black text-white'
                        : 'border border-gray-300 bg-white text-gray-700 hover:-translate-y-[1px] hover:border-black'
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
                className="rounded-[2rem] border border-white/60 bg-white/90 p-6 shadow-2xl backdrop-blur-xl"
              >
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <div className="mb-2 inline-flex rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                      {consultant.type}
                    </div>
                    <h2 className="text-xl font-semibold text-gray-900">
                      {consultant.type} Consultant
                    </h2>
                  </div>

                  {consultant.type !== 'Architecture' ? (
                    <button
                      type="button"
                      onClick={() => removeConsultant(consultant.type)}
                      className="rounded-full border border-red-200 px-3 py-1 text-sm font-medium text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  ) : (
                    <div className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
                      Default
                    </div>
                  )}
                </div>

                <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
                  <div>
                    <label
                      htmlFor={`org-name-${consultant.type}`}
                      className="mb-2 block text-sm font-medium text-gray-700"
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
                      className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`email-input-${consultant.type}`}
                      className="mb-2 block text-sm font-medium text-gray-700"
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
                        className="flex-1 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
                      />
                      <button
                        type="button"
                        onClick={() => addEmail(consultant.type)}
                        className="rounded-2xl bg-black px-4 py-3 text-sm font-medium text-white"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <p className="mb-2 text-sm font-medium text-gray-700">Emails</p>

                  {consultant.emails.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {consultant.emails.map((email) => (
                        <div
                          key={email}
                          className="flex items-center gap-2 rounded-full bg-gray-100 px-3 py-2 text-xs text-gray-700"
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
                    <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-4 text-sm text-gray-400">
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
              className="rounded-2xl bg-black px-6 py-3 text-sm font-medium text-white shadow-lg disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}