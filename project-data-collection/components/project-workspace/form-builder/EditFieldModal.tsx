'use client'

import { useId, useState } from 'react'
import Modal from '@/components/ui/Modal'
import { isDefaultField } from '@/lib/form-defaults'
import { updateFormField } from '@/lib/store'
import type { FormField, FormFieldInputType } from '@/lib/types'
import OptionsEditor from './OptionsEditor'
import { INPUT_CLASS, INPUT_TYPES, INPUT_TYPE_LABELS, groupKeyOf, hasOptions } from './shared'

/**
 * Edit one question: label, help text, group, input type (custom fields
 * only -- `ship.guard_form_field` refuses a retype of a column-backed one)
 * and, for dropdowns, its options.
 *
 * Mount with a fresh `key` per opening so the drafts start from the field as
 * it is now. On Save only the inputs the admin actually changed are sent, so
 * a concurrent edit to some other property of the same field (a teammate
 * flipping Required, say) is not clobbered by a stale copy held here.
 */
export default function EditFieldModal({
  open,
  field,
  groupSuggestions,
  onClose,
  onChanged,
}: {
  open: boolean
  field: FormField
  groupSuggestions: string[]
  onClose: () => void
  onChanged: () => void
}) {
  const listId = useId()
  // The baseline is captured once, at mount, so "changed" means "changed by
  // the admin in this popup" even after a refetch updates `field`.
  const [baseline] = useState(() => ({
    label: field.label,
    helpText: field.helpText,
    groupLabel: groupKeyOf(field),
    inputType: field.inputType,
  }))
  const [label, setLabel] = useState(baseline.label)
  const [helpText, setHelpText] = useState(baseline.helpText)
  const [groupLabel, setGroupLabel] = useState(baseline.groupLabel)
  const [inputType, setInputType] = useState<FormFieldInputType>(baseline.inputType)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const locked = field.isBuiltin
  const isDefault = isDefaultField(field)

  async function handleSave() {
    const trimmedLabel = label.trim()
    if (trimmedLabel === '') {
      setError('Label cannot be blank.')
      return
    }

    const patch: Parameters<typeof updateFormField>[1] = {}
    if (trimmedLabel !== baseline.label) patch.label = trimmedLabel
    if (helpText !== baseline.helpText) patch.helpText = helpText
    if (groupLabel.trim() !== baseline.groupLabel.trim()) patch.groupLabel = groupLabel.trim()
    if (!locked && inputType !== baseline.inputType) patch.inputType = inputType

    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }

    setBusy(true)
    setError(null)
    try {
      await updateFormField(field.id, patch)
      onChanged()
      onClose()
    } catch (err) {
      // `ship.guard_form_field` names the field and says why -- more useful
      // than anything this component could invent, so shown as thrown.
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
      title={isDefault ? 'Edit default question' : 'Edit question'}
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
            onClick={() => void handleSave()}
            disabled={busy || label.trim() === ''}
            className="rounded-[0.9rem] bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
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
          <span className="text-[11px] font-medium text-slate-500">Question</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSave()
              }
            }}
            disabled={busy}
            className={`mt-1 ${INPUT_CLASS}`}
          />
        </label>

        <label className="block">
          <span className="text-[11px] font-medium text-slate-500">Help text (optional)</span>
          <input
            value={helpText}
            onChange={(e) => setHelpText(e.target.value)}
            disabled={busy}
            placeholder="Shown under the question"
            className={`mt-1 ${INPUT_CLASS}`}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-[11px] font-medium text-slate-500">Input type</span>
            {locked ? (
              <div
                title="This question is stored in its own column, so its type is fixed."
                className="mt-1 rounded-[0.8rem] bg-slate-100 px-3 py-2 text-sm text-slate-500"
              >
                {INPUT_TYPE_LABELS[field.inputType]}
              </div>
            ) : (
              <select
                value={inputType}
                onChange={(e) => setInputType(e.target.value as FormFieldInputType)}
                disabled={busy}
                className={`mt-1 ${INPUT_CLASS}`}
              >
                {INPUT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {INPUT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="block">
            <span className="text-[11px] font-medium text-slate-500">Group</span>
            <input
              value={groupLabel}
              onChange={(e) => setGroupLabel(e.target.value)}
              list={listId}
              disabled={busy}
              placeholder="Ungrouped"
              className={`mt-1 ${INPUT_CLASS}`}
            />
            <datalist id={listId}>
              {groupSuggestions.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
        </div>

        {hasOptions(inputType) ? <OptionsEditor field={field} onChanged={onChanged} /> : null}
      </div>
    </Modal>
  )
}
