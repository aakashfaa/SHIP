/**
 * Reading and displaying line-item answers through the project's form
 * definition (`ship.form_fields`, migration 0012).
 *
 * A field's value lives in one of two places: a `storage: 'column'` field is
 * a real `line_items` column (camelCased onto the LineItem by lib/mappers.ts),
 * a `storage: 'custom'` field lives in `LineItem.customFields[field.key]`.
 * Every place that shows answers -- the Excel Line Items sheet now, Master
 * View and Add Data later -- needs the same two helpers, and before this file
 * each component carried its own copy, so the export (which had neither)
 * fell back to a hardcoded column list that omitted every custom field and
 * included hidden ones (M-28).
 *
 * Pure and dependency-free (type imports only) so it runs in the browser, in
 * the export route and under `node --test` alike.
 */

import type { FormField, LineItem } from './types'

/**
 * `key` on a column field IS the snake_case column name; lib/mappers.ts maps
 * each onto a camelCase LineItem property by the mechanical rule, except
 * `electrification_eo594` -> `electrificationEO594`, which keeps its capital
 * "EO" (see the top of lib/mappers.ts). Special-cased rather than teaching the
 * rule to guess acronyms.
 */
const CAMEL_CASE_OVERRIDES: Record<string, string> = {
  electrification_eo594: 'electrificationEO594',
}

export function fieldKeyToProperty(key: string): string {
  return CAMEL_CASE_OVERRIDES[key] ?? key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** Anything with the LineItem shape, or a draft of one. */
type ItemLike = Pick<LineItem, 'customFields'> | Partial<LineItem>

/** A field's raw value on a line item, whichever storage it uses. */
export function getFieldValue(item: ItemLike, field: Pick<FormField, 'key' | 'storage'>): unknown {
  if (field.storage === 'custom') return item.customFields?.[field.key]
  return (item as unknown as Record<string, unknown>)[fieldKeyToProperty(field.key)]
}

/**
 * Whether an answer counts as "not given". D-9: for numbers, blank is
 * unanswered and 0 is a real answer; a boolean that is false/"No" is an
 * answer too.
 */
export function isFieldValueEmpty(field: Pick<FormField, 'inputType'>, value: unknown): boolean {
  if (value === undefined || value === null) return true
  switch (field.inputType) {
    case 'multiselect':
      return !Array.isArray(value) || value.length === 0
    case 'boolean':
      return value === ''
    case 'number':
      if (typeof value === 'number') return !Number.isFinite(value)
      return typeof value === 'string' && value.trim() === ''
    default:
      if (typeof value === 'string') return value.trim() === ''
      return false
  }
}

function optionLabel(field: Pick<FormField, 'options'>, value: unknown): string {
  const text = String(value)
  const option = field.options?.find((o) => o.value === text)
  return option?.label || text
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })

export type FormatFieldValueOptions = {
  /** What to show for an unanswered field. Default ''. */
  empty?: string
}

/**
 * A field's value as display text: option labels for select/multiselect
 * (falling back to the stored value for a retired option), "Yes"/"No" for
 * booleans (column booleans store 'Yes'/'No'/NULL; custom ones store
 * true/false or omit the key when unanswered), grouped digits for numbers. Currency text is shown as typed --
 * it is the input of record, and the parsed amount has its own column.
 */
export function formatFieldValue(
  field: Pick<FormField, 'inputType' | 'options'>,
  value: unknown,
  options: FormatFieldValueOptions = {}
): string {
  const empty = options.empty ?? ''
  if (isFieldValueEmpty(field, value)) return empty

  switch (field.inputType) {
    case 'multiselect':
      return (value as unknown[]).map((v) => optionLabel(field, v)).join(', ')
    case 'select':
      return optionLabel(field, value)
    case 'boolean':
      if (value === true) return 'Yes'
      if (value === false) return 'No'
      return String(value)
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''))
      return Number.isFinite(n) ? NUMBER_FORMAT.format(n) : String(value)
    }
    default:
      if (Array.isArray(value)) return value.map(String).join(', ')
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
  }
}

/** Not hidden, in form order. Same rule as lib/store.ts `visibleFormFields`. */
export function orderedVisibleFields<T extends Pick<FormField, 'isHidden' | 'sortOrder'>>(
  fields: readonly T[]
): T[] {
  return fields.filter((field) => !field.isHidden).slice().sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * What every on-screen surface shows for a skipped answer (Add Data rows,
 * Master View, Packaging). Exports keep a truly blank cell (formatFieldValue's
 * default ''), so this is opt-in via `{ empty: EMPTY_FIELD_TEXT }`.
 */
export const EMPTY_FIELD_TEXT = '-'

/**
 * The value a field starts a brand-new line item with: always "unanswered".
 * A `select` starts EMPTY -- never its first option. Picking options[0] here
 * used to make every skipped Category / Timeline priority / Building area /
 * Operational impact / ... silently save as whatever the project listed
 * first, indistinguishable from a real answer.
 *
 * Yes/No questions too (0023): they are a Yes / No choice with nothing
 * preselected, so a question nobody answered is not recorded as "No".
 */
export function blankValueForField(field: Pick<FormField, 'inputType' | 'storage'>): unknown {
  switch (field.inputType) {
    case 'multiselect':
      return []
    default:
      // select, boolean, text, textarea, date, currency, and number
      // (D-9: blank, not 0).
      return ''
  }
}

/**
 * What a skipped answer is WRITTEN as. Column-backed selects and Yes/No
 * questions become NULL (nullable since 0014 / 0023, and '' would trip their
 * CHECK constraints); column text stays '' (those
 * columns are `not null default ''`); a skipped custom field is dropped from
 * `custom_fields` (`undefined` here means "omit the key"). A real answer is
 * returned unchanged.
 */
export function storedFieldValue(
  field: Pick<FormField, 'inputType' | 'storage'>,
  value: unknown
): unknown {
  if (!isFieldValueEmpty(field, value)) return value
  if (field.storage === 'custom') return undefined
  switch (field.inputType) {
    case 'select':
    case 'boolean':
    case 'number':
    case 'date':
      return null
    case 'multiselect':
      return []
    default:
      return value ?? ''
  }
}

/**
 * A Yes/No answer in either storage, as a tri-state: true (Yes), false (No)
 * or null (not answered). Column booleans store 'Yes' / 'No' / NULL (0023),
 * custom ones true / false / absent.
 */
export function readYesNo(value: unknown): boolean | null {
  if (value === true || value === 'Yes') return true
  if (value === false || value === 'No') return false
  return null
}

/** The tri-state back into the field's storage shape: 'Yes'/'No' for a
 *  column, true/false for a custom field, '' (unanswered, written as
 *  NULL / omitted by storedFieldValue) for null. */
export function writeYesNo(field: Pick<FormField, 'storage'>, answer: boolean | null): unknown {
  if (answer === null) return ''
  if (field.storage === 'column') return answer ? 'Yes' : 'No'
  return answer
}
