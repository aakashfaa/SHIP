'use client'

import { useState } from 'react'
import Modal from '@/components/ui/Modal'
import { INPUT_CLASS } from './shared'

/**
 * Name a group: used for both "Add group" and "Rename group". Mount with a
 * fresh `key` per opening. `onSubmit` does the work and throws to report a
 * problem (shown verbatim); the popup closes itself only on success.
 */
export default function GroupNameModal({
  open,
  title,
  submitLabel,
  initialName,
  existingNames,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  submitLabel: string
  initialName: string
  /** Other groups' names, compared case-insensitively to refuse a clash. */
  existingNames: string[]
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    const trimmed = name.trim()
    if (trimmed === '') {
      setError('Group name cannot be blank.')
      return
    }
    if (trimmed === initialName.trim()) {
      onClose()
      return
    }
    if (existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      setError(`There is already a group called "${trimmed}".`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissable={!busy}
      size="sm"
      title={title}
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
            onClick={() => void handleSubmit()}
            disabled={busy || name.trim() === ''}
            className="rounded-[0.9rem] bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Saving…' : submitLabel}
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
        <label className="block">
          <span className="text-[11px] font-medium text-slate-500">Group name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSubmit()
              }
            }}
            disabled={busy}
            autoFocus
            placeholder="e.g. Cost and energy"
            className={`mt-1 ${INPUT_CLASS}`}
          />
        </label>
      </div>
    </Modal>
  )
}
