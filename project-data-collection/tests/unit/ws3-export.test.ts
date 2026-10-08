/**
 * WS-3 unit tests for the Excel export's data layer:
 *   M-24  the export prices the active what-if through the same overlay as
 *         the screen, and a scenario it can't read is a 404, not the baseline
 *   M-25  no "now" base year: missing settings refuse the export
 *   M-28  Line Items columns come from the project's visible form fields
 *   M-09  unreadable costs are flagged, never a silent $0
 *
 * lib/export/report-data.ts imports its siblings without a `.ts` extension
 * (Next/bundler resolution), which Node's native type stripping won't
 * resolve on its own -- so a tiny synchronous resolve hook retries
 * extensionless relative specifiers with `.ts` before the module is
 * imported dynamically. Nothing else about the module is faked: the real
 * mappers, engine and workbook builder run over a stub Supabase client that
 * just returns rows.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'

// registerHooks exists at runtime (Node >= 22.15) but not in the @types/node
// 20 typings this repo pins, so it is typed locally rather than bumping them.
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

type ReportModule = typeof import('../../lib/export/report-data.ts')
type ExcelModule = typeof import('../../lib/export/excel.ts')
type EngineModule = typeof import('../../lib/cost-model.ts')

let report: ReportModule
let excel: ExcelModule
let engine: EngineModule

before(async () => {
  report = await import('../../lib/export/report-data.ts')
  excel = await import('../../lib/export/excel.ts')
  engine = await import('../../lib/cost-model.ts')
})

/* ------------------------------------------------------------- fixtures -- */

const PROJECT_ID = 'ws3-test'
const SCENARIO_ID = '11111111-2222-4333-8444-555555555555'
const CHUNK_ID = 'chunk-1'
const PHASE_ID = 'phase-1'

function lineItemRow(id: string, itemNumber: string, cost: string, ecc: number | null, extra = {}) {
  return {
    id,
    project_id: PROJECT_ID,
    user_email: 'a@example.com',
    consultant_type: 'Architecture',
    company_name: 'FAA',
    discipline: 'Architecture',
    item_number: itemNumber,
    name: `Item ${itemNumber}`,
    short_description: '',
    category: 'END OF LIFE',
    timeline_priority: '0_PRIORITY *',
    building_area_impacted: 'WHOLE BUILDING',
    building_level_impacted: 'WHOLE BUILDING',
    operational_impact: 'NONE',
    benefit_to_users: 'NONE',
    benefit_to_public: 'NONE',
    relative_first_cost: '$LOW',
    estimated_first_cost: cost,
    relative_operation_cost_impact: 'MINIMAL IMPACT',
    relative_operational_energy_usage: 'MINIMAL IMPACT',
    electrification_eo594: 'NONE',
    addressing_resiliency_sustainability: 'No',
    addressing_deferred_maintenance: 'Yes',
    code_life_safety_improvement: 'No',
    accessibility_improvement: 'No',
    historic_impact: 'No',
    potential_synergies: [],
    supporting_notes: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
    ecc_amount: ecc,
    annual_energy_savings: null,
    annual_cost_savings: 1500,
    energy_notes: '',
    custom_fields: { warranty_years: 7, secret_code: 'x' },
    ...extra,
  }
}

function formFieldRow(
  key: string,
  label: string,
  inputType: string,
  sortOrder: number,
  extra: Record<string, unknown> = {}
) {
  return {
    id: `ff-${key}`,
    project_id: PROJECT_ID,
    key,
    label,
    help_text: '',
    input_type: inputType,
    storage: 'column',
    group_label: '',
    sort_order: sortOrder,
    is_required: false,
    is_hidden: false,
    is_builtin: true,
    config: {},
    form_field_options: [],
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

type Tables = Record<string, unknown>

function baseTables(): Tables {
  return {
    line_items: [
      lineItemRow('li-1', 'A1', '$1,000,000', 1_000_000),
      lineItemRow('li-2', 'A2', 'TBD', null),
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
        chunk_project_items: [
          { chunk_project_id: CHUNK_ID, line_item_id: 'li-1', quantity: '', position: 0 },
          { chunk_project_id: CHUNK_ID, line_item_id: 'li-2', quantity: 'lots', position: 1 },
        ],
      },
    ],
    chunk_phases: [
      {
        id: PHASE_ID,
        chunk_project_id: CHUNK_ID,
        template_step_id: null,
        name: 'Construction',
        kind: 'construction',
        sort_order: 0,
        pct_of_tpc: 1,
        start_slot: 0,
        duration_slots: 1,
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
    project_energy_settings: {
      project_id: PROJECT_ID,
      unit_label: 'kBtu/yr',
      baseline_annual: null,
      interaction_factor: 1,
    },
    project_timeline_settings: {
      project_id: PROJECT_ID,
      years: 10,
      interval_unit: 'yearly',
      zoom_level: 3,
      escalation_percent: 0,
      escalation_every_years: 5,
      start_calendar_year: 2026,
      fiscal_year_start_month: 7,
      fiscal_year_labels_by: 'end_year',
    },
    form_fields: [
      formFieldRow('estimated_first_cost', 'Estimated first cost', 'currency', 20),
      formFieldRow('name', 'What is it?', 'text', 10),
      formFieldRow('supporting_notes', 'Notes', 'textarea', 40, { is_hidden: true }),
      formFieldRow('annual_cost_savings', 'Utility saving', 'number', 30),
      formFieldRow('addressing_deferred_maintenance', 'Deferred maintenance', 'boolean', 35),
      formFieldRow('warranty_years', 'Warranty (years)', 'number', 50, {
        storage: 'custom',
        is_builtin: false,
      }),
      formFieldRow('secret_code', 'Internal code', 'text', 60, {
        storage: 'custom',
        is_builtin: false,
        is_hidden: true,
      }),
    ],
    scenarios: [],
  }
}

/** A stand-in for the RLS-bound server client: every query on a table
 *  resolves to that table's rows. RLS itself is not under test here (it is
 *  Postgres'); the "can't read it" case is modelled as "no row". */
function stubClient(tables: Tables) {
  function query(table: string) {
    const rows = tables[table]
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: () => builder,
      maybeSingle: () =>
        Promise.resolve({
          data: Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null),
          error: null,
        }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows ?? [], error: null }).then(resolve, reject),
    }
    return builder
  }
  return { from: query } as never
}

const PROJECT = { id: PROJECT_ID, name: 'WS3 Test' } as never

function scenarioRow(startSlot: number) {
  return {
    id: SCENARIO_ID,
    project_id: PROJECT_ID,
    name: 'Defer construction',
    description: '',
    owner_email: 'a@example.com',
    visibility: 'private',
    payload: {
      phases: [
        {
          id: PHASE_ID,
          chunk_project_id: CHUNK_ID,
          name: 'Construction',
          kind: 'construction',
          sort_order: 0,
          pct_of_tpc: 1,
          start_slot: startSlot,
          duration_slots: 1,
          duration_locked: false,
        },
      ],
      dependencies: [],
    },
    baseline_fingerprint: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    published_at: null,
  }
}

const total = (rows: Array<{ totalCost: number }>) => rows.reduce((s, r) => s + r.totalCost, 0)

/* ---------------------------------------------------------------- tests -- */

describe('M-24: the export prices the active what-if', () => {
  test('scenario overlay moves the money exactly as the engine would', async () => {
    const live = await report.buildProjectReportData(stubClient(baseTables()), PROJECT)
    const tables = { ...baseTables(), scenarios: [scenarioRow(5)] }
    const what = await report.buildProjectReportData(stubClient(tables), PROJECT, {
      scenarioId: SCENARIO_ID,
    })

    assert.equal(live.scenario, null)
    assert.deepEqual(what.scenario, { id: SCENARIO_ID, name: 'Defer construction' })

    // Five years later at 4% compounding costs more...
    assert.ok(total(what.packages) > total(live.packages))

    // ...by exactly what the engine says for the overlaid phase.
    const settings = {
      ...engine.DEFAULT_COST_SETTINGS,
      baseYear: 2026,
      tpcFactor: 1.33,
      escalationAnnualPercent: 4,
      escalationBasis: 'midpoint' as const,
    }
    const geometry = {
      interval: 'yearly' as const,
      years: 10,
      startCalendarYear: 2026,
      fiscalYearStartMonth: 7,
      fiscalYearLabelsBy: 'end_year' as const,
    }
    const input = {
      chunkProjectId: CHUNK_ID,
      chunkNumber: 'P1',
      name: 'Package one',
      eccBase: 1_000_000,
      energySavingsAnnual: 0,
      annualCostSavings: 1500,
    }
    const phase = {
      id: PHASE_ID,
      chunkProjectId: CHUNK_ID,
      name: 'Construction',
      kind: 'construction' as const,
      sortOrder: 0,
      pctOfTpc: 1,
      startSlot: 5,
      durationSlots: 1,
      durationLocked: false,
    }
    const expected = engine.summarisePackage(input, [phase], settings, geometry).totalEscalatedCost
    assert.ok(Math.abs(total(what.packages) - expected) < 1e-6)

    // Phase sheet and annual summary follow the scenario too.
    // Slot 5 starts Jan 2031, inside the July-June FY that ends in 2031.
    assert.equal(what.phases[0].startFiscalYear, 'FY31')
    const annual = what.annualCostSummary.reduce((s, r) => s + r.escalatedTotal, 0)
    assert.ok(Math.abs(annual - expected) < 1e-6)

    assert.match(what.notices[0], /What-if scenario "Defer construction"/)
  })

  test('a scenario the caller cannot read (or that does not exist) is a 404, not the baseline', async () => {
    await assert.rejects(
      report.buildProjectReportData(stubClient(baseTables()), PROJECT, { scenarioId: SCENARIO_ID }),
      (error: unknown) =>
        error instanceof report.ExportBlockedError && error.status === 404
    )
  })

  test('a malformed scenario id is a 404 before any query', async () => {
    await assert.rejects(
      report.buildProjectReportData(stubClient(baseTables()), PROJECT, { scenarioId: "x' or 1=1" }),
      (error: unknown) => error instanceof report.ExportBlockedError && error.status === 404
    )
  })

  test('applyScenarioOverlay leaves phases the scenario does not mention alone', () => {
    const phases = [
      { id: 'a', startSlot: 0, durationSlots: 2, pctOfTpc: 0.5, durationLocked: false, name: 'A' },
      { id: 'b', startSlot: 2, durationSlots: 2, pctOfTpc: 0.5, durationLocked: false, name: 'B' },
    ]
    const out = engine.applyScenarioOverlay(phases, [
      { id: 'b', startSlot: 6, durationSlots: 3, pctOfTpc: 0.4, durationLocked: true },
      { id: 'gone', startSlot: 1, durationSlots: 1, pctOfTpc: 1, durationLocked: false },
    ])
    assert.deepEqual(out[0], phases[0])
    assert.deepEqual(out[1], {
      id: 'b',
      startSlot: 6,
      durationSlots: 3,
      pctOfTpc: 0.4,
      durationLocked: true,
      name: 'B',
    })
    assert.equal(out.length, 2)
    // The input is not mutated.
    assert.equal(phases[1].startSlot, 2)
  })
})

describe('M-25: no invented base year', () => {
  test('DEFAULT_COST_SETTINGS does not follow the clock', () => {
    assert.equal(engine.DEFAULT_COST_SETTINGS.baseYear, engine.STAND_IN_BASE_YEAR)
    assert.equal(engine.STAND_IN_BASE_YEAR, 2026)
  })

  test('missing cost settings row refuses the export with a clear 409', async () => {
    const tables = { ...baseTables(), project_cost_settings: null }
    await assert.rejects(
      report.buildProjectReportData(stubClient(tables), PROJECT),
      (error: unknown) =>
        error instanceof report.ExportBlockedError &&
        error.status === 409 &&
        /base year/.test(error.message)
    )
  })

  test('missing timeline start year refuses too', async () => {
    const tables = baseTables()
    tables.project_timeline_settings = {
      ...(tables.project_timeline_settings as object),
      start_calendar_year: null,
    }
    await assert.rejects(
      report.buildProjectReportData(stubClient(tables), PROJECT),
      (error: unknown) =>
        error instanceof report.ExportBlockedError && /timeline start year/.test(error.message)
    )
  })
})

describe('M-28: Line Items columns come from the form definition', () => {
  test('visible fields, in order, with their labels, custom fields included, hidden ones not', async () => {
    const data = await report.buildProjectReportData(stubClient(baseTables()), PROJECT)
    assert.deepEqual(
      data.lineItems.columns.map((c) => c.header),
      [
        'Item #',
        'Discipline',
        'Company',
        'What is it?',
        'Estimated first cost',
        'ECC Amount',
        'Utility saving',
        'Deferred maintenance',
        'Warranty (years)',
      ]
    )
    const [first] = data.lineItems.rows
    assert.deepEqual(first, [
      'A1',
      'Architecture',
      'FAA',
      'Item A1',
      '$1,000,000',
      1_000_000,
      1500,
      'Yes',
      7,
    ])
    assert.equal(data.lineItems.columns[6].format, 'currency')
    assert.equal(data.lineItems.columns[8].format, 'number')
  })

  test('ECC Amount still appears when the cost field is hidden', () => {
    const fields = [
      { key: 'name', label: 'Name', inputType: 'text', storage: 'column', sortOrder: 1, isHidden: false, options: [] },
    ] as never
    const table = report.buildLineItemTable([], fields)
    assert.equal(table.columns.at(-1)?.header, 'ECC Amount')
  })
})

describe('M-09 / M-10: unreadable input is flagged, not a silent zero', () => {
  test('notices and the ECC cell say so', async () => {
    const data = await report.buildProjectReportData(stubClient(baseTables()), PROJECT)
    assert.deepEqual(data.unreadableCostItems, ['A2'])
    assert.equal(data.unreadableQuantityLinks, 1)
    assert.ok(data.notices.some((n) => /1 line item has an unreadable cost \(A2\)/.test(n)))
    assert.ok(data.notices.some((n) => /unreadable quantity/.test(n)))
    assert.equal(data.lineItems.rows[1][5], report.UNREADABLE_CELL)
    // A2 contributes nothing; A1 alone is the package's base.
    assert.ok(total(data.packages) > 0)
  })

  test('the workbook carries the banner on every sheet and stays formula-free', async () => {
    const tables = { ...baseTables(), scenarios: [scenarioRow(2)] }
    const data = await report.buildProjectReportData(stubClient(tables), PROJECT, {
      scenarioId: SCENARIO_ID,
    })
    const workbook = excel.buildExcelWorkbook(data)
    assert.match(workbook.title, /scenario: Defer construction/)
    for (const sheet of workbook.worksheets) {
      const banner = String(sheet.getRow(1).getCell(1).value)
      assert.match(banner, /What-if scenario "Defer construction"/, sheet.name)
      assert.equal(sheet.getRow(2).getCell(1).value !== null, true)
      sheet.eachRow((row) =>
        row.eachCell((cell) => assert.equal(cell.formula, undefined, `${sheet.name} has a formula`))
      )
    }
    const lineItems = workbook.getWorksheet('Line Items')!
    assert.equal(lineItems.getRow(2).getCell(6).value, 'ECC Amount')
  })

  test('a clean live export has no banner row', async () => {
    const tables = baseTables()
    tables.line_items = [lineItemRow('li-1', 'A1', '$1,000,000', 1_000_000)]
    const chunk = (tables.chunk_projects as Array<{ chunk_project_items: unknown[] }>)[0]
    chunk.chunk_project_items = chunk.chunk_project_items.slice(0, 1)
    const data = await report.buildProjectReportData(stubClient(tables), PROJECT)
    assert.deepEqual(data.notices, [])
    const sheet = excel.buildExcelWorkbook(data).getWorksheet('Packages')!
    assert.equal(sheet.getRow(1).getCell(1).value, 'Package #')
  })
})
