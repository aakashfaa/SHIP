'use client'

import { useMemo, useState } from 'react'
import { CONSULTANT_TYPES } from '@/lib/mock-projects'
import { updateProject } from '@/lib/store'
import { ConsultantType, Project } from '@/lib/types'

type Props = {
  project: Project
  onProjectUpdated: (project: Project) => void
}

type DraftConsultant = {
  type: ConsultantType
  orgName: string
  emails: string[]
  emailInput: string
}

function sanitizeTypeId(type: string) {
  return type.toLowerCase().replace(/\s+/g, '-').replace(/[()]/g, '')
}

export default function SettingsTab({ project, onProjectUpdated }: Props) {
  const [isEditing, setIsEditing] = useState(false)
  const [message, setMessage] = useState('')

  const [draftName, setDraftName] = useState(project.name)
  const [draftConsultants, setDraftConsultants] = useState<DraftConsultant[]>(
    project.consultants.map((consultant) => ({
      ...consultant,
      emailInput: '',
    }))
  )

  const existingTypes = useMemo(
    () => new Set(draftConsultants.map((c) => c.type)),
    [draftConsultants]
  )

  const availableTypes = CONSULTANT_TYPES.filter((type) => !existingTypes.has(type))

  function showMessage(text: string) {
    setMessage(text)
    window.setTimeout(() => setMessage(''), 2200)
  }

  function resetDraft() {
    setDraftName(project.name)
    setDraftConsultants(
      project.consultants.map((consultant) => ({
        ...consultant,
        emailInput: '',
      }))
    )
  }

  function startEditing() {
    resetDraft()
    setIsEditing(true)
  }

  function cancelEditing() {
    resetDraft()
    setIsEditing(false)
  }

  function saveChanges() {
    const cleanedConsultants = draftConsultants.map((consultant) => ({
      type: consultant.type,
      orgName: consultant.orgName.trim(),
      emails: consultant.emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    }))

    const updated = updateProject(project.id, {
      name: draftName.trim(),
      consultants: cleanedConsultants,
    })

    if (updated?.project) {
      onProjectUpdated(updated.project)
      setIsEditing(false)
      showMessage('Project updated')
    }
  }

  function updateConsultantField(
    type: ConsultantType,
    field: keyof DraftConsultant,
    value: string | string[]
  ) {
    setDraftConsultants((prev) =>
      prev.map((consultant) =>
        consultant.type === type ? { ...consultant, [field]: value } : consultant
      )
    )
  }

  function addEmail(type: ConsultantType) {
    const consultant = draftConsultants.find((c) => c.type === type)
    if (!consultant) return

    const email = consultant.emailInput.trim().toLowerCase()
    if (!email || consultant.emails.includes(email)) return

    updateConsultantField(type, 'emails', [...consultant.emails, email])
    updateConsultantField(type, 'emailInput', '')
  }

  function removeEmail(type: ConsultantType, email: string) {
    const consultant = draftConsultants.find((c) => c.type === type)
    if (!consultant) return

    updateConsultantField(
      type,
      'emails',
      consultant.emails.filter((item) => item !== email)
    )
  }

  function addConsultantType(type: ConsultantType) {
    setDraftConsultants((prev) => [
      ...prev,
      {
        type,
        orgName: '',
        emails: [],
        emailInput: '',
      },
    ])
  }

  function removeConsultantType(type: ConsultantType) {
    if (type === 'Architecture') return
    setDraftConsultants((prev) => prev.filter((consultant) => consultant.type !== type))
  }

  const sourceConsultants: DraftConsultant[] = isEditing
  ? draftConsultants
  : project.consultants.map((consultant) => ({
      ...consultant,
      emailInput: '',
    }))

  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] bg-gray-50 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500">Admin Settings</p>
            <h3 className="mt-1 text-2xl font-semibold text-gray-900">
              Project Configuration
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              Review project info and consultant teams. Switch to edit mode to make changes.
            </p>
          </div>

          {!isEditing ? (
            <button
              type="button"
              onClick={startEditing}
              className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white"
            >
              Edit
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cancelEditing}
                className="rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveChanges}
                className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white"
              >
                Save Changes
              </button>
            </div>
          )}
        </div>

        {message ? (
          <div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {message}
          </div>
        ) : null}
      </div>

      <div className="rounded-[2rem] bg-gray-50 p-6">
        <p className="mb-2 text-sm font-medium text-gray-700">Project Name</p>

        {!isEditing ? (
          <div className="rounded-2xl bg-white px-4 py-4 text-base font-medium text-gray-900">
            {project.name}
          </div>
        ) : (
          <input
            id="settings-project-name"
            name="settings-project-name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Enter project name"
            className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-4 text-base outline-none focus:border-black"
          />
        )}
      </div>

      {isEditing && availableTypes.length > 0 ? (
        <div className="rounded-[2rem] bg-gray-50 p-6">
          <p className="text-sm font-medium text-gray-700">Add Consultant Team</p>
          <p className="mt-1 text-sm text-gray-500">
            Tap a discipline to add it to this project.
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            {availableTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => addConsultantType(type)}
                className="rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:border-black hover:text-black"
              >
                {type}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {sourceConsultants.map((consultant) => {
          const isDraftConsultant = 'emailInput' in consultant

          return (
            <div key={consultant.type} className="rounded-[2rem] bg-gray-50 p-6">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <div className="inline-flex rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                    {consultant.type}
                  </div>
                  <h4 className="mt-3 text-lg font-semibold text-gray-900">
                    {consultant.type} Consultant
                  </h4>
                </div>

                {isEditing && consultant.type !== 'Architecture' ? (
                  <button
                    type="button"
                    onClick={() => removeConsultantType(consultant.type)}
                    className="rounded-full border border-red-200 bg-white px-3 py-1 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    Remove
                  </button>
                ) : consultant.type === 'Architecture' ? (
                  <div className="rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-500">
                    Default
                  </div>
                ) : null}
              </div>

              <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
                <div>
                  <label
                    htmlFor={`org-name-${sanitizeTypeId(consultant.type)}`}
                    className="mb-2 block text-sm font-medium text-gray-700"
                  >
                    Organization Name
                  </label>

                  {!isEditing ? (
                    <div className="rounded-2xl bg-white px-4 py-4 text-sm text-gray-900">
                      {consultant.orgName || '—'}
                    </div>
                  ) : (
                    <input
                      id={`org-name-${sanitizeTypeId(consultant.type)}`}
                      name={`org-name-${sanitizeTypeId(consultant.type)}`}
                      value={consultant.orgName}
                      onChange={(e) =>
                        updateConsultantField(consultant.type, 'orgName', e.target.value)
                      }
                      placeholder="Enter organization name"
                      className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-4 text-sm outline-none focus:border-black"
                    />
                  )}
                </div>

                <div>
                  <p className="mb-2 block text-sm font-medium text-gray-700">Emails</p>

                  {!isEditing ? (
                    <div className="rounded-2xl bg-white px-4 py-4 text-sm text-gray-900">
                      {consultant.emails.length > 0 ? consultant.emails.join(', ') : '—'}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label
                            htmlFor={`add-email-${sanitizeTypeId(consultant.type)}`}
                            className="sr-only"
                          >
                            Add email for {consultant.type}
                          </label>
                          <input
                            id={`add-email-${sanitizeTypeId(consultant.type)}`}
                            name={`add-email-${sanitizeTypeId(consultant.type)}`}
                            type="email"
                            value={isDraftConsultant ? consultant.emailInput : ''}
                            onChange={(e) =>
                              updateConsultantField(
                                consultant.type,
                                'emailInput',
                                e.target.value
                              )
                            }
                            placeholder="name@company.com"
                            className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-4 text-sm outline-none focus:border-black"
                          />
                        </div>

                        <button
                          type="button"
                          onClick={() => addEmail(consultant.type)}
                          className="rounded-2xl bg-black px-4 py-4 text-sm font-medium text-white"
                        >
                          Add
                        </button>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {consultant.emails.length > 0 ? (
                          consultant.emails.map((email) => (
                            <div
                              key={email}
                              className="flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs text-gray-700"
                            >
                              <span>{email}</span>
                              <button
                                type="button"
                                onClick={() => removeEmail(consultant.type, email)}
                                aria-label={`Remove ${email}`}
                                className="text-gray-500"
                              >
                                ×
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-400">
                            No emails added yet.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}