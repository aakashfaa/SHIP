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
 * booleans (column booleans already store 'Yes'/'No'; custom ones store
 * true/false), grouped digits for numbers. Currency text is shown as typed --
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
