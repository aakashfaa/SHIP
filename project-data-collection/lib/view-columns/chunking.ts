import type { FormField } from '@/lib/types'
import { orderedVisibleFields } from '@/lib/form-values'
import type { ViewColumn } from '@/lib/view-settings'

/**
 * Every column/field the Packaging view can show for a line item, in display
 * order. Settings lists this catalog so a project admin can hide columns;
 * Chunking renders
 * visibleColumns(getChunkingColumns(fields), settings.chunking.hiddenColumns).
 *
 * Keys: a form field column's key IS the form field's `key`. System columns
 * (`_item_number`, `_discipline`, `_total`, `_quantity`) use a leading
 * underscore, which a form field key can never have, so a custom question
 * labelled "Total" or "Discipline" can't collide. The name column is the
 * column-backed built-in `name` field itself (same as Master View). Item
 * number, name and quantity are locked; `_total` is derived (base cost x
 * package quantity).
 *
 * Order: Qty and Total sit right after the name, before any form field, so
 * the one editable cost input never ends up scrolled off to the right when a
 * project shows many columns.
 */
export const CHUNKING_COLUMN_KEYS = {
  itemNumber: '_item_number',
  discipline: '_discipline',
  total: '_total',
  quantity: '_quantity',
  /** The built-in name field's own key. */
  name: 'name',
} as const

export function getChunkingColumns(fields: FormField[]): ViewColumn[] {
  const visible = orderedVisibleFields(fields)
  const nameField = visible.find((f) => f.storage === 'column' && f.key === CHUNKING_COLUMN_KEYS.name)

  const columns: ViewColumn[] = [
    { key: CHUNKING_COLUMN_KEYS.itemNumber, label: '#', locked: true },
  ]
  if (nameField) {
    columns.push({ key: nameField.key, label: nameField.label.trim() || 'Name', locked: true })
  }
  columns.push(
    { key: CHUNKING_COLUMN_KEYS.quantity, label: 'Qty', locked: true },
    { key: CHUNKING_COLUMN_KEYS.total, label: 'Total' }
  )
  // Stamped from the submitter, not asked on the form, so never a field.
  columns.push({ key: CHUNKING_COLUMN_KEYS.discipline, label: 'Discipline' })
  for (const field of visible) {
    if (field === nameField) continue
    columns.push({ key: field.key, label: field.label.trim() || field.key })
  }
  return columns
}
