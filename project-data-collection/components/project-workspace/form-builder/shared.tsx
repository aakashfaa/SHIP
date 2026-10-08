import type { ReactNode } from 'react'
import type { FormField, FormFieldInputType } from '@/lib/types'

/** Short, human names for the list view. The list is a ~60% column, so these
 *  are deliberately terse ("Dropdown (single)", not "...single choice"). */
export const INPUT_TYPE_LABELS: Record<FormFieldInputType, string> = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  currency: 'Currency',
  select: 'Dropdown (single)',
  multiselect: 'Dropdown (multiple)',
  boolean: 'Yes/No',
  date: 'Date',
}

export const INPUT_TYPES = Object.keys(INPUT_TYPE_LABELS) as FormFieldInputType[]

export function hasOptions(inputType: FormFieldInputType): boolean {
  return inputType === 'select' || inputType === 'multiselect'
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
export const FIXED_OPTION_SET_KEYS = new Set<string>([
  'operational_impact',
  'benefit_to_users',
  'benefit_to_public',
  'relative_first_cost',
  'relative_operation_cost_impact',
  'relative_operational_energy_usage',
  'electrification_eo594',
  'potential_synergies',
])

/** The grouping key for a field: its wizard-step name, with blank meaning
 *  "Ungrouped". Kept raw (not trimmed) when non-blank so moving a field into
 *  a group writes back exactly the label its neighbours already carry. */
export function groupKeyOf(field: Pick<FormField, 'groupLabel'>): string {
  return field.groupLabel.trim() === '' ? '' : field.groupLabel
}

export function groupDisplayName(key: string): string {
  return key === '' ? 'Ungrouped' : key
}

export const INPUT_CLASS =
  'w-full min-w-0 rounded-[0.8rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:opacity-50'

export type PillTone = 'default' | 'required' | 'optional' | 'hidden' | 'visible'

const PILL_TONES: Record<PillTone, string> = {
  default: 'border-slate-900 bg-slate-900 text-white',
  required: 'border-teal-200 bg-teal-50 text-teal-700',
  optional: 'border-slate-200 bg-white text-slate-500',
  hidden: 'border-amber-200 bg-amber-50 text-amber-800',
  visible: 'border-slate-200 bg-white text-slate-500',
}

/**
 * A status pill. Given `onClick` it becomes a toggle button (edit mode);
 * without one it is a plain label (view mode), so a compact list can't be
 * changed by a stray click.
 */
export function Pill({
  tone,
  title,
  onClick,
  disabled,
  ariaLabel,
  children,
}: {
  tone: PillTone
  title?: string
  onClick?: () => void
  disabled?: boolean
  ariaLabel?: string
  children: ReactNode
}) {
  const base = `inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PILL_TONES[tone]}`

  if (!onClick) {
    return (
      <span title={title} className={base}>
        {children}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`${base} cursor-pointer transition hover:brightness-95 hover:ring-2 hover:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  )
}

/** Small round icon button used in the header and on rows. */
export function IconButton({
  label,
  onClick,
  active,
  disabled,
  tone = 'plain',
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  tone?: 'plain' | 'danger'
  children: ReactNode
}) {
  const toneClass = active
    ? 'border-slate-950 bg-slate-950 text-white'
    : tone === 'danger'
      ? 'border-slate-200 bg-white text-slate-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600'
      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40 ${toneClass}`}
    >
      {children}
    </button>
  )
}

export const PencilIcon = () => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M13.5 3.5l3 3L7 16H4v-3l9.5-9.5z" strokeLinejoin="round" />
  </svg>
)

export const PlusIcon = () => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 4v12M4 10h12" strokeLinecap="round" />
  </svg>
)

export const CheckIcon = () => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const TrashIcon = () => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const CloseIcon = () => (
  <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
  </svg>
)

export const GripIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
    <circle cx="7.5" cy="5" r="1.3" />
    <circle cx="12.5" cy="5" r="1.3" />
    <circle cx="7.5" cy="10" r="1.3" />
    <circle cx="12.5" cy="10" r="1.3" />
    <circle cx="7.5" cy="15" r="1.3" />
    <circle cx="12.5" cy="15" r="1.3" />
  </svg>
)

export const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    viewBox="0 0 20 20"
    className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
