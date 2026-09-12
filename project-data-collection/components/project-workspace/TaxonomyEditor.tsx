'use client'

import { useMemo, useState } from 'react'
import {
  addTaxonomyValue,
  reorderTaxonomyValues,
  setTaxonomyValueArchived,
} from '@/lib/store'
import type { ProjectTaxonomyValue, TaxonomyKind } from '@/lib/types'

/**
 * Editor for a project's line-item vocabularies.
 *
 * These four dropdowns used to be `CHECK (col in (...))` constraints in
 * migration 0001, filled with one building's vocabulary — 'ANNEX',
 * 'WEST WING', 'BULFINCH', '5_250th ANNIVERSARY'. That is fine for the firm
 * that commissioned the tool and useless for the next one, whose campus has
 * different wings and whose planning horizon does not include somebody else's
 * anniversary.
 *
 * Migration 0008 moved them to per-project rows. This is the half that makes
 * that worth having: without an editor, the data model is generic and the
 * product still is not, because a new project would be stuck with the
 * defaults and no way to change them. (R9 in the v2 spec.)
 *
 * There is no delete, only archive — see `setTaxonomyValueArchived`.
 */

type Props = {
  projectId: string
  values: ProjectTaxonomyValue[]
  onChanged: () => void
  readOnly?: boolean
}

const KINDS: Array<{
  kind: TaxonomyKind
  label: string
  hint: string
  placeholder: string
}> = [
  {
    kind: 'building_area',
    label: 'Building areas',
    hint: 'Where in the campus or building a line item sits. Wings, annexes, blocks, a site.',
    placeholder: 'e.g. NORTH WING',
  },
  {
    kind: 'building_level',
    label: 'Building levels',
    hint: 'Vertical position. Roof, envelope, floors, basements.',
    placeholder: 'e.g. L6',
  },
  {
    kind: 'category',
    label: 'Categories',
    hint: 'What kind of work it is. Drives nothing computationally — it is how your team sorts the matrix.',
    placeholder: 'e.g. RESILIENCE',
  },
  {
    kind: 'timeline_priority',
    label: 'Timeline priorities',
    hint: 'Urgency bands used when triaging. These are labels, not schedule constraints — the schedule lives on the Timeline.',
    placeholder: 'e.g. 2_MID 5-10 years',
  },
]

function KindSection({
  projectId,
  kind,
  label,
  hint,
  placeholder,
  values,
  onChanged,
  readOnly,
}: {
  projectId: string
  kind: TaxonomyKind
  label: string
  hint: string
  placeholder: string
  values: ProjectTaxonomyValue[]
  onChanged: () => void
  readOnly: boolean
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const rows = useMemo(
    () => values.filter((v) => v.kind === kind).sort((a, b) => a.sortOrder - b.sortOrder),
    [values, kind]
  )
  const active = rows.filter((r) => !r.isArchived)
  const archived = rows.filter((r) => r.isArchived)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  async function handleAdd() {
    const value = draft.trim()
    if (value === '') return

    // Re-adding an archived value restores it rather than erroring on the
    // primary key. That is what someone typing a name they remember expects,
    // and the alternative — "duplicate key" — tells them nothing useful.
    const existing = rows.find((r) => r.value.toLowerCase() === value.toLowerCase())
    if (existing?.isArchived) {
      await run(() => setTaxonomyValueArchived(projectId, kind, existing.value, false))
      setDraft('')
      return
    }
    if (existing) {
      setError(`"${value}" is already in this list.`)
      return
    }

    await run(async () => {
      await addTaxonomyValue(projectId, kind, value)
      setDraft('')
    })
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...active]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]

    void run(() =>
      reorderTaxonomyValues(
        projectId,
        kind,
        // Archived rows keep their positions after the active ones, so
        // restoring one does not shuffle the live list.
        [...next.map((r) => r.value), ...archived.map((r) => r.value)]
      )
    )
  }

  return (
    <div className="rounded-[1.5rem] border border-slate-200 bg-white/90 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">{label}</div>
          <p className="mt-1 max-w-xl text-[12px] leading-snug text-slate-500">{hint}</p>
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600">
          {active.length} in use
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-[1rem] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          {error}
        </div>
      ) : null}

      <ul className="mt-4 space-y-2">
        {active.length === 0 ? (
          <li className="rounded-[1rem] border border-dashed border-slate-200 px-4 py-6 text-center text-[12px] text-slate-400">
            No values yet. Line items will have nothing to choose from for this field.
          </li>
        ) : (
          active.map((row, index) => (
            <li
              key={row.value}
              className="flex items-center gap-2 rounded-[1rem] border border-slate-200 bg-white px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{row.value}</span>

              {readOnly ? null : (
                <>
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={busy || index === 0}
                    aria-label={`Move ${row.value} up`}
                    className="rounded-[0.7rem] border border-slate-200 px-2 py-1 text-xs text-slate-600 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={busy || index === active.length - 1}
                    aria-label={`Move ${row.value} down`}
                    className="rounded-[0.7rem] border border-slate-200 px-2 py-1 text-xs text-slate-600 disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void run(() => setTaxonomyValueArchived(projectId, kind, row.value, true))
                    }
                    disabled={busy}
                    /* "Archive", not "Delete", and the title says why. Someone
                       who expects a delete and gets an archive should be able
                       to find out the reason without reading a migration. */
                    title="Stops offering this value on new line items. Existing line items keep it."
                    className="rounded-[0.7rem] border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 disabled:opacity-40"
                  >
                    Archive
                  </button>
                </>
              )}
            </li>
          ))
        )}
      </ul>

      {readOnly ? null : (
        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleAdd()
              }
            }}
            placeholder={placeholder}
            aria-label={`Add a value to ${label}`}
            className="min-w-0 flex-1 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy || draft.trim() === ''}
            className="rounded-[0.95rem] bg-slate-950 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}

      {archived.length > 0 ? (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-[11px] font-medium text-slate-500 underline underline-offset-2"
          >
            {showArchived ? 'Hide' : 'Show'} {archived.length} archived
          </button>

          {showArchived ? (
            <ul className="mt-2 space-y-2">
              {archived.map((row) => (
                <li
                  key={row.value}
                  className="flex items-center gap-2 rounded-[1rem] border border-dashed border-slate-200 bg-slate-50/60 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-500 line-through">
                    {row.value}
                  </span>
                  {readOnly ? null : (
                    <button
                      type="button"
                      onClick={() =>
                        void run(() =>
                          setTaxonomyValueArchived(projectId, kind, row.value, false)
                        )
                      }
                      disabled={busy}
                      className="rounded-[0.7rem] border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 disabled:opacity-40"
                    >
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default function TaxonomyEditor({
  projectId,
  values,
  onChanged,
  readOnly = false,
}: Props) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-slate-950">
          Line item vocabularies
        </h3>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          The dropdown values offered when someone adds a line item. They are
          per project, so a campus with different wings, a different set of work
          categories, or a different planning horizon is a settings change
          rather than a code change.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {KINDS.map((k) => (
          <KindSection
            key={k.kind}
            projectId={projectId}
            kind={k.kind}
            label={k.label}
            hint={k.hint}
            placeholder={k.placeholder}
            values={values}
            onChanged={onChanged}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  )
}
