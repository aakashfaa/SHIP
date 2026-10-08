'use client'

import { useEffect, useRef, useState } from 'react'
import { fieldOptions } from '@/lib/store'
import type { FormField } from '@/lib/types'
import type { CellValue } from './cell-edit'

/**
 * One Master View cell in edit mode: a compact control for the field's
 * input type. Holds no state of its own beyond the multiselect popover --
 * the row draft lives in MasterViewTab.
 */
type Props = {
  field: FormField
  value: CellValue
  onChange: (value: CellValue) => void
  error?: string
  disabled?: boolean
  /** Choices for `potential_synergies`, which come from the project's
   *  consultants rather than the field's own option list (as in Add Data). */
  synergyOptions: string[]
}

const BASE =
  'w-full rounded-lg border bg-white px-2 py-1.5 text-[11px] leading-4 text-slate-800 outline-none transition focus:border-slate-900 disabled:opacity-60'

export default function EditableCell({ field, value, onChange, error, disabled, synergyOptions }: Props) {
  const border = error ? 'border-rose-400' : 'border-slate-200'
  const text = typeof value === 'string' ? value : ''
  const common = {
    disabled,
    'aria-label': field.label,
    'aria-invalid': error ? true : undefined,
    title: error,
  }
  // Text-like controls go read-only rather than disabled while saving: a
  // disabled input drops focus, so a save landing mid-typing (Packaging saves
  // a cell as soon as focus leaves it) would kick the cursor out.
  const typing = {
    ...common,
    disabled: undefined,
    readOnly: disabled,
    'aria-busy': disabled ? true : undefined,
  }

  switch (field.inputType) {
    case 'boolean':
      // Tri-state (0023): Yes / No with nothing preselected; '' = unanswered.
      // Clicking the chosen answer again clears it when the field is optional.
      return (
        <div
          role="radiogroup"
          aria-label={field.label}
          aria-invalid={error ? true : undefined}
          title={error}
          className={`inline-flex gap-0.5 rounded-lg border p-0.5 ${border}`}
        >
          {([true, false] as const).map((answer) => {
            const active = value === answer
            return (
              <button
                key={String(answer)}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => onChange(active && !field.isRequired ? '' : answer)}
                className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 transition disabled:opacity-60 ${
                  active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {answer ? 'Yes' : 'No'}
              </button>
            )
          })}
        </div>
      )

    case 'multiselect': {
      const options = field.key === 'potential_synergies' ? synergyOptions : fieldOptions(field)
      return (
        <MultiSelectCell
          options={options}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          disabled={disabled}
          label={field.label}
          error={error}
        />
      )
    }

    case 'select': {
      // `text` included even if archived, so opening edit mode never
      // silently rewrites a value (see fieldOptions).
      const options = fieldOptions(field, text)
      return (
        <span className="flex items-center gap-1">
          <select value={text} onChange={(e) => onChange(e.target.value)} className={`${BASE} ${border}`} {...common}>
            {/* An unanswered cell shows a placeholder that can't be picked;
                clearing an optional answer is the button beside it. */}
            <option value="" disabled hidden>
              Select…
            </option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {!field.isRequired && text !== '' ? (
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label={`Clear ${field.label}`}
              title="Clear"
              className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </span>
      )
    }

    case 'textarea':
      return (
        <textarea
          value={text}
          rows={2}
          onChange={(e) => onChange(e.target.value)}
          className={`${BASE} ${border} min-w-[180px] resize-y`}
          {...typing}
        />
      )

    case 'date':
      return (
        <input type="date" value={text} onChange={(e) => onChange(e.target.value)} className={`${BASE} ${border}`} {...typing} />
      )

    case 'number':
    case 'currency':
      return (
        <input
          type="text"
          inputMode={field.inputType === 'number' ? 'decimal' : 'text'}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.inputType === 'currency' ? '1.2m, 850k' : undefined}
          className={`${BASE} ${border}`}
          {...typing}
        />
      )

    default:
      return (
        <input type="text" value={text} onChange={(e) => onChange(e.target.value)} className={`${BASE} ${border}`} {...typing} />
      )
  }
}

function MultiSelectCell({
  options,
  value,
  onChange,
  disabled,
  label,
  error,
}: {
  options: string[]
  value: string[]
  onChange: (value: CellValue) => void
  disabled?: boolean
  label: string
  error?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // A stored value no longer offered (an archived option, a consultant who
  // left) stays listed so it can be seen and unticked.
  const all = [...value.filter((v) => !options.includes(v)), ...options]

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${BASE} ${error ? 'border-rose-400' : 'border-slate-200'} truncate text-left`}
      >
        {value.length > 0 ? value.join(', ') : '-'}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-56 w-56 overflow-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          {all.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-slate-400">No options</p>
          ) : (
            all.map((option) => (
              <label key={option} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={value.includes(option)}
                  onChange={() =>
                    onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option])
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                {option}
              </label>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
