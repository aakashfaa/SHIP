'use client'

import { useMemo, useState } from 'react'
import { CONSULTANT_TYPES } from '@/lib/constants'
import { isPlausibleEmail } from '@/lib/email/links'
import { ProjectChangedError, getFormFieldsForProject, updateProject } from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import { ConsultantType, FormField, Project } from '@/lib/types'
import FormBuilder from './FormBuilder'

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

// One row of /api/admin/invite's response (see that route for the rules).
// `actionLink` is only ever present for a brand-new, never-activated account
// a SHIP invite created -- never for someone who already had an account
// (M-02 / D-7) -- so "Copy set-up link" only appears for those.
type InviteResult = {
  email: string
  status?: 'invited' | 'added' | 'failed'
  invited: boolean
  alreadyExisted: boolean
  emailSent?: boolean
  actionLink: string | null
  error: string | null
}

function describeInvite(result: InviteResult): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (result.status === 'failed' || (!result.status && result.error && !result.invited)) {
    return { text: result.error ?? 'Invite failed', tone: 'bad' }
  }
  if (result.error) return { text: result.error, tone: 'warn' }
  return result.alreadyExisted
    ? { text: 'Already has an account. We emailed them a sign-in link.', tone: 'ok' }
    : { text: 'Invite emailed. They choose a password from the link.', tone: 'ok' }
}

function summarizeInvites(results: InviteResult[]): string {
  const failed = results.filter((r) => describeInvite(r).tone === 'bad').length
  const warned = results.filter((r) => describeInvite(r).tone === 'warn').length
  const ok = results.length - failed - warned
  if (failed === 0 && warned === 0) {
    return ok === 1 ? 'Invite sent.' : `${ok} invites sent.`
  }
  const parts: string[] = []
  if (ok > 0) parts.push(`${ok} sent`)
  if (warned > 0) parts.push(`${warned} need a follow-up`)
  if (failed > 0) parts.push(`${failed} failed`)
  return `Invites: ${parts.join(', ')}. See the details below.`
}

function sanitizeTypeId(type: string) {
  return type.toLowerCase().replace(/\s+/g, '-').replace(/[()]/g, '')
}

export default function SettingsTab({ project, onProjectUpdated }: Props) {
  const [isEditing, setIsEditing] = useState(false)

  const {
    data: formFields,
    error: formFieldsError,
    reload: reloadFormFields,
  } = useAsyncData<FormField[]>(() => getFormFieldsForProject(project.id), [project.id], [])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [emailErrors, setEmailErrors] = useState<Partial<Record<ConsultantType, string>>>({})
  const [inviteResults, setInviteResults] = useState<InviteResult[]>([])
  const [inviteError, setInviteError] = useState('')
  const [invitingEmails, setInvitingEmails] = useState<Set<string>>(new Set())
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null)
  const [staleProject, setStaleProject] = useState(false)

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

  function showMessage(text: string, ms = 2200) {
    setMessage(text)
    window.setTimeout(() => setMessage(''), ms)
  }

  /**
   * Calls the invite route for these emails ON THIS PROJECT (so project
   * admins are authorised, M-15) and merges the per-email results into the
   * panel. Returns the results (empty on a request-level failure, which is
   * shown in `inviteError`).
   */
  async function sendInvites(emails: string[]): Promise<InviteResult[]> {
    if (emails.length === 0) return []
    setInviteError('')
    setInvitingEmails((prev) => new Set([...prev, ...emails]))
    try {
      const res = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails, projectId: project.id }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        results?: InviteResult[]
        error?: string
      }
      if (!res.ok || !payload.results) {
        const reason =
          res.status === 403
            ? "You don't have permission to invite people to this project."
            : payload.error ?? `The invite service answered ${res.status}.`
        setInviteError(`Invites weren't sent. ${reason}`)
        return []
      }
      const fresh = payload.results
      setInviteResults((prev) => [
        ...fresh,
        ...prev.filter((r) => !fresh.some((f) => f.email === r.email)),
      ])
      return fresh
    } catch {
      setInviteError("Invites weren't sent: couldn't reach the server. Use Resend invite to try again.")
      return []
    } finally {
      setInvitingEmails((prev) => {
        const next = new Set(prev)
        emails.forEach((e) => next.delete(e))
        return next
      })
    }
  }

  async function copyLink(link: string, email: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopiedEmail(email)
      window.setTimeout(() => setCopiedEmail((cur) => (cur === email ? null : cur)), 2000)
    } catch {
      window.prompt('Copy this set-up link:', link)
    }
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
    setStaleProject(false)
    resetDraft()
    setIsEditing(true)
  }

  function cancelEditing() {
    resetDraft()
    setIsEditing(false)
  }

  async function saveChanges() {
    // An address typed but not added with "Add" used to be silently dropped
    // on save (M-22). Make the admin decide.
    const pending = draftConsultants.filter((c) => c.emailInput.trim() !== '')
    if (pending.length > 0) {
      setError(
        `You typed an email for ${pending.map((c) => c.type).join(', ')} but didn't add it. ` +
          'Press Add (or Enter), or clear the box, then save.'
      )
      return
    }

    const previousEmails = new Set(
      project.consultants.flatMap((c) => c.emails.map((e) => e.trim().toLowerCase()))
    )
    const cleanedConsultants = draftConsultants.map((consultant) => ({
      type: consultant.type,
      orgName: consultant.orgName.trim(),
      emails: consultant.emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    }))

    setIsSaving(true)
    setError('')

    try {
      // Pass the version we loaded so a save from a stale draft is refused
      // rather than silently replacing a colleague's roster edit.
      const updated = await updateProject(
        project.id,
        draftName.trim(),
        cleanedConsultants,
        project.updatedAt ?? null
      )

      if (!updated) {
        setError('Could not save changes. You may not have access to this project.')
        return
      }

      onProjectUpdated(updated.project)
      setIsEditing(false)

      // Everyone newly on the roster gets an email: brand-new people an
      // invite, people who already have an account (on SHIP or the shared
      // auth pool) an "added to <project>" note + in-app toast (D-7).
      // `invitedEmails` (new allowlist rows) is normally a subset of this;
      // it's kept in the union in case the DB normalised an address.
      const added = Array.from(
        new Set([
          ...cleanedConsultants
            .flatMap((c) => c.emails)
            .filter((email) => !previousEmails.has(email)),
          ...updated.invitedEmails,
        ])
      )

      if (added.length === 0) {
        showMessage('Project updated')
      } else {
        const results = await sendInvites(added)
        // The toast says what actually happened (M-29), not "invited" when
        // every send failed. Details stay in the panel above.
        showMessage(
          results.length > 0
            ? `Project updated. ${summarizeInvites(results)}`
            : 'Project updated, but invites were not sent. See below.',
          6000
        )
      }
    } catch (err) {
      if (err instanceof ProjectChangedError) {
        setStaleProject(true)
        setError('')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save changes.')
      }
    } finally {
      setIsSaving(false)
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
    if (!email) return
    // Validate on add (M-22): "not-an-email" used to be saved to the roster,
    // stored in the allowlist and sent to the mailer.
    if (!isPlausibleEmail(email)) {
      setEmailErrors((prev) => ({ ...prev, [type]: `"${email}" doesn't look like an email address.` }))
      return
    }
    setEmailErrors((prev) => ({ ...prev, [type]: undefined }))
    if (consultant.emails.includes(email)) {
      updateConsultantField(type, 'emailInput', '')
      return
    }

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
      <div className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-950">
              Project Configuration
            </h2>
            <p className="mt-1 text-sm text-slate-500">
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
                disabled={isSaving}
                className="rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveChanges}
                disabled={isSaving}
                className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}
        </div>

        {message ? (
          <div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {message}
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}

        {staleProject ? (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <span>
              Someone else changed this project while you were editing. Reload to see their
              changes, then make yours again.
            </span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl bg-amber-900 px-3 py-1.5 text-xs font-medium text-white"
            >
              Reload
            </button>
          </div>
        ) : null}

        {inviteError ? (
          <div role="alert" className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {inviteError}
          </div>
        ) : null}

        {inviteResults.length > 0 ? (
          <div
            className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3"
            data-testid="invite-results"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-800">Invites</p>
              <button
                type="button"
                onClick={() => setInviteResults([])}
                className="text-xs font-medium text-slate-500 hover:text-slate-800"
              >
                Clear
              </button>
            </div>
            <ul className="mt-2 divide-y divide-slate-100">
              {inviteResults.map((result) => {
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
                            onClick={() => void copyLink(result.actionLink as string, result.email)}
                            className="rounded-xl bg-black px-3 py-1.5 text-xs font-medium text-white"
                          >
                            {copiedEmail === result.email ? 'Copied' : 'Copy set-up link'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void sendInvites([result.email])}
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
            {inviteResults.some((r) => r.actionLink) ? (
              <p className="mt-2 text-xs text-slate-500">
                A set-up link signs that person in once, so only send it to them directly.
              </p>
            ) : null}
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
                    <div className="rounded-2xl bg-white px-4 py-3 text-sm text-gray-900">
                      {consultant.emails.length > 0 ? (
                        <ul className="space-y-1">
                          {consultant.emails.map((email) => (
                            <li key={email} className="flex items-center justify-between gap-2">
                              <span className="truncate">{email}</span>
                              <button
                                type="button"
                                disabled={invitingEmails.has(email)}
                                onClick={() => void sendInvites([email])}
                                aria-label={`Resend invite to ${email}`}
                                className="flex-none rounded-lg px-2 py-1 text-xs font-medium text-teal-700 hover:bg-teal-50 disabled:opacity-50"
                              >
                                {invitingEmails.has(email) ? 'Sending...' : 'Resend invite'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        '—'
                      )}
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
                            onKeyDown={(e) => {
                              // Enter adds the address (M-22).
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                addEmail(consultant.type)
                              }
                            }}
                            aria-invalid={Boolean(emailErrors[consultant.type])}
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

                      {emailErrors[consultant.type] ? (
                        <p role="alert" className="text-xs text-rose-600">
                          {emailErrors[consultant.type]}
                        </p>
                      ) : null}

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

      {/* The questions asked when someone on this project adds a line item.
          Lives here rather than on its own tab because it is configuration a
          project admin sets once and then forgets, which is exactly what
          Settings is for. */}
      <div className="rounded-[2rem] bg-gray-50 p-6">
        {formFieldsError ? (
          <div className="mb-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {formFieldsError.message}
          </div>
        ) : null}
        <FormBuilder projectId={project.id} fields={formFields} onChanged={reloadFormFields} />
      </div>
    </div>
  )
}
