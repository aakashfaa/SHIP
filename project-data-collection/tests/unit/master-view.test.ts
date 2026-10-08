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

/** The default form (0012 default_form_fields, 0026 shown/hidden set):
 *  24 built-ins, 22 shown. */
const DEFAULT_FORM: FormField[] = (
  [
    ['name', 'Item name', 'text', 10],
    ['short_description', 'Short description', 'textarea', 20],
    ['category', 'Category', 'select', 30],
    ['timeline_priority', 'Timeline priority', 'select', 40],
    ['building_area_impacted', 'Building area', 'select', 50],
    ['building_level_impacted', 'Building level', 'select', 60],
    ['operational_impact', 'Operational impact', 'select', 70],
    ['benefit_to_users', 'Benefit to users', 'select', 80],
    ['benefit_to_public', 'Benefit to public', 'select', 90],
    ['relative_first_cost', 'Relative first cost', 'select', 100],
    ['estimated_first_cost', 'Estimated first cost', 'currency', 110],
    ['relative_operation_cost_impact', 'Operating cost impact', 'select', 120],
    ['relative_operational_energy_usage', 'Energy / emissions', 'select', 130],
    ['electrification_eo594', 'Electrification', 'select', 140],
    ['annual_energy_savings', 'Annual energy saving', 'number', 150],
    ['annual_cost_savings', 'Annual utility cost saving', 'number', 160],
    ['energy_notes', 'Energy notes', 'textarea', 170],
    ['addressing_resiliency_sustainability', 'Addresses resiliency / sustainability', 'boolean', 180],
    ['addressing_deferred_maintenance', 'Addresses deferred maintenance', 'boolean', 190],
    ['code_life_safety_improvement', 'Code / life-safety improvement', 'boolean', 200],
    ['accessibility_improvement', 'Accessibility improvement', 'boolean', 210],
    ['historic_impact', 'Historic impact', 'boolean', 220],
    ['potential_synergies', 'Potential synergies', 'multiselect', 230],
    ['supporting_notes', 'Supporting notes', 'textarea', 240],
  ] as const
).map(([key, label, inputType, sortOrder]) =>
  field(key, inputType, {
    label,
    sortOrder,
    isRequired: key === 'name',
    isHidden: key === 'annual_cost_savings' || key === 'energy_notes',
  })
)

function withFields(
  base: FormField[],
  change: Record<string, Partial<FormField>>,
  extra: FormField[] = []
): FormField[] {
  return [...base.map((f) => (change[f.key] ? { ...f, ...change[f.key] } : f)), ...extra]
}

const DEFAULT_LAYOUT = [
  ['_item_number', '#'],
  ['_discipline', 'Discipline'],
  ['_organization', 'Organization'],
  ['_name_description', 'Name / Description'],
  ['_strategy', 'Strategy'],
  ['_location', 'Location'],
  ['_impacts', 'Impacts'],
  ['relative_first_cost', 'Cost'],
  ['_ecc', 'ECC'],
  ['relative_operational_energy_usage', 'Energy'],
  ['annual_energy_savings', 'Annual energy saving'],
  ['addressing_resiliency_sustainability', 'Resiliency / Sustainability'],
  ['addressing_deferred_maintenance', 'Deferred Maintenance'],
  ['code_life_safety_improvement', 'Code / Life-Safety'],
  ['accessibility_improvement', 'Accessibility Improvement'],
  ['historic_impact', 'Historic Impact'],
  ['potential_synergies', 'Synergies'],
  ['supporting_notes', 'Notes'],
  // Visible but not placed by the layout: form label, form order.
  ['estimated_first_cost', 'Estimated first cost'],
  ['relative_operation_cost_impact', 'Operating cost impact'],
  ['electrification_eo594', 'Electrification'],
  ['_submitted_by', 'Submitted By'],
]

describe('master view column catalog (State House layout)', () => {
  test('default 22-field form: order, labels and stable keys', () => {
    const cols = master.getMasterViewColumns(DEFAULT_FORM)
    assert.deepEqual(
      cols.map((c) => [c.key, c.label]),
      DEFAULT_LAYOUT
    )
    assert.deepEqual(
      cols.filter((c) => c.locked).map((c) => c.key),
      ['_item_number', '_name_description']
    )
    assert.equal(new Set(cols.map((c) => c.key)).size, cols.length)
  })

  test('groups take their members by key, in layout order, whatever the labels or form order', () => {
    const fields = withFields(DEFAULT_FORM, {
      benefit_to_public: { label: 'Public good', sortOrder: 1 },
      operational_impact: { label: 'Ops', sortOrder: 999 },
    })
    const defs = master.getMasterViewColumnDefs(fields)
    const impacts = defs.find((d) => d.key === '_impacts')
    assert.ok(impacts && impacts.kind === 'group')
    assert.deepEqual(
      impacts.lines.map((l) => [l.field.key, l.prefix]),
      [
        ['operational_impact', 'Op'],
        ['benefit_to_users', 'User'],
        ['benefit_to_public', 'Public'],
      ]
    )
    const nameDesc = defs.find((d) => d.key === '_name_description')
    assert.ok(nameDesc && nameDesc.kind === 'group')
    assert.deepEqual(
      nameDesc.lines.map((l) => [l.field.key, l.prefix]),
      [
        ['name', undefined],
        ['short_description', undefined],
      ]
    )
    assert.equal(nameDesc.emphasizeFirst, true)
  })

  test('a group shows only visible members, and drops out when none are', () => {
    const fields = withFields(DEFAULT_FORM, {
      timeline_priority: { isHidden: true },
      building_area_impacted: { isHidden: true },
      // Removed = hidden + marker; just as absent.
      building_level_impacted: { isHidden: true, config: { removed: true } },
    })
    const defs = master.getMasterViewColumnDefs(fields)
    const strategy = defs.find((d) => d.key === '_strategy')
    assert.ok(strategy && strategy.kind === 'group')
    assert.deepEqual(
      strategy.lines.map((l) => l.field.key),
      ['category']
    )
    assert.ok(!defs.some((d) => d.key === '_location'))
  })

  test('single-field layout columns drop out when hidden; ECC stays', () => {
    const fields = withFields(DEFAULT_FORM, {
      relative_first_cost: { isHidden: true },
      historic_impact: { isHidden: true },
    })
    const keys = master.getMasterViewColumns(fields).map((c) => c.key)
    assert.ok(!keys.includes('relative_first_cost'))
    assert.ok(!keys.includes('historic_impact'))
    assert.ok(keys.includes('_ecc'))
  })

  test('nothing visible on the form vanishes: custom fields and re-shown built-ins go before Submitted By', () => {
    const fields = withFields(
      DEFAULT_FORM,
      { energy_notes: { isHidden: false } },
      [
        field('funding_source', 'text', { label: 'Funding source', sortOrder: 5, storage: 'custom', isBuiltin: false }),
        field('discipline', 'text', { label: 'Discipline', sortOrder: 300, storage: 'custom', isBuiltin: false }),
      ]
    )
    const cols = master.getMasterViewColumns(fields)
    const keys = cols.map((c) => c.key)
    assert.deepEqual(keys.slice(keys.indexOf('supporting_notes') + 1), [
      'funding_source',
      'estimated_first_cost',
      'relative_operation_cost_impact',
      'electrification_eo594',
      'energy_notes',
      'discipline',
      '_submitted_by',
    ])
    // Every visible form field is shown somewhere.
    const shown = new Set(
      master.getMasterViewColumnDefs(fields).flatMap((d) =>
        d.kind === 'field' ? [d.field.key] : d.kind === 'group' ? d.lines.map((l) => l.field.key) : []
      )
    )
    for (const f of fields) assert.equal(shown.has(f.key), !f.isHidden, f.key)
    // A custom field labelled "Discipline" does not collide with the system column.
    assert.equal(new Set(keys).size, keys.length)
  })

  test('ECC can be hidden and shown again; locked columns survive being hidden', () => {
    const cols = master.getMasterViewColumns(DEFAULT_FORM)
    assert.equal(cols.find((c) => c.key === '_ecc')?.locked, undefined)
    const shown = viewSettings.visibleColumns(cols, ['_item_number', '_name_description', '_ecc', '_strategy'])
    const keys = shown.map((c) => c.key)
    assert.ok(keys.includes('_item_number'))
    assert.ok(keys.includes('_name_description'))
    assert.ok(!keys.includes('_ecc'))
    assert.ok(!keys.includes('_strategy'))
    assert.ok(viewSettings.visibleColumns(cols, []).some((c) => c.key === '_ecc'))
  })

  test('saved preferences with old or unknown keys are harmless', () => {
    const settings = viewSettings.normalizeViewSettings({
      masterView: { hiddenColumns: ['category', 'name', 'no_such_field', 'historic_impact'] },
    })
    const cols = master.getMasterViewColumns(DEFAULT_FORM)
    const keys = viewSettings.visibleColumns(cols, settings.masterView.hiddenColumns).map((c) => c.key)
    // Only the single-field column still in the catalog is hidden.
    assert.deepEqual(
      keys,
      cols.map((c) => c.key).filter((k) => k !== 'historic_impact')
    )
  })
})

const LAYOUT_FIELDS = withFields(DEFAULT_FORM, {
  operational_impact: { options: [{ value: 'H', label: 'High', sortOrder: 0, isArchived: false } as never] },
})

describe('master view grouped cells', () => {
  test('cell text stacks the answered lines, with Op/User/Public prefixes', () => {
    const defs = master.getMasterViewColumnDefs(LAYOUT_FIELDS)
    const byKey = new Map(defs.map((d) => [d.key, d]))
    const row = item('1', 'M1', {
      name: 'Roof',
      shortDescription: 'Replace membrane',
      category: 'Envelope',
      operationalImpact: 'H',
      benefitToPublic: 'Low',
      buildingAreaImpacted: '',
      buildingLevelImpacted: '',
    } as unknown as Partial<LineItem>)
    assert.equal(master.masterCellText(byKey.get('_name_description')!, row), 'Roof\nReplace membrane')
    assert.equal(master.masterCellText(byKey.get('_strategy')!, row), 'Envelope')
    assert.equal(master.masterCellText(byKey.get('_impacts')!, row), 'Op: High\nPublic: Low')
    assert.equal(master.masterCellText(byKey.get('_location')!, row), '')
    // Export: the same multi-line text, in a wrapped column.
    assert.equal(master.masterExportCell(byKey.get('_impacts')!, row), 'Op: High\nPublic: Low')
    assert.equal(master.masterExportColumn(byKey.get('_impacts')!).wrap, true)
    assert.equal(master.masterExportColumn(byKey.get('_impacts')!).header, 'Impacts')
  })

  test('a grouped column sorts by its first field', () => {
    const defs = master.getMasterViewColumnDefs(LAYOUT_FIELDS)
    const items = [
      item('1', 'M1', { category: 'B', timelinePriority: 'A' } as Partial<LineItem>),
      item('2', 'M2', { category: 'A', timelinePriority: 'Z' } as Partial<LineItem>),
      item('3', 'M3', { category: '', timelinePriority: 'A' } as Partial<LineItem>),
    ]
    assert.deepEqual(
      master.sortMasterRows(items, defs, { key: '_strategy', direction: 'asc' }).map((i) => i.itemNumber),
      ['M2', 'M1', 'M3']
    )
    assert.deepEqual(
      master.sortMasterRows(items, defs, { key: '_strategy', direction: 'desc' }).map((i) => i.itemNumber),
      ['M1', 'M2', 'M3']
    )
  })
})

describe('master view sorting and export cells', () => {
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

  test('export cells keep numbers as numbers; headers follow the layout', () => {
    const defs = master.getMasterViewColumnDefs(FIELDS)
    const row = item('1', 'M1', { estimatedFirstCost: '1.2m', eccAmount: 1200000, annualEnergySavings: 7 })
    const byKey = Object.fromEntries(defs.map((d) => [d.key, master.masterExportCell(d, row)]))
    assert.equal(byKey._ecc, 1200000)
    assert.equal(byKey.annual_energy_savings, 7)
    assert.equal(byKey.historic_impact, 'No')
    const columns = Object.fromEntries(defs.map((d) => [d.key, master.masterExportColumn(d)]))
    assert.equal(columns._ecc.header, 'ECC')
    assert.equal(columns._ecc.format, 'currency')
    assert.equal(columns.annual_energy_savings.header, 'Annual energy saving')
    assert.equal(columns.annual_energy_savings.format, 'number')
    assert.equal(columns.historic_impact.header, 'Historic Impact')
  })

  test('the default form exports with exactly the on-screen headers', () => {
    const defs = master.getMasterViewColumnDefs(DEFAULT_FORM)
    assert.deepEqual(
      defs.map((d) => master.masterExportColumn(d).header),
      DEFAULT_LAYOUT.map(([, label]) => label)
    )
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

  test('a grouped column is one wrapped, multi-line text cell', () => {
    const wb = excel.buildPlainTableWorkbook({
      title: 'P - Master View',
      sheetName: 'Master View',
      columns: [
        { header: '#', width: 10 },
        { header: 'Impacts', width: 26, wrap: true },
      ],
      rows: [['M1', 'Op: High\nUser: Low']],
    })
    const cell = wb.worksheets[0].getRow(2).getCell(2)
    assert.equal(cell.value, 'Op: High\nUser: Low')
    assert.equal(cell.alignment?.wrapText, true)
    assert.equal(wb.worksheets[0].getRow(2).getCell(1).alignment?.wrapText, undefined)
  })
})
