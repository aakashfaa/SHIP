/**
 * Master View: the column catalog (keys, locks, ECC placement), row sorting,
 * edit-mode validation/patch building, and the plain-table Excel export.
 *
 * Same extensionless-import resolve hook as ws3-export.test.ts.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'

type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown
) => unknown
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: { resolve: ResolveHook }) => void
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

type MasterModule = typeof import('../../lib/view-columns/master.ts')
type CellEditModule = typeof import('../../components/project-workspace/master-view/cell-edit.ts')
type ExcelModule = typeof import('../../lib/export/excel.ts')
type ViewSettingsModule = typeof import('../../lib/view-settings.ts')

let master: MasterModule
let cellEdit: CellEditModule
let excel: ExcelModule
let viewSettings: ViewSettingsModule

before(async () => {
  master = await import('../../lib/view-columns/master.ts')
  cellEdit = await import('../../components/project-workspace/master-view/cell-edit.ts')
  excel = await import('../../lib/export/excel.ts')
  viewSettings = await import('../../lib/view-settings.ts')
})

import type { FormField, LineItem } from '../../lib/types.ts'

function field(key: string, inputType: FormField['inputType'], extra: Partial<FormField> = {}): FormField {
  return {
    id: `f-${key}`,
    projectId: 'p',
    key,
    label: key.replace(/_/g, ' '),
    helpText: '',
    inputType,
    storage: 'column',
    groupLabel: '',
    sortOrder: 0,
    isRequired: false,
    isHidden: false,
    isBuiltin: true,
    config: {},
    options: [],
    createdAt: '',
    ...extra,
  }
}

const FIELDS: FormField[] = [
  field('category', 'select', { sortOrder: 2, options: [{ value: 'A', label: 'A', sortOrder: 0, isArchived: false } as never] }),
  field('name', 'text', { sortOrder: 1, isRequired: true }),
  field('estimated_first_cost', 'currency', { sortOrder: 3 }),
  field('annual_energy_savings', 'number', { sortOrder: 4 }),
  field('historic_impact', 'boolean', { sortOrder: 5 }),
  field('secret', 'text', { sortOrder: 6, isHidden: true }),
  field('discipline', 'text', { sortOrder: 7, storage: 'custom', isBuiltin: false, label: 'Discipline' }),
]

function item(id: string, itemNumber: string, extra: Partial<LineItem> = {}): LineItem {
  return {
    id,
    projectId: 'p',
    userEmail: 'c@x.com',
    consultantType: 'Mechanical',
    companyName: 'Co',
    discipline: 'Mechanical',
    itemNumber,
    name: `Item ${itemNumber}`,
    estimatedFirstCost: '',
    eccAmount: null,
    annualEnergySavings: null,
    historicImpact: 'No',
    customFields: {},
    ...extra,
  } as LineItem
}

describe('master view column catalog', () => {
  test('stable keys, identity columns locked, hidden form fields left out, ECC after cost', () => {
    const cols = master.getMasterViewColumns(FIELDS)
    assert.deepEqual(
      cols.map((c) => c.key),
      [
        '_item_number',
        'name',
        '_discipline',
        '_organization',
        'category',
        'estimated_first_cost',
        '_ecc',
        'annual_energy_savings',
        'historic_impact',
        'discipline',
        '_submitted_by',
      ]
    )
    assert.deepEqual(
      cols.filter((c) => c.locked).map((c) => c.key),
      ['_item_number', 'name']
    )
  })

  test('locked columns survive being hidden', () => {
    const cols = master.getMasterViewColumns(FIELDS)
    const shown = viewSettings.visibleColumns(cols, ['_item_number', 'name', 'category'])
    assert.ok(shown.some((c) => c.key === '_item_number'))
    assert.ok(shown.some((c) => c.key === 'name'))
    assert.ok(!shown.some((c) => c.key === 'category'))
  })

  test('sorting: item numbers naturally, numbers numerically, blanks last', () => {
    const defs = master.getMasterViewColumnDefs(FIELDS)
    const items = [
      item('1', 'M10', { annualEnergySavings: 5 }),
      item('2', 'M2', { annualEnergySavings: null }),
      item('3', 'M3', { annualEnergySavings: 40 }),
    ]
    assert.deepEqual(
      master.sortMasterRows(items, defs, { key: '_item_number', direction: 'asc' }).map((i) => i.itemNumber),
      ['M2', 'M3', 'M10']
    )
    assert.deepEqual(
      master
        .sortMasterRows(items, defs, { key: 'annual_energy_savings', direction: 'desc' })
        .map((i) => i.itemNumber),
      ['M3', 'M10', 'M2']
    )
  })

  test('export cells keep numbers as numbers', () => {
    const defs = master.getMasterViewColumnDefs(FIELDS)
    const row = item('1', 'M1', { estimatedFirstCost: '1.2m', eccAmount: 1200000, annualEnergySavings: 7 })
    const byKey = Object.fromEntries(defs.map((d) => [d.key, master.masterExportCell(d, row)]))
    assert.equal(byKey._ecc, 1200000)
    assert.equal(byKey.annual_energy_savings, 7)
    assert.equal(byKey.historic_impact, 'No')
  })
})

describe('master view edit mode', () => {
  test('validation: required, bad number, bad cost', () => {
    const errors = cellEdit.validateRowDraft(FIELDS, {
      name: '  ',
      annual_energy_savings: '12abc',
      estimated_first_cost: '-5',
    })
    assert.deepEqual(Object.keys(errors).sort(), ['annual_energy_savings', 'estimated_first_cost', 'name'])
  })

  test('patch sends only changed fields, in their stored shapes', () => {
    const row = item('1', 'M1', { customFields: { other: 'keep' } })
    const draft = {
      annual_energy_savings: '1,200',
      historic_impact: true,
      category: '',
      discipline: 'custom answer',
    }
    assert.deepEqual(cellEdit.validateRowDraft(FIELDS, draft), {})
    assert.deepEqual(cellEdit.buildRowPatch(row, FIELDS, draft), {
      annualEnergySavings: 1200,
      historicImpact: 'Yes',
      category: null,
      customFields: { other: 'keep', discipline: 'custom answer' },
    })
  })

  test('blank number is null, not 0', () => {
    const patch = cellEdit.buildRowPatch(item('1', 'M1'), FIELDS, { annual_energy_savings: '' })
    assert.equal(patch.annualEnergySavings, null)
  })
})

describe('plain table workbook', () => {
  test('one sheet, header then rows, values flat', () => {
    const wb = excel.buildPlainTableWorkbook({
      title: 'P - Master View',
      sheetName: 'Master View',
      columns: [
        { header: 'Item #', width: 10 },
        { header: 'ECC', width: 16, format: 'currency' },
      ],
      rows: [
        ['M1', 1200],
        ['M2', ''],
      ],
    })
    assert.equal(wb.worksheets.length, 1)
    const sheet = wb.worksheets[0]
    assert.equal(sheet.name, 'Master View')
    assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), ['Item #', 'ECC'])
    assert.equal(sheet.getRow(2).getCell(2).value, 1200)
    assert.equal(sheet.getRow(2).getCell(2).numFmt, '$#,##0')
    assert.equal(sheet.rowCount, 3)
  })
})
