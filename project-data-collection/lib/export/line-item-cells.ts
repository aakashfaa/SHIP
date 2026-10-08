/**
 * One line item's answers as export cells. Shared by the server Excel export
 * (report-data.ts's Line Items sheet) and Master View's own Excel/PDF export,
 * so the same answer reads the same in both files.
 *
 * Pure and dependency-light (relative imports only) so it runs in the
 * browser, in the export route and under `node --test` alike.
 */

import { parseCostAmount } from '../costs'
import { formatFieldValue, getFieldValue } from '../form-values'
import type { FormField, LineItem } from '../types'

export type ReportCellValue = string | number

export type ReportColumn = {
  header: string
  width: number
  /** Excel number format hint; text columns leave it unset. */
  format?: 'currency' | 'number'
  /** Multi-line text (a grouped Master View cell, long notes): Excel wraps
   *  it and the PDF keeps its line breaks. */
  wrap?: boolean
}

/** Line items whose cost text is present but unreadable get this in the ECC
 *  column instead of a number -- never a silent $0 (M-09). */
export const UNREADABLE_CELL = 'Unreadable'

export const ECC_COLUMN: ReportColumn = { header: 'ECC Amount', width: 16, format: 'currency' }

/** Money-valued built-in number fields. Everything else numeric is a plain
 *  number (D-16: "plain number fields stay plain numbers"). */
const CURRENCY_NUMBER_KEYS = new Set(['annual_cost_savings'])

export function columnWidth(field: Pick<FormField, 'inputType'>): number {
  switch (field.inputType) {
    case 'textarea':
      return 32
    case 'boolean':
      return 14
    case 'number':
    case 'currency':
      return 18
    case 'multiselect':
      return 26
    default:
      return 22
  }
}

/** A form field's export column: its current label, a width by input type,
 *  and a number format for the fields that hold numbers. */
export function fieldColumn(field: FormField): ReportColumn {
  const isMoneyNumber = field.inputType === 'number' && CURRENCY_NUMBER_KEYS.has(field.key)
  const isCustomCurrency = field.inputType === 'currency' && field.key !== 'estimated_first_cost'
  return {
    header: field.label.trim() || field.key,
    width: columnWidth(field),
    format:
      isMoneyNumber || isCustomCurrency ? 'currency' : field.inputType === 'number' ? 'number' : undefined,
  }
}

export function eccCell(item: LineItem): ReportCellValue {
  const parsed = parseCostAmount(item.estimatedFirstCost)
  if (!parsed.ok) return UNREADABLE_CELL
  if (parsed.amount === null) return ''
  // The stored ecc_amount and the live parse agree by construction (0019 +
  // check:parser); the stored value is what the totals use, so show it.
  return item.eccAmount || parsed.amount
}

export function fieldCell(item: LineItem, field: FormField): ReportCellValue {
  const value = getFieldValue(item, field)
  if (field.inputType === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    return Number.isFinite(n) ? n : formatFieldValue(field, value)
  }
  if (field.inputType === 'currency' && field.key !== 'estimated_first_cost') {
    // A custom currency field: a number when readable, the text as typed
    // when not (so nothing typed is lost from the deliverable).
    const parsed = parseCostAmount(typeof value === 'string' ? value : String(value ?? ''))
    if (parsed.ok && parsed.amount !== null) return parsed.amount
  }
  return formatFieldValue(field, value)
}
