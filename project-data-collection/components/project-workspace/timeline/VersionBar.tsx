'use client'

import { useState } from 'react'
import type { PlanVersion } from '@/lib/types'
import { nextVersionName } from '@/lib/versions'

/**
 * The Timeline's version picker. Replaced the "Try a what-if" button and the
 * amber "Local copy" bar (migration 0031).
 *
 *   "Now we want to change the 'What If' (try a 'What If' inside our
 *    timeline) to be 'Different Versions.' Each version can have a different
 *    cost model but they will have the same packages and line items so they
 *    can be saved and changed."                                    -- owner
 *
 * Owner's decisions: "All equal, pick on export" -- no version is the main
 * one, so nothing here marks one as special (which version happens to sit in
 * the ordinary tables is an implementation detail; see lib/versions.ts) --
 * and "Whole team": everyone on the project sees every version; admins and
 * editors create, rename, duplicate and delete them, everyone else just
 * switches between them.
 *
 * Every edit on the Timeline and in the Cost model popup goes to the version
 * shown here, so its name is always on screen, next to the controls.
 */

type Mode =
  | { kind: 'idle' }
  | { kind: 'new' | 'duplicate' | 'rename'; draft: string }
  | { kind: 'confirm-delete' }

type Props = {
  versions: PlanVersion[]
  activeKey: string
  /** Admin / editor. Everyone else may only switch. */
  canEdit: boolean
  busy?: boolean
  onSelect: (key: string) => void
  /** A new version copying the one on screen. */
  onCreate: (name: string) => void
  onRename: (name: string) => void
  onDelete: () => void
}

const BUTTON =
  'rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-900 disabled:opacity-50'

export default function VersionBar({
  versions,
  activeKey,
  canEdit,
  busy = false,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const active = versions.find((v) => v.key === activeKey) ?? versions[0] ?? null
  const isLast = versions.length <= 1

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mode.kind !== 'new' && mode.kind !== 'duplicate' && mode.kind !== 'rename') return
    const name = mode.draft.trim()
    if (!name) return
    if (mode.kind === 'rename') onRename(name)
    else onCreate(name)
    setMode({ kind: 'idle' })
  }

  const naming = mode.kind === 'new' || mode.kind === 'duplicate' || mode.kind === 'rename'

  return (
    <div className="space-y-2" data-testid="version-bar">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="timeline-version" className="text-sm font-medium text-slate-700">
          Version
        </label>
        <select
          id="timeline-version"
          value={active?.key ?? ''}
          onChange={(event) => {
            setMode({ kind: 'idle' })
            onSelect(event.target.value)
          }}
          disabled={busy || versions.length === 0}
          className="min-w-[12rem] rounded-[0.95rem] border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        >
          {versions.map((version) => (
            <option key={version.key} value={version.key}>
              {version.name}
            </option>
          ))}
        </select>

        {canEdit && !naming && mode.kind !== 'confirm-delete' ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode({ kind: 'new', draft: nextVersionName(versions) })}
              title={active ? `Starts as a copy of ${active.name}` : undefined}
              className={BUTTON}
            >
              New version
            </button>
            <button
              type="button"
              disabled={busy || !active}
              onClick={() => setMode({ kind: 'rename', draft: active?.name ?? '' })}
              className={BUTTON}
            >
              Rename
            </button>
            <button
              type="button"
              disabled={busy || !active}
              onClick={() => setMode({ kind: 'duplicate', draft: `${active?.name ?? ''} copy` })}
              className={BUTTON}
            >
              Duplicate
            </button>
            <button
              type="button"
              disabled={busy || isLast}
              // A project always has a version; the last one cannot go.
              title={isLast ? 'The only version cannot be deleted' : undefined}
              onClick={() => setMode({ kind: 'confirm-delete' })}
              className="rounded-[0.95rem] border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
            >
              Delete
            </button>
          </>
        ) : null}

        {busy ? (
          <span role="status" className="text-xs text-slate-500">
            Working…
          </span>
        ) : null}
      </div>

      {naming ? (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <label htmlFor="version-name" className="text-xs font-medium text-slate-600">
            {mode.kind === 'rename'
              ? 'New name'
              : `Name (a copy of ${active?.name ?? 'this version'})`}
          </label>
          <input
            id="version-name"
            autoFocus
            maxLength={120}
            value={mode.draft}
            onChange={(event) => setMode({ ...mode, draft: event.target.value })}
            className="w-72 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />
          <button
            type="submit"
            disabled={busy || !mode.draft.trim()}
            className="rounded-[0.95rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-4 py-2 text-sm font-medium text-white shadow transition hover:-translate-y-[1px] disabled:opacity-50"
          >
            {mode.kind === 'rename' ? 'Save name' : 'Create'}
          </button>
          <button
            type="button"
            onClick={() => setMode({ kind: 'idle' })}
            className="px-2 py-2 text-sm font-medium text-slate-500 transition hover:text-slate-800"
          >
            Cancel
          </button>
        </form>
      ) : null}

      {/* Delete is a hard delete with no undo (D-15), so it takes a second,
          inline click that names the version -- never window.confirm. */}
      {mode.kind === 'confirm-delete' && active ? (
        <div
          role="alertdialog"
          aria-label="Confirm delete version"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[1rem] border border-rose-300 bg-rose-50 px-4 py-3"
        >
          <p className="text-sm text-rose-900">
            Delete <span className="font-semibold">&lsquo;{active.name}&rsquo;</span> for the whole
            team? Its schedule and cost model go with it. Can&apos;t be undone.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode({ kind: 'idle' })}
              disabled={busy}
              autoFocus
              className="rounded-[0.9rem] border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={() => {
                setMode({ kind: 'idle' })
                onDelete()
              }}
              disabled={busy}
              className="rounded-[0.9rem] bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-800 disabled:opacity-50"
            >
              Yes, delete this version
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
