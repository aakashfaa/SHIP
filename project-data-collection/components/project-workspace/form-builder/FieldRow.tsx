'use client'

import type { DragEvent, ReactNode } from 'react'
import { ALWAYS_REQUIRED_KEYS, isDefaultField } from '@/lib/form-defaults'
import type { FormField } from '@/lib/types'
import {
  ChevronIcon,
  IconButton,
  INPUT_TYPE_LABELS,
  PencilIcon,
  Pill,
  TrashIcon,
  hasOptions,
} from './shared'

/**
 * One question in the builder list. Compact by design: label, input type,
 * pills. Dropdown options appear only when the chevron is opened, and
 * everything that changes the field (pills as toggles, drag handle, edit,
 * remove) appears only in edit mode.
 */
export default function FieldRow({
  field,
  editMode,
  busy,
  expanded,
  confirmingDelete,
  dropIndicator,
  handle,
  onToggleExpand,
  onToggleRequired,
  onToggleHidden,
  onEdit,
  onRemove,
  onConfirmDelete,
  onCancelDelete,
  onDragOver,
  onDrop,
}: {
  field: FormField
  editMode: boolean
  busy: boolean
  expanded: boolean
  confirmingDelete: boolean
  dropIndicator: 'before' | 'after' | null
  handle: ReactNode
  onToggleExpand: () => void
  onToggleRequired: () => void
  onToggleHidden: () => void
  onEdit: () => void
  onRemove: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  onDragOver: (event: DragEvent<HTMLLIElement>) => void
  onDrop: (event: DragEvent<HTMLLIElement>) => void
}) {
  const isDefault = isDefaultField(field)
  const requiredLocked = ALWAYS_REQUIRED_KEYS.has(field.key)
  const dropdown = hasOptions(field.inputType)
  const activeOptions = dropdown
    ? field.options.filter((o) => !o.isArchived).sort((a, b) => a.sortOrder - b.sortOrder)
    : []
  const archivedCount = dropdown ? field.options.length - activeOptions.length : 0

  // Visibility toggle on every non-default question: hiding keeps it in
  // this list (and its column/answers) and it can be shown again any time.
  // A default can't be hidden, but one that already is (an older project)
  // can be un-hidden.
  const showVisibilityToggle = !isDefault || field.isHidden

  return (
    <li
      data-drag-row
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`relative rounded-[0.8rem] border border-slate-200/80 bg-white px-2 py-1.5 transition ${
        busy ? 'opacity-60' : ''
      } ${expanded ? 'shadow-sm' : 'hover:border-slate-300'}`}
    >
      {dropIndicator ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-teal-500 ${
            dropIndicator === 'before' ? '-top-px' : '-bottom-px'
          }`}
        />
      ) : null}

      <div className="flex items-center gap-2">
        {editMode ? (
          handle
        ) : (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
        )}

        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className={`min-w-0 truncate text-sm font-medium ${
              field.isHidden ? 'text-slate-400' : 'text-slate-900'
            }`}
            title={field.helpText || undefined}
          >
            {field.label}
          </span>
          <span className="shrink-0 text-[12px] text-slate-400">
            {INPUT_TYPE_LABELS[field.inputType]}
          </span>
          {dropdown ? (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} options for ${field.label}`}
              className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded-full text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
            >
              <ChevronIcon open={expanded} />
            </button>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isDefault ? (
            <Pill tone="default" title="Asked on every line item. Can be renamed and moved, not removed.">
              Default
            </Pill>
          ) : null}

          {editMode ? (
            <Pill
              tone={field.isRequired ? 'required' : 'optional'}
              onClick={requiredLocked ? undefined : onToggleRequired}
              disabled={busy}
              ariaLabel={`${field.label}: ${field.isRequired ? 'required' : 'optional'}. Click to make ${field.isRequired ? 'optional' : 'required'}.`}
              title={requiredLocked ? 'Always required.' : undefined}
            >
              {field.isRequired ? 'Required' : 'Optional'}
            </Pill>
          ) : field.isRequired ? (
            <Pill tone="required">Required</Pill>
          ) : null}

          {editMode && showVisibilityToggle ? (
            <Pill
              tone={field.isHidden ? 'hidden' : 'visible'}
              onClick={onToggleHidden}
              disabled={busy}
              ariaLabel={`${field.label}: ${field.isHidden ? 'hidden' : 'visible'}. Click to ${field.isHidden ? 'show' : 'hide'}.`}
            >
              {field.isHidden ? 'Hidden' : 'Visible'}
            </Pill>
          ) : !editMode && field.isHidden ? (
            <Pill tone="hidden">Hidden</Pill>
          ) : null}

          {editMode ? (
            <>
              <IconButton label={`Edit ${field.label}`} onClick={onEdit} disabled={busy}>
                <PencilIcon />
              </IconButton>
              {isDefault ? (
                // Keeps the column of buttons aligned on default rows.
                <span aria-hidden className="h-7 w-7 shrink-0" />
              ) : (
                <IconButton
                  label={`Remove ${field.label}`}
                  onClick={onRemove}
                  disabled={busy || confirmingDelete}
                  tone="danger"
                >
                  <TrashIcon />
                </IconButton>
              )}
            </>
          ) : null}
        </div>
      </div>

      {expanded && dropdown ? (
        <div className={`mt-1.5 flex flex-wrap gap-1 pb-0.5 ${editMode ? 'pl-7' : 'pl-3.5'}`}>
          {activeOptions.length === 0 ? (
            <span className="text-[11px] text-slate-400">No options yet</span>
          ) : (
            activeOptions.map((option) => (
              <span
                key={option.id}
                className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600"
              >
                {option.label}
              </span>
            ))
          )}
          {archivedCount > 0 ? (
            <span className="px-1 py-0.5 text-[11px] text-slate-400">+{archivedCount} archived</span>
          ) : null}
        </div>
      ) : null}

      {confirmingDelete ? (
        // Two-step inline confirm rather than window.confirm(). A native
        // dialog blocks the whole page until it is dismissed, which freezes
        // any browser automation that reaches it; same pattern as packages.
        <div
          role="alertdialog"
          aria-label={`Confirm remove ${field.label}`}
          className="mt-1.5 flex flex-wrap items-center justify-between gap-2 rounded-[0.85rem] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800"
        >
          <span>
            Remove &ldquo;{field.label}&rdquo;? Existing answers are kept but the question is gone
            from the form.
          </span>
          <span className="flex gap-1.5">
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={busy}
              className="rounded-[0.7rem] bg-rose-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-rose-700 disabled:opacity-40"
            >
              {busy ? 'Removing…' : 'Confirm remove'}
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={busy}
              className="rounded-[0.7rem] border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 disabled:opacity-40"
            >
              Cancel
            </button>
          </span>
        </div>
      ) : null}
    </li>
  )
}
