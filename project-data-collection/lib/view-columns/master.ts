import { ECC_COLUMN, eccCell, fieldCell, fieldColumn } from '../export/line-item-cells'
import type { ReportCellValue, ReportColumn } from '../export/line-item-cells'
import { formatFieldValue, getFieldValue, orderedVisibleFields } from '../form-values'
import type { FormField, LineItem } from '../types'
import type { ViewColumn } from '../view-settings'

/**
 * Every column the Master View table can show, in display order. Settings
 * lists this catalog so a project admin can hide columns; Master View renders
 * visibleColumns(getMasterViewColumns(fields), settings.masterView.hiddenColumns).
 *
 * Order: item #, name, discipline, organization, then every visible form
 * field (custom ones included) in form order with ECC right after the
 * estimated-cost field, then submitted-by. Same shape as the server export's
 * Line Items sheet (lib/export/report-data.ts).
 *
 * Keys: a form field column's key IS the form field's `key`, so hiding
 * "Funding source" survives a relabel. The system columns use a leading
 * underscore, which a form field key can never have (the DB requires
 * ^[a-z][a-z0-9_]*$), so a custom field labelled "Discipline" can't collide.
 *
 * Fields hidden on the input form itself are not listed: there is nothing to
 * show for a question nobody is asked.
 */

export const MASTER_COLUMN_KEYS = {
  itemNumber: '_item_number',
  discipline: '_discipline',
  organization: '_organization',
  ecc: '_ecc',
  submittedBy: '_submitted_by',
  /** The built-in name field's own key. */
  name: 'name',
} as const

export type MasterColumnDef = ViewColumn &
  (
    | { kind: 'field'; field: FormField }
    | { kind: 'itemNumber' | 'discipline' | 'organization' | 'ecc' | 'submittedBy' }
  )

export function getMasterViewColumnDefs(fields: readonly FormField[]): MasterColumnDef[] {
  const visible = orderedVisibleFields(fields)
  const nameField = visible.find((f) => f.storage === 'column' && f.key === MASTER_COLUMN_KEYS.name)

  const defs: MasterColumnDef[] = [
    { key: MASTER_COLUMN_KEYS.itemNumber, label: 'Item #', locked: true, kind: 'itemNumber' },
  ]
  if (nameField) {
    defs.push({
      key: nameField.key,
      label: nameField.label.trim() || 'Name',
      locked: true,
      kind: 'field',
      field: nameField,
    })
  }
  defs.push(
    { key: MASTER_COLUMN_KEYS.discipline, label: 'Discipline', kind: 'discipline' },
    { key: MASTER_COLUMN_KEYS.organization, label: 'Organization', kind: 'organization' }
  )

  let eccPlaced = false
  for (const field of visible) {
    if (field === nameField) continue
    defs.push({ key: field.key, label: field.label.trim() || field.key, kind: 'field', field })
    if (field.key === 'estimated_first_cost') {
      defs.push({ key: MASTER_COLUMN_KEYS.ecc, label: 'ECC', kind: 'ecc' })
      eccPlaced = true
    }
  }
  if (!eccPlaced) defs.push({ key: MASTER_COLUMN_KEYS.ecc, label: 'ECC', kind: 'ecc' })

  defs.push({ key: MASTER_COLUMN_KEYS.submittedBy, label: 'Submitted by', kind: 'submittedBy' })
  return defs
}

/** The catalog as plain ViewColumns, for the Settings column picker. */
export function getMasterViewColumns(fields: FormField[]): ViewColumn[] {
  return getMasterViewColumnDefs(fields).map(({ key, label, locked }) =>
    locked ? { key, label, locked } : { key, label }
  )
}

const MONEY_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/** What the on-screen cell shows. */
export function masterCellText(def: MasterColumnDef, item: LineItem): string {
  switch (def.kind) {
    case 'itemNumber':
      return item.itemNumber
    case 'discipline':
      return item.discipline
    case 'organization':
      return item.companyName
    case 'submittedBy':
      return item.userEmail
    case 'ecc': {
      const cell = eccCell(item)
      return typeof cell === 'number' ? MONEY_FORMAT.format(cell) : cell
    }
    case 'field':
      return formatFieldValue(def.field, getFieldValue(item, def.field))
  }
}

/** The export column (header, width, number format) for one catalog column. */
export function masterExportColumn(def: MasterColumnDef): ReportColumn {
  switch (def.kind) {
    case 'itemNumber':
      return { header: def.label, width: 10 }
    case 'discipline':
      return { header: def.label, width: 18 }
    case 'organization':
      return { header: def.label, width: 20 }
    case 'submittedBy':
      return { header: def.label, width: 28 }
    case 'ecc':
      return { ...ECC_COLUMN, header: def.label }
    case 'field':
      return { ...fieldColumn(def.field), header: def.label }
  }
}

/** The export cell: numbers stay numbers, everything else is display text. */
export function masterExportCell(def: MasterColumnDef, item: LineItem): ReportCellValue {
  switch (def.kind) {
    case 'ecc':
      return eccCell(item)
    case 'field':
      return fieldCell(item, def.field)
    default:
      return masterCellText(def, item)
  }
}

/** Sort key: numbers for numeric columns (blank sorts last), text otherwise. */
export function masterSortValue(def: MasterColumnDef, item: LineItem): string | number | null {
  const cell = masterExportCell(def, item)
  if (typeof cell === 'number') return cell
  return cell === '' ? null : cell.toLowerCase()
}

/** "M2" before "M10": prefix alphabetically, then the number numerically. */
export function compareItemNumbers(a: string, b: string): number {
  const aMatch = a.match(/^([A-Z]+)(\d+)$/i)
  const bMatch = b.match(/^([A-Z]+)(\d+)$/i)
  if (!aMatch || !bMatch) return a.localeCompare(b)
  if (aMatch[1] !== bMatch[1]) return aMatch[1].localeCompare(bMatch[1])
  return Number(aMatch[2]) - Number(bMatch[2])
}

export type MasterSort = { key: string; direction: 'asc' | 'desc' }

/** Rows in the order the table (and its export) shows them. Blanks always
 *  sort last, whichever the direction. */
export function sortMasterRows(
  items: readonly LineItem[],
  defs: readonly MasterColumnDef[],
  sort: MasterSort
): LineItem[] {
  const def = defs.find((d) => d.key === sort.key) ?? defs[0]
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    if (!def || def.kind === 'itemNumber') return sign * compareItemNumbers(a.itemNumber, b.itemNumber)
    const av = masterSortValue(def, a)
    const bv = masterSortValue(def, b)
    if (av === null || bv === null) {
      if (av === bv) return compareItemNumbers(a.itemNumber, b.itemNumber)
      return av === null ? 1 : -1
    }
    const result =
      typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return result === 0 ? compareItemNumbers(a.itemNumber, b.itemNumber) : sign * result
  })
}
