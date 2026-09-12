'use client'

import { useMemo, useState } from 'react'
import {
  addFieldOption,
  createFormField,
  deleteFormField,
  reorderFieldOptions,
  reorderFormFields,
  setFieldOptionArchived,
  updateFormField,
} from '@/lib/store'
import type { FormField, FormFieldInputType } from '@/lib/types'

/**
 * Editor for a project's line-item FORM (migration 0012), replacing the
 * vocabulary editor this project used to have.
 *
 * The client's own words: "instead of vocabulary like that, can we make it
 * such that they can create a form with the different input types and then
 * the different options? ... don't call it a vocabulary, just call it a
 * form creation." That reframes the whole screen: this used to be four lists
 * of dropdown VALUES for a fixed set of questions. Now the questions
 * themselves — their labels, types, order and grouping — are the thing being
 * edited, and options are just a property a field has when its type calls
 * for one.
 *
 * TWO KINDS OF FIELD (see the migration's header for the full rationale):
 *   - built-in (`isBuiltin`): backed by a real `line_items` column that other
 *     code reads by name (ecc_amount from estimated_first_cost, the energy
 *     chart from annual_energy_savings, numbering from discipline). Label,
 *     help text, grouping, order, required and hidden are all fair game.
 *     The key, input type and existence of the row are not — the database
 *     enforces that with `ship.guard_form_field`, and this editor mirrors
 *     the restriction in the UI rather than showing a control that would
 *     only fail on save.
 *   - custom (`!isBuiltin`): lives in `LineItem.customFields`. Fully
 *     editable, retypeable and deletable.
 *
 * There is no delete for a built-in — Hide is presented as ITS delete,
 * because for a built-in that is exactly what it is: the field stops being
 * asked without anything downstream losing the column it depends on.
 */

type Props = {
  projectId: string
  fields: FormField[]
  onChanged: () => void
  readOnly?: boolean
}

/**
 * Selects (and one multiselect) whose values are still `CHECK`-constrained
 * on `ship.line_items` by migration 0001 and were never freed by 0008 the
 * way the four taxonomy columns were — see `ship.default_form_field_options`
 * in migration 0012, which seeds exactly this set and no others. Offering an
 * "Add option" control here would produce a value the database rejects on
 * the very next save, which is worse than not offering it at all.
 *
 * Deliberately not "the four taxonomy dropdowns' opposite" — it is easy to
 * undercount this list (six of these read as "the obvious impact scales"
 * and it's tempting to stop there), so it is checked directly against
 * 0001's CHECK constraints rather than assumed: `electrification_eo594`
 * keeps its own four-value CHECK, and `potential_synergies` (a multiselect)
 * is constrained to the consultant-type array. Reordering and archiving
 * existing options is still fine for all of these — the CHECK constrains
 * the VALUE, not its order or whether it is offered.
 */
const FIXED_OPTION_SET_KEYS = new Set<string>([
  'operational_impact',
  'benefit_to_users',
  'benefit_to_public',
  'relative_first_cost',
  'relative_operation_cost_impact',
  'relative_operational_energy_usage',
  'electrification_eo594',
  'potential_synergies',
])

const INPUT_TYPE_LABELS: Record<FormFieldInputType, string> = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  currency: 'Currency',
  select: 'Dropdown (single choice)',
  multiselect: 'Dropdown (multiple choice)',
  boolean: 'Yes / no',
  date: 'Date',
}

const INPUT_TYPES = Object.keys(INPUT_TYPE_LABELS) as FormFieldInputType[]

function hasOptions(inputType: FormFieldInputType): boolean {
  return inputType === 'select' || inputType === 'multiselect'
}

function Badge({
  tone,
  title,
  children,
}: {
  tone: 'builtin' | 'hidden' | 'required'
  title?: string
  children: React.ReactNode
}) {
  const toneClasses =
    tone === 'builtin'
      ? 'bg-slate-950 text-white'
      : tone === 'hidden'
        ? 'border border-amber-200 bg-amber-50 text-amber-800'
        : 'border border-teal-200 bg-teal-50 text-teal-700'

  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${toneClasses}`}
    >
      {children}
    </span>
  )
}

/** One field's option list: add, archive, restore, reorder. Mirrors
 *  TaxonomyEditor's KindSection, which this supersedes. */
/** The one-line summary on the collapsed options disclosure. Counts rather
 *  than a generic "Options" label, so a field with no values at all -- which
 *  renders an empty dropdown in Add Data -- is visible without expanding. */
function optionSummary(field: FormField): string {
  const active = field.options.filter((o) => !o.isArchived).length
  const archived = field.options.length - active

  if (active === 0 && archived === 0) return 'No options yet'
  const base = `${active} option${active === 1 ? '' : 's'}`
  return archived > 0 ? `${base}, ${archived} archived` : base
}

function OptionsEditor({
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

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
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

    const existing = active.find((o) => o.value.toLowerCase() === value.toLowerCase())
    if (!existing) {
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
      return
    }
    setError(`"${value}" is already an option on this field.`)
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...active]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]

    void run(() =>
      reorderFieldOptions(field.id, [...next.map((o) => o.id), ...archived.map((o) => o.id)])
    )
  }

  return (
    <div className="mt-3 rounded-[1rem] border border-dashed border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-slate-500">
          Options ({active.length})
        </span>
      </div>

      {error ? (
        <div className="mt-2 rounded-[0.85rem] border border-rose-200 bg-rose-50 px-3 py-1.5 text-[11px] text-rose-700">
          {error}
        </div>
      ) : null}

      <ul className="mt-2 space-y-1.5">
        {active.length === 0 ? (
          <li className="rounded-[0.85rem] border border-dashed border-slate-200 px-3 py-3 text-center text-[11px] text-slate-400">
            No options yet. This dropdown has nothing to offer.
          </li>
        ) : (
          active.map((option, index) => (
            <li
              key={option.id}
              className="flex items-center gap-2 rounded-[0.85rem] border border-slate-200 bg-white px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-slate-800">
                {option.label}
              </span>
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={busy || index === 0}
                aria-label={`Move ${option.label} up`}
                className="rounded-[0.6rem] border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={busy || index === active.length - 1}
                aria-label={`Move ${option.label} down`}
                className="rounded-[0.6rem] border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 disabled:opacity-30"
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
          This dropdown&apos;s values are fixed by a database constraint and can&apos;t take new
          entries — reorder or archive the ones above, but adding one here would only fail on
          save.
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
            <ul className="mt-1.5 space-y-1.5">
              {archived.map((option) => (
                <li
                  key={option.id}
                  className="flex items-center gap-2 rounded-[0.85rem] border border-dashed border-slate-200 bg-white px-2.5 py-1.5"
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

function FieldRow({
  field,
  onChanged,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  field: FormField
  onChanged: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (direction: -1 | 1) => Promise<void>
}) {
  const [label, setLabel] = useState(field.label)
  const [helpText, setHelpText] = useState(field.helpText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Two-step inline confirm rather than window.confirm(). A native dialog
  // blocks the whole page until it is dismissed, which freezes any browser
  // automation that reaches it, and nothing else in this app uses one.
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      // `ship.guard_form_field` names the field and says "Hide it instead" --
      // that is more useful than anything this component could invent, so it
      // is shown exactly as thrown rather than replaced.
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  function saveLabel() {
    const trimmed = label.trim()
    if (trimmed === field.label) return
    if (trimmed === '') {
      setError('Label cannot be blank.')
      setLabel(field.label)
      return
    }
    void run(() => updateFormField(field.id, { label: trimmed }))
  }

  function saveHelpText() {
    if (helpText === field.helpText) return
    void run(() => updateFormField(field.id, { helpText }))
  }

  return (
    <li className="rounded-[1rem] border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-slate-900">
            {field.label}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-slate-400">{field.key}</span>
        </div>

        {field.isBuiltin ? (
          <Badge
            tone="builtin"
            title={`Built-in — maps to the "${field.key}" column, which the cost and energy engines read. It can be relabelled, reordered and hidden, but not deleted or retyped.`}
          >
            Built-in
          </Badge>
        ) : null}
        {field.isHidden ? <Badge tone="hidden">Hidden</Badge> : null}
        {field.isRequired ? <Badge tone="required">Required</Badge> : null}

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void run(() => onMove(-1))}
            disabled={busy || !canMoveUp}
            aria-label={`Move ${field.label} up`}
            className="rounded-[0.7rem] border border-slate-200 px-2 py-1 text-xs text-slate-600 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => void run(() => onMove(1))}
            disabled={busy || !canMoveDown}
            aria-label={`Move ${field.label} down`}
            className="rounded-[0.7rem] border border-slate-200 px-2 py-1 text-xs text-slate-600 disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => void run(() => updateFormField(field.id, { isRequired: !field.isRequired }))}
            disabled={busy}
            className={`rounded-[0.7rem] border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
              field.isRequired
                ? 'border-teal-200 bg-teal-50 text-teal-700'
                : 'border-slate-200 text-slate-600 hover:border-slate-300'
            }`}
          >
            {field.isRequired ? 'Required' : 'Optional'}
          </button>
          <button
            type="button"
            onClick={() => void run(() => updateFormField(field.id, { isHidden: !field.isHidden }))}
            disabled={busy}
            title={
              field.isBuiltin
                ? 'Stops asking this question without touching the column downstream code reads. This is a built-in\'s equivalent of deleting it.'
                : 'Stops asking this question. The field and any values already recorded are kept, so it can be brought back later.'
            }
            className={`rounded-[0.7rem] border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
              field.isBuiltin && !field.isHidden
                ? 'border-slate-950 bg-slate-950 text-white hover:opacity-90'
                : 'border-slate-200 text-slate-600 hover:border-slate-300'
            }`}
          >
            {field.isHidden ? 'Unhide' : 'Hide'}
          </button>
          {!field.isBuiltin ? (
            confirmingDelete ? (
              <>
                <button
                  type="button"
                  onClick={() => void run(() => deleteFormField(field.id))}
                  disabled={busy}
                  className="rounded-[0.7rem] border border-rose-300 bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-40"
                >
                  {busy ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                  className="rounded-[0.7rem] border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-slate-300 disabled:opacity-40"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
                title={`Removes "${field.label}" from the form. Values already recorded against it stay in the database but stop being shown.`}
                className="rounded-[0.7rem] border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40"
              >
                Delete
              </button>
            )
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mt-2 rounded-[0.85rem] border border-rose-200 bg-rose-50 px-3 py-1.5 text-[12px] text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="mt-2.5 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={saveLabel}
          aria-label={`Label for ${field.key}`}
          className="min-w-0 rounded-[0.7rem] border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        <input
          value={helpText}
          onChange={(e) => setHelpText(e.target.value)}
          onBlur={saveHelpText}
          placeholder="Help text shown under the question (optional)"
          aria-label={`Help text for ${field.key}`}
          className="min-w-0 rounded-[0.7rem] border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        {field.isBuiltin ? (
          <span className="flex items-center rounded-[0.7rem] bg-slate-100 px-2.5 py-1.5 text-[12px] text-slate-500">
            {INPUT_TYPE_LABELS[field.inputType]}
          </span>
        ) : (
          <select
            value={field.inputType}
            onChange={(e) =>
              void run(() =>
                updateFormField(field.id, { inputType: e.target.value as FormFieldInputType })
              )
            }
            disabled={busy}
            aria-label={`Input type for ${field.key}`}
            className="rounded-[0.7rem] border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:opacity-40"
          >
            {INPUT_TYPES.map((type) => (
              <option key={type} value={type}>
                {INPUT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        )}
      </div>

      {/*
        Collapsed by default. Expanded, 26 fields with every dropdown's values
        listed inline made this page ~10,000px tall -- the building-level
        field alone has 13 options and the synergies field has 14. A settings
        screen you have to scroll for a minute to audit is one nobody audits.
        The summary line carries the count so the shape of a field is still
        legible without opening it.
      */}
      {hasOptions(field.inputType) ? (
        <details className="mt-2 group">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-slate-500 hover:text-slate-700">
            <span className="group-open:hidden">▸ </span>
            <span className="hidden group-open:inline">▾ </span>
            {optionSummary(field)}
          </summary>
          <OptionsEditor field={field} onChanged={onChanged} />
        </details>
      ) : null}
    </li>
  )
}

/** Draft state for the "add a field" control at the foot of the list. */
function AddFieldControl({
  projectId,
  groupSuggestions,
  onChanged,
}: {
  projectId: string
  groupSuggestions: string[]
  onChanged: () => void
}) {
  const [label, setLabel] = useState('')
  const [inputType, setInputType] = useState<FormFieldInputType>('text')
  const [groupLabel, setGroupLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdd() {
    const trimmed = label.trim()
    if (trimmed === '') return

    setBusy(true)
    setError(null)
    try {
      await createFormField(projectId, {
        label: trimmed,
        inputType,
        groupLabel: groupLabel.trim(),
      })
      setLabel('')
      setGroupLabel('')
      setInputType('text')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-white/60 p-5">
      <div className="text-sm font-semibold text-slate-950">Add a field</div>
      <p className="mt-1 text-[12px] text-slate-500">
        Creates a fully custom field — its type, label and options are yours to change or remove
        later. Options (if the type needs them) are added below once the field exists.
      </p>

      {error ? (
        <div className="mt-3 rounded-[1rem] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleAdd()
            }
          }}
          placeholder="Question, e.g. Roof warranty expiry"
          aria-label="New field label"
          className="min-w-0 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        <select
          value={inputType}
          onChange={(e) => setInputType(e.target.value as FormFieldInputType)}
          aria-label="New field input type"
          className="rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        >
          {INPUT_TYPES.map((type) => (
            <option key={type} value={type}>
              {INPUT_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <input
          value={groupLabel}
          onChange={(e) => setGroupLabel(e.target.value)}
          list="form-builder-group-suggestions"
          placeholder="Group (e.g. Cost and energy)"
          aria-label="New field group"
          className="min-w-0 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={busy || label.trim() === ''}
          className="rounded-[0.95rem] bg-slate-950 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40"
        >
          Add field
        </button>
      </div>

      <datalist id="form-builder-group-suggestions">
        {groupSuggestions.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </div>
  )
}

export default function FormBuilder({ projectId, fields, onChanged, readOnly = false }: Props) {
  const sorted = useMemo(() => [...fields].sort((a, b) => a.sortOrder - b.sortOrder), [fields])

  const groups = useMemo(() => {
    const order: string[] = []
    const byLabel = new Map<string, FormField[]>()
    for (const field of sorted) {
      const label = field.groupLabel.trim() === '' ? 'Ungrouped' : field.groupLabel
      if (!byLabel.has(label)) {
        order.push(label)
        byLabel.set(label, [])
      }
      byLabel.get(label)!.push(field)
    }
    return order.map((label) => ({ label, fields: byLabel.get(label)! }))
  }, [sorted])

  const groupSuggestions = useMemo(
    () => groups.map((g) => g.label).filter((label) => label !== 'Ungrouped'),
    [groups]
  )

  /**
   * Moving a field up or down reorders it against its GROUP neighbours, but
   * `reorderFormFields` persists a single project-wide order (it renumbers
   * whatever id list it is given 0..n-1) -- so the move swaps the two
   * fields' positions in the full list and resends everyone's id, the same
   * way TaxonomyEditor resent archived rows alongside active ones just to
   * keep them where they were.
   */
  async function moveField(groupFields: FormField[], field: FormField, direction: -1 | 1) {
    const groupIndex = groupFields.findIndex((f) => f.id === field.id)
    const targetIndex = groupIndex + direction
    if (targetIndex < 0 || targetIndex >= groupFields.length) return
    const other = groupFields[targetIndex]

    const next = sorted.map((f) => {
      if (f.id === field.id) return other
      if (f.id === other.id) return field
      return f
    })

    await reorderFormFields(projectId, next.map((f) => f.id))
  }

  return (
    <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0 space-y-4">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-slate-950">Line item form</h3>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          The questions asked when someone on this project adds a line item — their labels,
          types, order and grouping. This is per project, so a practice that wants to ask
          something extra, drop a question it never uses, or reorder the wizard does it here
          instead of filing a change request.
        </p>
        <p className="mt-2 max-w-2xl rounded-[1.25rem] border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] leading-snug text-slate-600">
          <span className="font-medium text-slate-800">Built-in</span> fields map to a real
          column that the cost and energy engines read — they can be relabelled, reordered,
          regrouped and hidden, but not deleted or retyped. Hiding one is the built-in
          equivalent of deleting it: the question stops being asked and nothing downstream loses
          the column it depends on.
        </p>
      </div>

      {readOnly ? (
        <div className="rounded-[1.25rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-medium">Read-only.</span> Only a project editor or admin can
          change the form.
        </div>
      ) : null}

      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.label} className="rounded-[1.5rem] border border-slate-200 bg-white/90 p-5">
            <div className="text-sm font-semibold text-slate-950">{group.label}</div>

            <ul className="mt-3 space-y-2.5">
              {group.fields.map((field, index) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  onChanged={onChanged}
                  canMoveUp={index > 0}
                  canMoveDown={index < group.fields.length - 1}
                  onMove={(direction) => moveField(group.fields, field, direction)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <AddFieldControl
        projectId={projectId}
        groupSuggestions={groupSuggestions}
        onChanged={onChanged}
      />
    </fieldset>
  )
}
