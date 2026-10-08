'use client'

import { useMemo, useState } from 'react'
import { addFieldOption, reorderFieldOptions, setFieldOptionArchived } from '@/lib/store'
import type { FormField } from '@/lib/types'
import { FIXED_OPTION_SET_KEYS } from './shared'

/**
 * One SAVED field's option list: add, archive, restore, reorder. Lives in the
 * edit popup; every action writes straight away (options are their own rows,
 * so there is nothing to batch behind the popup's Save button).
 *
 * No delete, only archive -- see FormFieldOption.isArchived: a value already
 * written onto a line item can't be withdrawn without that item failing
 * validation on its next edit. Archiving stops it being OFFERED instead.
 */
export default function OptionsEditor({
  field,
  onChanged,
}: {
  field: FormField
  onChanged: () => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const active = useMemo(
    () => field.options.filter((o) => !o.isArchived).sort((a, b) => a.sortOrder - b.sortOrder),
    [field.options]
  )
  const archived = useMemo(
    () => field.options.filter((o) => o.isArchived).sort((a, b) => a.sortOrder - b.sortOrder),
    [field.options]
  )
  const fixedSet = FIXED_OPTION_SET_KEYS.has(field.key)

  async function run(action: () => Promise<unknown>, refetchOnError = false) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      // A failed reorder leaves the list on screen out of step with the
      // database (or with whoever else is editing), so reorders re-fetch.
      if (refetchOnError) onChanged()
      // Verbatim: `ship.form_field_options` errors and the client-side
      // blank check below are both meant to be read, not paraphrased.
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  async function handleAdd() {
    const value = draft.trim()
    if (value === '') return

    if (active.some((o) => o.value.toLowerCase() === value.toLowerCase())) {
      setError(`"${value}" is already an option on this field.`)
      return
    }
    // Re-adding an archived value restores it rather than creating a twin.
    const archivedMatch = archived.find((o) => o.value.toLowerCase() === value.toLowerCase())
    if (archivedMatch) {
      await run(() => setFieldOptionArchived(archivedMatch.id, false))
      setDraft('')
      return
    }
    await run(async () => {
      await addFieldOption(field.id, value)
      setDraft('')
    })
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...active]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]

    // The full ordered id list (active in their new order, then archived),
    // which the reorder RPC renumbers 0..n-1 in one statement.
    void run(
      () =>
        reorderFieldOptions(field.id, [...next.map((o) => o.id), ...archived.map((o) => o.id)]),
      true
    )
  }

  return (
    <div className="rounded-[1rem] border border-slate-200 bg-slate-50/60 p-3">
      <div className="text-[11px] font-medium text-slate-500">
        Options ({active.length}) · saved as you go
      </div>

      {error ? (
        <div className="mt-2 rounded-[0.85rem] border border-rose-200 bg-rose-50 px-3 py-1.5 text-[11px] text-rose-700">
          {error}
        </div>
      ) : null}

      <ul className="mt-2 space-y-1">
        {active.length === 0 ? (
          <li className="rounded-[0.85rem] border border-dashed border-slate-200 px-3 py-2 text-center text-[11px] text-slate-400">
            No options yet.
          </li>
        ) : (
          active.map((option, index) => (
            <li
              key={option.id}
              className="flex items-center gap-1.5 rounded-[0.85rem] border border-slate-200 bg-white px-2.5 py-1"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-slate-800">
                {option.label}
              </span>
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={busy || index === 0}
                aria-label={`Move option ${option.label} up`}
                className="rounded-[0.6rem] px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={busy || index === active.length - 1}
                aria-label={`Move option ${option.label} down`}
                className="rounded-[0.6rem] px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => void run(() => setFieldOptionArchived(option.id, true))}
                disabled={busy}
                title="Stops offering this value on new line items. Existing line items keep it."
                className="rounded-[0.6rem] border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-slate-300 disabled:opacity-40"
              >
                Archive
              </button>
            </li>
          ))
        )}
      </ul>

      {fixedSet ? (
        <p className="mt-2 text-[11px] leading-snug text-slate-400">
          Fixed list — reorder or archive only.
        </p>
      ) : (
        <div className="mt-2 flex gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleAdd()
              }
            }}
            placeholder="Add an option"
            aria-label={`Add an option to ${field.label}`}
            className="min-w-0 flex-1 rounded-[0.7rem] border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy || draft.trim() === ''}
            className="rounded-[0.7rem] bg-slate-950 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}

      {archived.length > 0 ? (
        <div className="mt-2 border-t border-slate-200 pt-2">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-[11px] font-medium text-slate-500 underline underline-offset-2"
          >
            {showArchived ? 'Hide' : 'Show'} {archived.length} archived
          </button>

          {showArchived ? (
            <ul className="mt-1.5 space-y-1">
              {archived.map((option) => (
                <li
                  key={option.id}
                  className="flex items-center gap-2 rounded-[0.85rem] border border-dashed border-slate-200 bg-white px-2.5 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-slate-500 line-through">
                    {option.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => void run(() => setFieldOptionArchived(option.id, false))}
                    disabled={busy}
                    className="rounded-[0.6rem] border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 disabled:opacity-40"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
