'use client'

import { useState } from 'react'
import { ProjectChangedError, getFormFieldsForProject, updateProject } from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import { ConsultantType, FormField, Project, ProjectConsultant } from '@/lib/types'
import FormBuilder from './FormBuilder'
import ConsultantsCard from './settings/ConsultantsCard'
import ConsultantsModal from './settings/ConsultantsModal'
import InviteResults from './settings/InviteResults'
import { InviteResult, summarizeInvites } from './settings/invites'

type Props = {
  project: Project
  onProjectUpdated: (project: Project) => void
}

export default function SettingsTab({ project, onProjectUpdated }: Props) {
  const {
    data: formFields,
    error: formFieldsError,
    reload: reloadFormFields,
  } = useAsyncData<FormField[]>(() => getFormFieldsForProject(project.id), [project.id], [])

  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [inviteResults, setInviteResults] = useState<InviteResult[]>([])
  const [inviteError, setInviteError] = useState('')
  const [invitingEmails, setInvitingEmails] = useState<Set<string>>(new Set())
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null)
  const [staleProject, setStaleProject] = useState(false)

  // Which popup is open. `editType` set = editing that one organization.
  const [consultantsModal, setConsultantsModal] = useState<{ editType: ConsultantType | null } | null>(
    null
  )

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

  /**
   * Saves a whole next roster in one update. Resolves to an error message (for
   * the caller to show where the user is looking), or null on success.
   */
  async function saveRoster(next: ProjectConsultant[]): Promise<string | null> {
    const previousEmails = new Set(
      project.consultants.flatMap((c) => c.emails.map((e) => e.trim().toLowerCase()))
    )
    const cleanedConsultants = next.map((consultant) => ({
      type: consultant.type,
      orgName: consultant.orgName.trim(),
      emails: consultant.emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    }))

    setError('')
    setStaleProject(false)

    try {
      // Pass the version we loaded so a save from a stale draft is refused
      // rather than silently replacing a colleague's roster edit.
      const updated = await updateProject(
        project.id,
        project.name,
        cleanedConsultants,
        project.updatedAt ?? null
      )

      if (!updated) return 'Could not save changes. You may not have access to this project.'

      onProjectUpdated(updated.project)

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
        // every send failed. Details stay in the panel.
        showMessage(
          results.length > 0
            ? `Project updated. ${summarizeInvites(results)}`
            : 'Project updated, but invites were not sent. See below.',
          6000
        )
      }
      return null
    } catch (err) {
      if (err instanceof ProjectChangedError) {
        setStaleProject(true)
        return 'Someone else changed this project. Reload to see their changes, then try again.'
      }
      return err instanceof Error ? err.message : 'Failed to save changes.'
    }
  }

  async function removeEmail(type: ConsultantType, email: string) {
    if (!window.confirm(`Remove ${email} from this project?`)) return
    const failure = await saveRoster(
      project.consultants.map((c) =>
        c.type === type ? { ...c, emails: c.emails.filter((e) => e !== email) } : c
      )
    )
    if (failure) setError(failure)
  }

  async function removeOrg(type: ConsultantType) {
    // Architecture is the project's default discipline and can't be removed.
    if (type === 'Architecture') return
    if (!window.confirm(`Remove the ${type} organization and its people from this project?`)) return
    const failure = await saveRoster(project.consultants.filter((c) => c.type !== type))
    if (failure) setError(failure)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-slate-950">Settings</h2>
      </div>

      {message ? (
        <div className="rounded-2xl bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{message}</div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {staleProject ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <span>Someone else changed this project. Reload to see their changes.</span>
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
        <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {inviteError}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        {/* The questions asked when someone on this project adds a line item.
            Lives here rather than on its own tab because it is configuration a
            project admin sets once and then forgets, which is exactly what
            Settings is for. */}
        <section aria-label="Input form" className="min-w-0">
          {formFieldsError ? (
            <div className="mb-3 rounded-2xl bg-rose-50 px-4 py-2 text-sm text-rose-700">
              {formFieldsError.message}
            </div>
          ) : null}
          <FormBuilder projectId={project.id} fields={formFields} onChanged={reloadFormFields} />
        </section>

        <div className="min-w-0 space-y-4 lg:border-l lg:border-slate-200/70 lg:pl-5">
          <ConsultantsCard
            consultants={project.consultants}
            invitingEmails={invitingEmails}
            onAdd={() => setConsultantsModal({ editType: null })}
            onEditOrg={(editType) => setConsultantsModal({ editType })}
            onRemoveOrg={(type) => void removeOrg(type)}
            onRemoveEmail={(type, email) => void removeEmail(type, email)}
            onResend={(email) => void sendInvites([email])}
          />

          {inviteResults.length > 0 ? (
            <InviteResults
              results={inviteResults}
              invitingEmails={invitingEmails}
              copiedEmail={copiedEmail}
              onClear={() => setInviteResults([])}
              onResend={(email) => void sendInvites([email])}
              onCopyLink={(link, email) => void copyLink(link, email)}
            />
          ) : null}
        </div>
      </div>

      {consultantsModal ? (
        <ConsultantsModal
          consultants={project.consultants}
          editType={consultantsModal.editType}
          onSubmit={saveRoster}
          onClose={() => setConsultantsModal(null)}
        />
      ) : null}
    </div>
  )
}
