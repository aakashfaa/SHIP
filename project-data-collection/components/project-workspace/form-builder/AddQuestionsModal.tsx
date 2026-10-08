'use client'

import { useId, useState } from 'react'
import Modal from '@/components/ui/Modal'
import { addFieldOption, createFormField } from '@/lib/store'
import type { FormFieldInputType } from '@/lib/types'
import { CloseIcon, INPUT_CLASS, INPUT_TYPES, INPUT_TYPE_LABELS, PlusIcon, hasOptions } from './shared'

type Draft = {
  uid: number
  label: string
  inputType: FormFieldInputType
  groupLabel: string
  options: string[]
}

let nextUid = 1
function blankDraft(groupLabel = ''): Draft {
  return { uid: nextUid++, label: '', inputType: 'text', groupLabel, options: [] }
}

/** Options for a question that doesn't exist yet: kept in memory, written
 *  after the field is created. */
function DraftOptions({
  label,
  options,
  disabled,
  onChange,
}: {
  label: string
  options: string[]
  disabled: boolean
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  function add() {
    const value = draft.trim()
    if (value === '') return
    if (options.some((o) => o.toLowerCase() === value.toLowerCase())) {
      setError(`"${value}" is already an option.`)
      return
    }
    setError(null)
    onChange([...options, value])
    setDraft('')
  }

  return (
    <div className="mt-2 rounded-[0.9rem] border border-dashed border-slate-200 bg-slate-50/60 p-2.5">
      {options.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <span
              key={option}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white py-0.5 pl-2.5 pr-1 text-[12px] text-slate-700"
            >
              {option}
              <button
                type="button"
                onClick={() => onChange(options.filter((o) => o !== option))}
                disabled={disabled}
                aria-label={`Remove option ${option}`}
                className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          disabled={disabled}
          placeholder="Add an option, press Enter"
          aria-label={`Add an option to ${label || 'new question'}`}
          className="min-w-0 flex-1 rounded-[0.7rem] border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || draft.trim() === ''}
          className="rounded-[0.7rem] border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 disabled:opacity-40"
        >
          Add
        </button>
      </div>
      {error ? <div className="mt-1.5 text-[11px] text-rose-600">{error}</div> : null}
    </div>
  )
}

/**
 * Add one or several CUSTOM questions in one go. Mount with a fresh `key`
 * per opening so the drafts start empty.
 *
 * Saved one at a time, in order: `createFormField` derives each new key from
 * the project's existing keys, so two creates in flight at once could derive
 * the same one. If a save fails part-way, the questions already created are
 * dropped from the list (they exist now) and the rest stay for a retry.
 */
export default function AddQuestionsModal({
  open,
  projectId,
  groupSuggestions,
  initialGroup = '',
  onClose,
  onChanged,
}: {
  open: boolean
  projectId: string
  groupSuggestions: string[]
  /** Pre-fills the first question's group (the "Add question" link inside a
   *  group, notably a brand-new empty one). */
  initialGroup?: string
  onClose: () => void
  onChanged: () => void
}) {
  const listId = useId()
  const [drafts, setDrafts] = useState<Draft[]>(() => [blankDraft(initialGroup)])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = drafts.filter((d) => d.label.trim() !== '')

  function patch(uid: number, changes: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.uid === uid ? { ...d, ...changes } : d)))
  }

  async function handleAddAll() {
    if (ready.length === 0) return
    setBusy(true)
    setError(null)

    const done = new Set<number>()
    try {
      for (const draft of ready) {
        const label = draft.label.trim()
        const field = await createFormField(projectId, {
          label,
          inputType: draft.inputType,
          groupLabel: draft.groupLabel.trim(),
        })
        // The field exists from here on, whatever happens to its options.
        done.add(draft.uid)
        if (hasOptions(draft.inputType)) {
          for (const option of draft.options) {
            try {
              await addFieldOption(field.id, option)
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Something went wrong.'
              throw new Error(
                `"${label}" was added, but its option "${option}" was not: ${message} Finish its options from the question's edit button.`
              )
            }
          }
        }
      }
      onChanged()
      onClose()
    } catch (err) {
      // Verbatim -- the store's errors name the field and the reason.
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setDrafts((prev) => {
        const left = prev.filter((d) => !done.has(d.uid))
        return left.length > 0 ? left : [blankDraft()]
      })
      if (done.size > 0) onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissable={!busy}
      size="lg"
      title="Add questions"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[0.9rem] border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleAddAll()}
            disabled={busy || ready.length === 0}
            className="rounded-[0.9rem] bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Adding…' : ready.length > 1 ? `Add ${ready.length} questions` : 'Add'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? (
          <div
            role="alert"
            className="rounded-[0.9rem] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700"
          >
            {error}
          </div>
        ) : null}

        {drafts.map((draft, index) => (
          <div key={draft.uid} className="rounded-[1.1rem] border border-slate-200 bg-white p-3">
            <div className="grid gap-2 sm:grid-cols-[1.6fr_1fr_1fr_auto] sm:items-center">
              <input
                value={draft.label}
                onChange={(e) => patch(draft.uid, { label: e.target.value })}
                disabled={busy}
                autoFocus={index === drafts.length - 1}
                placeholder="Question, e.g. Roof warranty expiry"
                aria-label={`Question ${index + 1} label`}
                className={INPUT_CLASS}
              />
              <select
                value={draft.inputType}
                onChange={(e) =>
                  patch(draft.uid, { inputType: e.target.value as FormFieldInputType })
                }
                disabled={busy}
                aria-label={`Question ${index + 1} input type`}
                className={INPUT_CLASS}
              >
                {INPUT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {INPUT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <input
                value={draft.groupLabel}
                onChange={(e) => patch(draft.uid, { groupLabel: e.target.value })}
                list={listId}
                disabled={busy}
                placeholder="Group"
                aria-label={`Question ${index + 1} group`}
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={() => setDrafts((prev) => prev.filter((d) => d.uid !== draft.uid))}
                disabled={busy || drafts.length === 1}
                aria-label={`Remove question ${index + 1}`}
                className="flex h-8 w-8 items-center justify-center justify-self-end rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:invisible"
              >
                <CloseIcon />
              </button>
            </div>
            {hasOptions(draft.inputType) ? (
              <DraftOptions
                label={draft.label}
                options={draft.options}
                disabled={busy}
                onChange={(options) => patch(draft.uid, { options })}
              />
            ) : null}
          </div>
        ))}

        <button
          type="button"
          onClick={() =>
            setDrafts((prev) => [...prev, blankDraft(prev[prev.length - 1]?.groupLabel ?? '')])
          }
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-[12px] font-medium text-slate-600 transition hover:border-slate-400 hover:text-slate-900 disabled:opacity-40"
        >
          <PlusIcon /> Add another question
        </button>

        <datalist id={listId}>
          {groupSuggestions.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </div>
    </Modal>
  )
}
