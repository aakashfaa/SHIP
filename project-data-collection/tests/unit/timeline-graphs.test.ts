/**
 * Timeline graphs (migration 0032): the energy chart generalised to any
 * numeric line-item column -- built-in or a custom form field such as
 * "Annual carbon reduction (MTCO2e)" -- each with its own colour, and one
 * fiscal-year sheet per graph in the Excel export.
 *
 * lib/graphs.ts and report-data.ts have extensionless relative imports, so
 * they load through the same resolve hook ws3-export.test.ts uses.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'

import type { ChunkProject, FormField, LineItem } from '../../lib/types.ts'

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

type GraphsModule = typeof import('../../lib/graphs.ts')
type ReportModule = typeof import('../../lib/export/report-data.ts')
type ExcelModule = typeof import('../../lib/export/excel.ts')
let graphs: GraphsModule
let report: ReportModule
let excel: ExcelModule

before(async () => {
  graphs = await import('../../lib/graphs.ts')
  report = await import('../../lib/export/report-data.ts')
  excel = await import('../../lib/export/excel.ts')
})

/* ------------------------------------------------------------- fixtures -- */

function item(id: string, fields: Partial<LineItem>): LineItem {
  return {
    id,
    annualEnergySavings: null,
    annualCostSavings: null,
    eccAmount: null,
    estimatedFirstCost: '',
    customFields: {},
    ...fields,
  } as LineItem
}

function field(key: string, label: string, inputType: string, extra: Partial<FormField> = {}): FormField {
  return {
    id: `f-${key}`,
    projectId: 'p',
    key,
    label,
    helpText: '',
    inputType,
    storage: 'custom',
    groupLabel: '',
    sortOrder: 0,
    isRequired: false,
    isHidden: false,
    isBuiltin: false,
    config: {},
    options: [],
    createdAt: '',
    ...extra,
  } as FormField
}

/* ---------------------------------------------------------- lib/graphs -- */

describe('graph sources', () => {
  test('built-in numeric columns, then custom number/currency fields only', () => {
    const options = graphs.graphSourceOptions([
      field('annual_energy_savings', 'Annual energy saving', 'number', {
        storage: 'column',
        isBuiltin: true,
      }),
      field('annual_carbon_reduction', 'Annual carbon reduction (MTCO2e)', 'number', { sortOrder: 2 }),
      field('grant_amount', 'Grant', 'currency', { sortOrder: 1, isHidden: true }),
      field('notes_extra', 'Notes', 'text'),
    ])
    assert.deepEqual(
      options.map((o) => [o.key, o.kind]),
      [
        ['annual_energy_savings', 'builtin'],
        ['annual_cost_savings', 'builtin'],
        ['estimated_first_cost', 'builtin'],
        ['grant_amount', 'custom'],
        ['annual_carbon_reduction', 'custom'],
      ]
    )
    assert.equal(options.find((o) => o.key === 'grant_amount')?.hiddenFromForm, true)
  })

  test('a deleted or retyped custom field is no longer a known source', () => {
    const fields = [field('carbon', 'Carbon', 'text')]
    assert.equal(graphs.isKnownGraphSource('carbon', fields), false)
    assert.equal(graphs.isKnownGraphSource('annual_energy_savings', []), true)
    assert.equal(graphs.hasCustomNumericField(fields), false)
  })

  test('line-item values: built-ins, custom numbers, legacy strings, currency text', () => {
    const li = item('a', {
      annualEnergySavings: 12,
      eccAmount: null,
      estimatedFirstCost: '1.2m',
      customFields: { carbon: 3.5, legacy: '1,250', money: '$2k', junk: 'n/a' },
    })
    assert.equal(graphs.lineItemGraphValue(li, 'annual_energy_savings'), 12)
    assert.equal(graphs.lineItemGraphValue(li, 'annual_cost_savings'), 0)
    assert.equal(graphs.lineItemGraphValue(li, 'estimated_first_cost'), 1_200_000)
    assert.equal(graphs.lineItemGraphValue(li, 'carbon'), 3.5)
    assert.equal(graphs.lineItemGraphValue(li, 'legacy'), 1250)
    assert.equal(graphs.lineItemGraphValue(li, 'money'), 2000)
    assert.equal(graphs.lineItemGraphValue(li, 'junk'), 0)
    assert.equal(graphs.lineItemGraphValue(li, 'missing'), 0)
  })

  test('package totals sum value x quantity (blank = 1), exactly as energy always did', () => {
    const items = new Map([
      ['a', item('a', { annualEnergySavings: 10, customFields: { carbon: 2 } })],
      ['b', item('b', { annualEnergySavings: 5, customFields: { carbon: 1 } })],
    ])
    const chunks = [
      { id: 'P1', itemLinks: [{ lineItemId: 'a', quantity: '3' }, { lineItemId: 'b', quantity: '' }] },
      { id: 'P2', itemLinks: [{ lineItemId: 'b', quantity: '2' }, { lineItemId: 'gone', quantity: '1' }] },
    ] as unknown as ChunkProject[]
    assert.deepEqual(
      [...graphs.packageGraphValues(chunks, items, 'annual_energy_savings')],
      [['P1', 35], ['P2', 10]]
    )
    assert.deepEqual([...graphs.packageGraphValues(chunks, items, 'carbon')], [['P1', 7], ['P2', 2]])
  })
})

describe('graph colours', () => {
  test('palette starts green (energy) then blue (carbon)', () => {
    assert.equal(graphs.GRAPH_PALETTE[0].hex, graphs.DEFAULT_GRAPH_COLOR)
    assert.equal(graphs.GRAPH_PALETTE[1].name, 'Blue')
    assert.equal(graphs.nextGraphColor([{ color: '#059669' }]), '#2563eb')
  })

  test('hex validation and fill colour', () => {
    assert.equal(graphs.isHexColor('#2563EB'), true)
    assert.equal(graphs.isHexColor('blue'), false)
    assert.equal(graphs.isHexColor('#25e'), false)
    assert.equal(graphs.colorWithAlpha('#2563eb', 0.1), 'rgba(37,99,235,0.1)')
    assert.equal(graphs.colorWithAlpha('nope', 0.1), 'rgba(5,150,105,0.1)')
  })
})

/* --------------------------------------------------------------- export -- */

const PROJECT_ID = 'g-proj'
const CHUNK_ID = '00000000-0000-4000-8000-0000000000c9'

function graphRow(id: string, label: string, sourceKey: string, sort: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    project_id: PROJECT_ID,
    label,
    source_key: sourceKey,
    unit_label: '',
    baseline_annual: null,
    interaction_factor: 1,
    color: '#059669',
    sort_order: sort,
    ...extra,
  }
}

function tables(projectGraphs: unknown[]) {
  return {
    line_items: [
      {
        id: 'li-1',
        project_id: PROJECT_ID,
        item_number: 'A1',
        name: 'Boiler',
        estimated_first_cost: '$1,000,000',
        ecc_amount: 1_000_000,
        annual_energy_savings: 1000,
        annual_cost_savings: 0,
        custom_fields: { annual_carbon_reduction: 40 },
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    chunk_projects: [
      {
        id: CHUNK_ID,
        project_id: PROJECT_ID,
        chunk_number: 'P1',
        name: 'Package one',
        timeline_segments: [],
        timeline_start: 0,
        timeline_duration: 1,
        created_at: '2026-01-01T00:00:00Z',
        chunk_project_items: [{ chunk_project_id: CHUNK_ID, line_item_id: 'li-1', quantity: '2', position: 0 }],
      },
    ],
    chunk_phases: [
      {
        id: '00000000-0000-4000-8000-0000000000d1',
        chunk_project_id: CHUNK_ID,
        template_step_id: null,
        name: 'Construction',
        kind: 'construction',
        sort_order: 0,
        pct_of_tpc: 100,
        start_slot: 0,
        duration_slots: 24,
        duration_locked: false,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    project_cost_settings: {
      project_id: PROJECT_ID,
      tpc_factor: 1.33,
      base_year: 2026,
      escalation_mode: 'compound_annual',
      escalation_annual_percent: 4,
      escalation_step_years: 5,
      escalation_basis: 'midpoint',
      escalation_confidence_years: 5,
      default_phase_template_id: null,
    },
    escalation_rate_overrides: [],
    project_graphs: projectGraphs,
    project_timeline_settings: {
      project_id: PROJECT_ID,
      years: 5,
      interval_unit: 'yearly',
      zoom_level: 3,
      escalation_percent: 0,
      escalation_every_years: 5,
      start_calendar_year: 2026,
      fiscal_year_start_month: 7,
      fiscal_year_labels_by: 'end_year',
    },
    form_fields: [
      {
        id: 'ff-carbon',
        project_id: PROJECT_ID,
        key: 'annual_carbon_reduction',
        label: 'Annual carbon reduction (MTCO2e)',
        help_text: '',
        input_type: 'number',
        storage: 'custom',
        group_label: '',
        sort_order: 10,
        is_required: false,
        is_hidden: false,
        is_builtin: false,
        config: {},
        created_at: '2026-01-01T00:00:00Z',
        form_field_options: [],
      },
    ],
    scenarios: [],
  }
}

function stubClient(t: Record<string, unknown>) {
  function query(table: string) {
    const rows = t[table]
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      range: () => builder,
      maybeSingle: () =>
        Promise.resolve({ data: Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null), error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows ?? [], error: null }).then(resolve, reject),
    }
    return builder
  }
  return { from: query } as never
}

describe('Excel export: one fiscal-year sheet per graph', () => {
  const PROJECT = { id: PROJECT_ID, name: 'Graphs' } as never

  test('energy and carbon each get their own table, in graph order', async () => {
    const data = await report.buildProjectReportData(
      stubClient(
        tables([
          graphRow('g1', 'Energy reduction', 'annual_energy_savings', 0, {
            unit_label: 'kBtu/yr',
            baseline_annual: 10000,
            interaction_factor: 0.9,
          }),
          graphRow('g2', 'Carbon reduction', 'annual_carbon_reduction', 1, {
            unit_label: 'MTCO2e/yr',
            color: '#2563eb',
          }),
        ])
      ),
      PROJECT
    )

    assert.deepEqual(
      data.graphSummaries.map((g) => [g.label, g.unitLabel, g.sourceLabel, g.hasBaseline]),
      [
        ['Energy reduction', 'kBtu/yr', 'Annual energy saving', true],
        ['Carbon reduction', 'MTCO2e/yr', 'Annual carbon reduction (MTCO2e)', false],
      ]
    )
    // Construction Jan 2026 - Dec 2027 (in service by FY28): 1000 x qty 2 x 0.9.
    const energyLast = data.graphSummaries[0].rows.at(-1)
    assert.equal(energyLast?.cumulativeSavings, 1800)
    assert.equal(energyLast?.remainingConsumption, 10000 - 1800)
    assert.equal(data.graphSummaries[0].rows[0].cumulativeSavings, 0)
    // Carbon from the custom field: 40 x qty 2, no baseline.
    const carbonLast = data.graphSummaries[1].rows.at(-1)
    assert.equal(carbonLast?.cumulativeSavings, 80)
    assert.equal(carbonLast?.remainingConsumption, null)

    const workbook = excel.buildExcelWorkbook(data)
    const names = workbook.worksheets.map((s) => s.name)
    assert.deepEqual(names.slice(-2), ['Energy reduction', 'Carbon reduction'])
    assert.ok(!names.includes('Energy Summary'))
    const carbonHeader = workbook.getWorksheet('Carbon reduction')!.getRow(1).values as unknown[]
    assert.ok(carbonHeader.includes('Cumulative Carbon reduction (MTCO2e/yr)'))
    assert.ok(carbonHeader.includes('Remaining from Baseline (no baseline set)'))
  })

  test('no graphs, no graph sheets; the interaction factor never reaches the workbook', async () => {
    const data = await report.buildProjectReportData(stubClient(tables([])), PROJECT)
    assert.deepEqual(data.graphSummaries, [])
    assert.ok(!JSON.stringify(data).includes('interaction'))
  })

  test('sheet names are legal, unique and capped at 31 characters', () => {
    const used = new Set(['packages'])
    assert.equal(excel.graphSheetName('Packages', used), 'Packages (2)')
    assert.equal(excel.graphSheetName('CO2 [net]: a/b', used), 'CO2 net a b')
    const long = excel.graphSheetName('x'.repeat(40), used)
    assert.equal(long.length, 31)
    assert.equal(excel.graphSheetName('x'.repeat(40), used), `${'x'.repeat(27)} (2)`)
    assert.equal(excel.graphSheetName('   ', used), 'Graph')
  })
})
