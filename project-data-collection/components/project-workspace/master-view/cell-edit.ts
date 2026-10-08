/**
 * Master View edit mode: turning a row's typed cell values into a validated
 * line-item patch. Pure (relative imports only) so it runs under node --test.
 *
 * Same rules as Add Data (components/project-workspace/AddDataTab.tsx):
 *   - number and cost text is kept RAW while typing and parsed once, on save
 *     (M-06, M-09, D-9, D-16): blank -> null, "1,200" -> 1200, anything
 *     unreadable blocks the save with an inline error;
 *   - required fields can't be blanked;
 *   - Yes/No questions are tri-state (0023): column booleans store
 *     'Yes'/'No'/NULL, custom booleans true/false or the key is omitted;
 *   - a blank dropdown is sent as NULL, never '' (the built-in columns'
 *     CHECK lists reject '' -- see migration 0014, D-9).
 *
 * Only the fields actually changed are sent, so a save never rewrites an
 * answer this admin didn't touch.
 */

import { COST_PARSE_MESSAGES, parseCostAmount } from '../../../lib/costs'
import { fieldKeyToProperty, getFieldValue, isFieldValueEmpty, readYesNo } from '../../../lib/form-values'
import type { FormField, LineItem } from '../../../lib/types'

/** What an edit control holds: text for text/number/cost/date/select,
 *  boolean for an answered Yes/No (true = Yes) and '' for an unanswered one,
 *  string[] for multiselect. */
export type CellValue = string | boolean | string[]

/** One row's changed cells, keyed by form field key. */
export type RowDraft = Record<string, CellValue>

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const PLAIN_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/

export function parseNumberText(text: string): Parsed<number | null> {
  const cleaned = text.replace(/[,\s]/g, '')
  if (cleaned === '') return { ok: true, value: null }
  if (!PLAIN_NUMBER.test(cleaned)) return { ok: false, error: 'Enter a number, like 12.5 or -200.' }
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return { ok: false, error: 'That number is too large.' }
  return { ok: true, value: n }
}

export function parseCostText(text: string): Parsed<number | null> {
  const r = parseCostAmount(text)
  if (!r.ok) return { ok: false, error: COST_PARSE_MESSAGES[r.reason] }
  return { ok: true, value: r.amount }
}

/** The value an edit control starts with for this item. */
export function initialCellValue(field: FormField, item: LineItem): CellValue {
  const raw = getFieldValue(item, field)
  switch (field.inputType) {
    case 'boolean': {
      const answer = readYesNo(raw)
      return answer === null ? '' : answer
    }
    case 'multiselect':
      return Array.isArray(raw) ? raw.map(String) : []
    default:
      return raw === null || raw === undefined ? '' : String(raw)
  }
}

export function sameCellValue(a: CellValue, b: CellValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    const sortedB = [...b].sort()
    return [...a].sort().every((v, i) => v === sortedB[i])
  }
  return a === b
}

/** Errors for a row's changed cells, keyed by field key. Empty = savable. */
export function validateRowDraft(fields: readonly FormField[], draft: RowDraft): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    if (!(field.key in draft)) continue
    const value = draft[field.key]
    if (field.isRequired && isFieldValueEmpty(field, value)) {
      errors[field.key] = 'Required.'
      continue
    }
    if (typeof value !== 'string') continue
    if (field.inputType === 'number') {
      const r = parseNumberText(value)
      if (!r.ok) errors[field.key] = r.error
    } else if (field.inputType === 'currency') {
      const r = parseCostText(value)
      if (!r.ok) errors[field.key] = r.error
    }
  }
  return errors
}

function storedValue(field: FormField, value: CellValue): unknown {
  switch (field.inputType) {
    case 'boolean':
      // '' = unanswered: NULL for a column; buildRowPatch drops a custom key.
      if (typeof value !== 'boolean') return field.storage === 'column' ? null : undefined
      return field.storage === 'column' ? (value ? 'Yes' : 'No') : value
    case 'multiselect':
      return Array.isArray(value) ? value : []
    case 'number': {
      const r = parseNumberText(String(value))
      return r.ok ? r.value : null
    }
    case 'currency':
      return String(value).trim()
    case 'select':
      return value === '' ? null : value
    default:
      return String(value)
  }
}

/**
 * The update patch for one row: changed column fields under their LineItem
 * property, changed custom fields merged over the row's current
 * customFields (the column is one jsonb object, so it is sent whole).
 * Only call after validateRowDraft came back empty.
 */
export function buildRowPatch(
  item: LineItem,
  fields: readonly FormField[],
  draft: RowDraft
): Partial<LineItem> {
  const patch: Record<string, unknown> = {}
  let customFields: Record<string, unknown> | null = null

  for (const field of fields) {
    if (!(field.key in draft)) continue
    const value = storedValue(field, draft[field.key])
    if (field.storage === 'custom') {
      const next: Record<string, unknown> = { ...(customFields ?? item.customFields ?? {}) }
      if (value === undefined) delete next[field.key]
      else next[field.key] = value
      customFields = next
    } else {
      patch[fieldKeyToProperty(field.key)] = value
    }
  }

  if (customFields) patch.customFields = customFields
  return patch as Partial<LineItem>
}
