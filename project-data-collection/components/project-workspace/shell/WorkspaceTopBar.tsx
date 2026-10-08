'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { updateProject, ProjectChangedError } from '@/lib/store'
import { ProjectPermissions } from '@/lib/project-role'
import { Project, SafeUser } from '@/lib/types'

type WorkspaceTopBarProps = {
  project: Project
  user: SafeUser
  permissions: ProjectPermissions
  viewLabel: string | undefined
  onProjectUpdated: (project: Project) => void
  onLogout: () => void
}

/**
 * Who the caller is on this project, in a few words.
 *
 * Naming the role is not decoration — a consultant who cannot work out why
 * the timeline will not drag needs to be able to see, without asking anyone,
 * that they are a consultant on this project rather than an editor. A
 * platform admin resolves to 'admin' in `ship.project_role()`, so they read
 * as Admin here too, which is what they can actually do.
 *
 * Null while the role is loading (or for a non-member): saying nothing beats
 * claiming "Client" at a moment when the answer is actually "Admin".
 */
function roleLabel(permissions: ProjectPermissions, project: Project, email: string) {
  switch (permissions.role) {
    case 'admin':
      return 'Admin'
    case 'editor':
      return 'Editor'
    case 'consultant': {
      const needle = email.trim().toLowerCase()
      const org = project.consultants.find((consultant) =>
        consultant.emails.some((entry) => entry.trim().toLowerCase() === needle)
      )?.orgName
      return org ? `Consultant · ${org}` : 'Consultant'
    }
    case 'viewer':
      return 'Client'
    default:
      return null
  }
}

export default function WorkspaceTopBar({
  project,
  user,
  permissions,
  viewLabel,
  onProjectUpdated,
  onLogout,
}: WorkspaceTopBarProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Refs, not state: Enter commits and then the input blurs (or unmounts)
  // and commits again inside the same tick, before a `saving` state update
  // would be visible to the second call. Escape likewise must stop the blur
  // that follows it from saving the draft it was meant to throw away.
  const busyRef = useRef(false)

  const role = roleLabel(permissions, project, user.email)
  const subtitle = [viewLabel, role].filter(Boolean).join(' · ')

  function startEditing() {
    busyRef.current = false
    setDraft(project.name)
    setError(null)
    setEditing(true)
  }

  function flashError(message: string) {
    setError(message)
    window.setTimeout(() => setError(null), 4000)
  }

  async function commit() {
    if (busyRef.current) return
    busyRef.current = true
    const name = draft.trim()
    if (!name || name === project.name) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      // `updatedAt` makes a rename from a stale page refuse rather than
      // silently overwrite a colleague's roster edit made since (DATA-19).
      const result = await updateProject(project.id, { name }, project.updatedAt)
      if (!result) {
        flashError("Couldn't rename the project.")
      } else {
        onProjectUpdated(result.project)
      }
    } catch (err) {
      flashError(
        err instanceof ProjectChangedError
          ? 'Someone else changed this project. Reload and try again.'
          : "Couldn't rename the project."
      )
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  return (
    <header data-workspace-topbar className="flex shrink-0 items-center justify-between gap-4 border-b border-white/70 bg-white/55 px-4 py-3 backdrop-blur-xl md:px-6">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {editing ? (
            <input
              autoFocus
              aria-label="Project name"
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.target.select()}
              onBlur={() => void commit()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commit()
                if (event.key === 'Escape') {
                  busyRef.current = true
                  setEditing(false)
                }
              }}
              className="min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-2xl font-semibold tracking-tight text-slate-950 outline-none focus:border-slate-500 md:text-3xl"
            />
          ) : (
            <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-950 md:text-3xl">
              {project.name}
            </h1>
          )}
          {permissions.isAdmin && !editing ? (
            <button
              type="button"
              onClick={startEditing}
              aria-label="Rename project"
              title="Rename project"
              className="no-print shrink-0 rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" />
              </svg>
            </button>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-sm text-slate-500">
          {subtitle}
          {error ? <span className="ml-2 font-medium text-rose-600">{error}</span> : null}
        </p>
      </div>

      <div className="no-print flex shrink-0 items-center gap-2">
        <Link
          href="/projects"
          className="rounded-xl border border-slate-200 bg-white/90 px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300"
        >
          Back
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className="rounded-xl bg-slate-950 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Logout
        </button>
      </div>
    </header>
  )
}
