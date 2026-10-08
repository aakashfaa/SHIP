import { ECC_COLUMN, eccCell, fieldCell, fieldColumn } from '../export/line-item-cells'
import type { ReportCellValue, ReportColumn } from '../export/line-item-cells'
import { formatFieldValue, getFieldValue, orderedVisibleFields } from '../form-values'
import type { FormField, LineItem } from '../types'
import type { ViewColumn } from '../view-settings'

/**
 * Every column the Master View table can show, in display order. The column
 * picker lists this catalog so a column can be hidden; Master View renders
 * visibleColumns(getMasterViewColumns(fields), settings.masterView.hiddenColumns).
 * Master View's own Excel/PDF export and the server workbook's Line Items
 * sheet (lib/export/report-data.ts) take the same columns, headers and
 * grouping.
 *
 * Layout follows the client's State House Master View (MASTER_LAYOUT below):
 *   #, Discipline, Organization, Name / Description, Strategy, Location,
 *   Impacts, Cost, ECC, Energy, Annual energy saving, the five Yes/No flags,
 *   Synergies, Notes, then every OTHER visible form field (custom ones and
 *   unclaimed built-ins) in form order, then Submitted By.
 *
 * Some columns GROUP several form fields into one cell, stacked one per line
 * (Name / Description, Strategy, Location, Impacts). Membership is by field
 * KEY, never by label. A group shows only its members that are visible on
 * the input form; a group with no visible member is dropped. Single-field
 * layout columns (Cost, Energy, ...) carry a fixed header; the other form
 * fields keep their form label. Nothing visible on the form is left out.
 *
 * Keys: a single-field column's key IS the form field's `key`, so hiding
 * "Funding source" survives a relabel. System and group columns use a
 * leading underscore (`_item_number`, `_name_description`, `_strategy`, ...),
 * which a form field key can never have (the DB requires ^[a-z][a-z0-9_]*$),
 * so nothing collides. A saved hidden-column key that is no longer in the
 * catalog (e.g. 'category', now part of `_strategy`) is simply ignored.
 *
 * Fields hidden (or removed) on the input form are not listed: there is
 * nothing to show for a question nobody is asked.
 */

export const MASTER_COLUMN_KEYS = {
  itemNumber: '_item_number',
  discipline: '_discipline',
  organization: '_organization',
  nameDescription: '_name_description',
  strategy: '_strategy',
  location: '_location',
  impacts: '_impacts',
  ecc: '_ecc',
  submittedBy: '_submitted_by',
} as const

type SystemKind = 'itemNumber' | 'discipline' | 'organization' | 'ecc' | 'submittedBy'

/** One form field inside a grouped cell; `prefix` labels its line ("Op"). */
export type MasterGroupLine = { field: FormField; prefix?: string }

export type MasterGroupColumnDef = ViewColumn & {
  kind: 'group'
  /** Visible members only, in layout order; the first is the sort key. */
  lines: MasterGroupLine[]
  /** Show the first line bold (Name / Description). */
  emphasizeFirst?: boolean
  /** Export column width. */
  width: number
}

export type MasterColumnDef = ViewColumn &
  ({ kind: 'field'; field: FormField } | MasterGroupColumnDef | { kind: SystemKind })

type LayoutEntry =
  | { type: 'system'; kind: SystemKind; key: string; label: string; locked?: boolean }
  | {
      type: 'group'
      key: string
      label: string
      members: { key: string; prefix?: string }[]
      locked?: boolean
      emphasizeFirst?: boolean
      width: number
    }
  | { type: 'field'; fieldKey: string; label: string }
  | { type: 'rest' }

/** The State House column layout. */
const MASTER_LAYOUT: readonly LayoutEntry[] = [
  { type: 'system', kind: 'itemNumber', key: MASTER_COLUMN_KEYS.itemNumber, label: '#', locked: true },
  { type: 'system', kind: 'discipline', key: MASTER_COLUMN_KEYS.discipline, label: 'Discipline' },
  { type: 'system', kind: 'organization', key: MASTER_COLUMN_KEYS.organization, label: 'Organization' },
  {
    type: 'group',
    key: MASTER_COLUMN_KEYS.nameDescription,
    label: 'Name / Description',
    members: [{ key: 'name' }, { key: 'short_description' }],
    locked: true,
    emphasizeFirst: true,
    width: 40,
  },
  {
    type: 'group',
    key: MASTER_COLUMN_KEYS.strategy,
    label: 'Strategy',
    members: [{ key: 'category' }, { key: 'timeline_priority' }],
    width: 22,
  },
  {
    type: 'group',
    key: MASTER_COLUMN_KEYS.location,
    label: 'Location',
    members: [{ key: 'building_area_impacted' }, { key: 'building_level_impacted' }],
    width: 22,
  },
  {
    type: 'group',
    key: MASTER_COLUMN_KEYS.impacts,
    label: 'Impacts',
    members: [
      { key: 'operational_impact', prefix: 'Op' },
      { key: 'benefit_to_users', prefix: 'User' },
      { key: 'benefit_to_public', prefix: 'Public' },
    ],
    width: 26,
  },
  { type: 'field', fieldKey: 'relative_first_cost', label: 'Cost' },
  { type: 'system', kind: 'ecc', key: MASTER_COLUMN_KEYS.ecc, label: 'ECC' },
  { type: 'field', fieldKey: 'relative_operational_energy_usage', label: 'Energy' },
  { type: 'field', fieldKey: 'annual_energy_savings', label: 'Annual energy saving' },
  { type: 'field', fieldKey: 'addressing_resiliency_sustainability', label: 'Resiliency / Sustainability' },
  { type: 'field', fieldKey: 'addressing_deferred_maintenance', label: 'Deferred Maintenance' },
  { type: 'field', fieldKey: 'code_life_safety_improvement', label: 'Code / Life-Safety' },
  { type: 'field', fieldKey: 'accessibility_improvement', label: 'Accessibility Improvement' },
  { type: 'field', fieldKey: 'historic_impact', label: 'Historic Impact' },
  { type: 'field', fieldKey: 'potential_synergies', label: 'Synergies' },
  { type: 'field', fieldKey: 'supporting_notes', label: 'Notes' },
  { type: 'rest' },
  { type: 'system', kind: 'submittedBy', key: MASTER_COLUMN_KEYS.submittedBy, label: 'Submitted By' },
]

/** Every field key the layout places by name (so 'rest' skips them). */
const CLAIMED_KEYS = new Set(
  MASTER_LAYOUT.flatMap((entry) =>
    entry.type === 'group' ? entry.members.map((m) => m.key) : entry.type === 'field' ? [entry.fieldKey] : []
  )
)

export function getMasterViewColumnDefs(fields: readonly FormField[]): MasterColumnDef[] {
  const visible = orderedVisibleFields(fields)
  const byKey = new Map(visible.map((f) => [f.key, f]))
  const defs: MasterColumnDef[] = []

  for (const entry of MASTER_LAYOUT) {
    switch (entry.type) {
      case 'system':
        defs.push(
          entry.locked
            ? { key: entry.key, label: entry.label, locked: true, kind: entry.kind }
            : { key: entry.key, label: entry.label, kind: entry.kind }
        )
        break
      case 'group': {
        const lines: MasterGroupLine[] = []
        for (const member of entry.members) {
          const field = byKey.get(member.key)
          if (field) lines.push(member.prefix ? { field, prefix: member.prefix } : { field })
        }
        if (lines.length === 0) break
        const def: MasterGroupColumnDef = {
          key: entry.key,
          label: entry.label,
          kind: 'group',
          lines,
          width: entry.width,
        }
        if (entry.locked) def.locked = true
        if (entry.emphasizeFirst) def.emphasizeFirst = true
        defs.push(def)
        break
      }
      case 'field': {
        const field = byKey.get(entry.fieldKey)
        if (field) defs.push({ key: field.key, label: entry.label, kind: 'field', field })
        break
      }
      case 'rest':
        for (const field of visible) {
          if (CLAIMED_KEYS.has(field.key)) continue
          defs.push({ key: field.key, label: field.label.trim() || field.key, kind: 'field', field })
        }
        break
    }
  }
  return defs
}

/** The catalog as plain ViewColumns, for the column picker. */
export function getMasterViewColumns(fields: readonly FormField[]): ViewColumn[] {
  return getMasterViewColumnDefs(fields).map(({ key, label, locked }) =>
    locked ? { key, label, locked } : { key, label }
  )
}

const MONEY_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/** One grouped line as text: "Op: High", or just the value. '' when unanswered. */
export function masterGroupLineText(line: MasterGroupLine, item: LineItem): string {
  const text = formatFieldValue(line.field, getFieldValue(item, line.field))
  if (text === '') return ''
  return line.prefix ? `${line.prefix}: ${text}` : text
}

/** What the on-screen cell shows (and what search matches). A grouped cell
 *  is its answered lines, newline separated. */
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
    case 'group':
      return def.lines
        .map((line) => masterGroupLineText(line, item))
        .filter((text) => text !== '')
        .join('\n')
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
    case 'group':
      return { header: def.label, width: def.width, wrap: true }
    case 'field': {
      const column: ReportColumn = { ...fieldColumn(def.field), header: def.label }
      // Long free text can carry line breaks of its own.
      if (def.field.inputType === 'textarea') column.wrap = true
      return column
    }
  }
}

/** The export cell: numbers stay numbers, a grouped cell is multi-line text,
 *  everything else is display text. */
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

/** Sort key: numbers for numeric columns (blank sorts last), text otherwise.
 *  A grouped column sorts by its first (primary) field. */
export function masterSortValue(def: MasterColumnDef, item: LineItem): string | number | null {
  const cell = def.kind === 'group' ? fieldCell(item, def.lines[0].field) : masterExportCell(def, item)
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
