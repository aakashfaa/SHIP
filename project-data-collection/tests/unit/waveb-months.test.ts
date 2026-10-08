/**
 * Wave B: schedules in months, zoom as a view (M-01 / D-1), fiscal years at
 * monthly resolution with fiscal quarters (M-26 / D-11), and one horizon
 * rule for screen and export (M-27).
 *
 * The headline promise this file pins: for the shapes of the projects we
 * actually have (the federal-campus seed and the bsb2301 walkthrough), the
 * headline total, every package total and every fiscal-year total are
 * IDENTICAL -- not "close", identical -- at every zoom level. Before the
 * months conversion, the same rows priced at $78.7M at Month zoom and $366M
 * at Year zoom.
 *
 * report-data.ts is loaded the same way tests/unit/ws3-export.test.ts loads
 * it (a resolve hook for its extensionless imports), over a stub client.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'

import {
  DEFAULT_COST_SETTINGS,
  computeFiscalYearTotals,
  computeSlotCosts,
  fiscalQuarterForMonth,
  fiscalYearForMonth,
  monthsPerSlot,
  resolveHorizon,
  slotCalendarLabel,
  slotCount,
  slotFiscalLabel,
  summarisePackage,
  type CostSettings,
  type PackageInput,
  type Phase,
  type TimelineGeometry,
} from '../../lib/cost-model.ts'
import type { TimelineInterval } from '../../lib/types.ts'
import { placementForDelta } from '../../components/project-workspace/timeline/drag.ts'

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
let report: ReportModule
let excel: ExcelModule

before(async () => {
  report = await import('../../lib/export/report-data.ts')
  excel = await import('../../lib/export/excel.ts')
})

/* ------------------------------------------------------------- fixtures -- */

const INTERVALS: TimelineInterval[] = [
  '5-yearly',
  '3-yearly',
  'bi-yearly',
  'yearly',
  'quarterly',
  'monthly',
]

const SETTINGS: CostSettings = {
  ...DEFAULT_COST_SETTINGS,
  tpcFactor: 1.33,
  baseYear: 2026,
  escalationAnnualPercent: 4,
  escalationBasis: 'midpoint',
  // Two pinned near-term years, as the federal seed has -- the case where a
  // per-year product (not a single power) prices the plan.
  rateOverrides: new Map([
    [0, 6.5],
    [1, 5.25],
  ]),
}

function geometryAt(interval: TimelineInterval, years: number): TimelineGeometry {
  return {
    interval,
    years,
    startCalendarYear: 2026,
    fiscalYearStartMonth: 7,
    fiscalYearLabelsBy: 'end_year',
  }
}

type Shape = { inputs: PackageInput[]; phases: Phase[]; years: number }

function pkg(id: string, eccBase: number): PackageInput {
  return { chunkProjectId: id, chunkNumber: id, name: id, eccBase, energySavingsAnnual: 0, annualCostSavings: 0 }
}

function ph(
  chunk: string,
  kind: Phase['kind'],
  sortOrder: number,
  pctOfTpc: number,
  startMonth: number,
  durationMonths: number
): Phase {
  return {
    id: `${chunk}-${kind}-${sortOrder}`,
    chunkProjectId: chunk,
    name: kind,
    kind,
    sortOrder,
    pctOfTpc,
    startMonth,
    durationMonths,
    durationLocked: false,
  }
}

/** supabase/seeds/002_v2_phases.sql: [study, design, build start, build
 *  duration] in YEARS, study 1y, design 2y, DCAMM 1/9/90 (PP14 build 80%). */
const FEDERAL: Shape = (() => {
  const layout: Array<[string, number, number, number, number]> = [
    ['PP10', 0, 1, 3, 4],
    ['PP11', 0, 1, 7, 3],
    ['PP12', 1, 2, 11, 2],
    ['PP13', 0, 1, 4, 2],
    ['PP14', 2, 3, 7, 2],
  ]
  const inputs = layout.map(([id], i) => pkg(id, 1_250_000 * (i + 1)))
  const phases = layout.flatMap(([id, study, design, build, buildYears]) => [
    ph(id, 'study', 0, 1, study * 12, 12),
    ph(id, 'design', 1, 9, design * 12, 24),
    ph(id, 'construction', 2, id === 'PP14' ? 80 : 90, build * 12, buildYears * 12),
  ])
  return { inputs, phases, years: 15 }
})()

/** The bsb2301 walkthrough (stored at Month zoom, so months as-is). Phases
 *  start mid-year and last 4, 9, 12 or 18 months -- nothing aligns to a
 *  year, let alone a 5-year block. */
const BSB: Shape = (() => {
  const rows: Array<[number, Phase['kind'], number, number, number]> = [
    [0, 'study', 1, 6, 4], [1, 'design', 3, 11, 4], [0, 'construction', 90, 27, 12],
    [2, 'construction', 90, 45, 12], [0, 'design', 3, 11, 4], [2, 'study', 1, 6, 4],
    [2, 'design', 3, 11, 4], [0, 'design', 6, 18, 9], [1, 'study', 1, 6, 4],
    [1, 'design', 6, 18, 9], [1, 'construction', 90, 27, 18], [2, 'design', 6, 18, 9],
  ]
  const inputs = [pkg('B0', 21_000_000), pkg('B1', 17_500_000), pkg('B2', 19_250_000)]
  const phases = rows.map(([c, kind, pct, start, dur], i) => ph(`B${c}`, kind, i, pct, start, dur))
  return { inputs, phases, years: 6 }
})()

function priceAt(shape: Shape, interval: TimelineInterval) {
  const horizon = resolveHorizon(geometryAt(interval, shape.years), shape.phases)
  const geometry = horizon.geometry
  const summaries = shape.inputs.map((input) =>
    summarisePackage(
      input,
      shape.phases.filter((p) => p.chunkProjectId === input.chunkProjectId),
      SETTINGS,
      geometry
    )
  )
  return {
    headline: summaries.reduce((s, x) => s + x.totalEscalatedCost, 0),
    packages: summaries.map((s) => s.totalEscalatedCost),
    fiscalYears: computeFiscalYearTotals(summaries, geometry),
    columns: computeSlotCosts(summaries, geometry),
    geometry,
  }
}

function assertCents(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 0.005, `${label}: ${actual} vs ${expected}`)
}

/* ---------------------------------------------------------------- tests -- */

for (const [name, shape] of [
  ['federal-campus seed', FEDERAL],
  ['bsb2301 walkthrough', BSB],
] as const) {
  describe(`zoom is a view, not a price (M-01) -- ${name}`, () => {
    const reference = priceAt(shape, 'monthly')

    test('headline, every package and every fiscal year are identical at every zoom', () => {
      for (const interval of INTERVALS) {
        const at = priceAt(shape, interval)
        assert.equal(at.headline, reference.headline, `headline at ${interval}`)
        assert.deepEqual(at.packages, reference.packages, `package totals at ${interval}`)
        assert.deepEqual(at.fiscalYears, reference.fiscalYears, `FY totals at ${interval}`)
      }
    })

    test('at every zoom the columns add up to the headline (nothing falls off the grid)', () => {
      for (const interval of INTERVALS) {
        const at = priceAt(shape, interval)
        const columnSum = at.columns.reduce((s, c) => s + c.escalatedTotal, 0)
        assertCents(columnSum, at.headline, `columns at ${interval}`)
      }
    })

    test('the fiscal years and their quarters add up to the headline', () => {
      const fySum = reference.fiscalYears.reduce((s, y) => s + y.escalatedTotal, 0)
      assertCents(fySum, reference.headline, 'FY sum')
      for (const year of reference.fiscalYears) {
        const qSum = year.quarters.reduce((s, q) => s + q.escalatedTotal, 0)
        assertCents(qSum, year.escalatedTotal, `FY${year.fiscalYear} quarters`)
      }
    })
  })
}

describe('fiscal years at monthly resolution (M-26, D-11)', () => {
  const flat: CostSettings = { ...SETTINGS, escalationAnnualPercent: 0, rateOverrides: new Map(), tpcFactor: 1 }
  const jan2026to_dec2026: Phase = ph('P', 'construction', 0, 100, 0, 12)
  const input = pkg('P', 12_000_000)

  test('a Jan-Dec 2026 $12M phase splits $6M / $6M across FY26 and FY27 (July FY), at every zoom', () => {
    for (const interval of INTERVALS) {
      const geometry = geometryAt(interval, 2)
      const summary = summarisePackage(input, [jan2026to_dec2026], flat, geometry)
      const byYear = computeFiscalYearTotals([summary], geometry)
      const fy26 = byYear.find((y) => y.fiscalYear === 2026)!
      const fy27 = byYear.find((y) => y.fiscalYear === 2027)!
      assertCents(fy26.escalatedTotal, 6_000_000, `FY26 at ${interval}`)
      assertCents(fy27.escalatedTotal, 6_000_000, `FY27 at ${interval}`)
      // Fiscal quarters: Jan-Mar is FY26 Q3, Apr-Jun Q4; Jul-Sep is FY27 Q1.
      assert.deepEqual(
        fy26.quarters.map((q) => Math.round(q.escalatedTotal)),
        [0, 0, 3_000_000, 3_000_000]
      )
      assert.deepEqual(
        fy27.quarters.map((q) => Math.round(q.escalatedTotal)),
        [3_000_000, 3_000_000, 0, 0]
      )
    }
  })

  test('with a January fiscal year the same phase is all FY26', () => {
    const geometry = { ...geometryAt('yearly', 2), fiscalYearStartMonth: 1 }
    const summary = summarisePackage(input, [jan2026to_dec2026], flat, geometry)
    const byYear = computeFiscalYearTotals([summary], geometry)
    assertCents(byYear.find((y) => y.fiscalYear === 2026)!.escalatedTotal, 12_000_000, 'FY26')
  })

  test('every fiscal year in the horizon is listed, empty ones as $0', () => {
    const geometry = geometryAt('yearly', 3)
    const summary = summarisePackage(input, [jan2026to_dec2026], flat, geometry)
    // Jan 2026 - Dec 2028 touches FY26..FY29 under a July fiscal year.
    assert.deepEqual(
      computeFiscalYearTotals([summary], geometry).map((y) => [y.fiscalYear, Math.round(y.escalatedTotal)]),
      [
        [2026, 6_000_000],
        [2027, 6_000_000],
        [2028, 0],
        [2029, 0],
      ]
    )
  })

  test('fiscal quarter and fiscal year of a month', () => {
    const g = geometryAt('monthly', 5)
    assert.equal(fiscalYearForMonth(5, g), 2026) // Jun 2026
    assert.equal(fiscalYearForMonth(6, g), 2027) // Jul 2026
    assert.equal(fiscalQuarterForMonth(6, g), 1) // Jul = Q1
    assert.equal(fiscalQuarterForMonth(0, g), 3) // Jan = Q3
    assert.equal(fiscalQuarterForMonth(5, g), 4) // Jun = Q4
  })

  test('column labels: calendar span on top, fiscal span underneath', () => {
    assert.equal(slotCalendarLabel(0, geometryAt('yearly', 5)), 'CY2026')
    assert.equal(slotFiscalLabel(0, geometryAt('yearly', 5)), 'FY26–27')
    assert.equal(slotCalendarLabel(1, geometryAt('quarterly', 5)), 'Apr–Jun 26')
    assert.equal(slotFiscalLabel(1, geometryAt('quarterly', 5)), 'FY26 Q4')
    assert.equal(slotCalendarLabel(6, geometryAt('monthly', 5)), 'Jul 26')
    assert.equal(slotFiscalLabel(6, geometryAt('monthly', 5)), 'FY27 Q1')
    assert.equal(slotCalendarLabel(1, geometryAt('5-yearly', 15)), 'CY2031–35')
    assert.equal(slotFiscalLabel(1, geometryAt('5-yearly', 15)), 'FY31–FY36')
  })
})

describe('one horizon rule for screen and export (M-27)', () => {
  const late: Phase[] = [
    ph('P', 'design', 0, 10, 0, 12),
    // Years 9-12 on a 10-year timeline: half of it past the configured end.
    ph('P', 'construction', 1, 90, 96, 48),
  ]

  test('the horizon stretches to the end of the furthest phase, and says so', () => {
    const horizon = resolveHorizon(geometryAt('yearly', 10), late)
    assert.equal(horizon.geometry.years, 12)
    assert.equal(horizon.configuredYears, 10)
    assert.equal(horizon.extended, true)
    assert.equal(resolveHorizon(geometryAt('yearly', 15), late).extended, false)
  })

  test('columns and fiscal years then hold every dollar of the headline, at every zoom', () => {
    for (const interval of INTERVALS) {
      const geometry = resolveHorizon(geometryAt(interval, 10), late).geometry
      const summary = summarisePackage(pkg('P', 10_000_000), late, SETTINGS, geometry)
      const columns = computeSlotCosts([summary], geometry).reduce((s, c) => s + c.escalatedTotal, 0)
      const fys = computeFiscalYearTotals([summary], geometry).reduce((s, y) => s + y.escalatedTotal, 0)
      assertCents(columns, summary.totalEscalatedCost, `columns at ${interval}`)
      assertCents(fys, summary.totalEscalatedCost, `FYs at ${interval}`)
      assert.ok(slotCount(geometry.years, interval) * monthsPerSlot(interval) >= 144)
    }
  })
})

describe('drag moves in the zoom unit, stores months (D-1)', () => {
  test('one column at Year zoom is 12 months; a mid-year phase keeps its offset', () => {
    const origin = { phaseId: 'p', mode: 'move' as const, startMonth: 6, durationMonths: 9 }
    assert.deepEqual(placementForDelta(origin, 1 * monthsPerSlot('yearly'), 120), {
      startMonth: 18,
      durationMonths: 9,
    })
    assert.deepEqual(placementForDelta(origin, 1 * monthsPerSlot('quarterly'), 120), {
      startMonth: 9,
      durationMonths: 9,
    })
  })
})

/* --------------------------------------------------------------- export -- */

const PROJECT_ID = 'wb-proj'
const CHUNK_ID = '00000000-0000-4000-8000-0000000000c1'

function stubClient(tables: Record<string, unknown>) {
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

function exportTables(zoomLevel: number) {
  const phase = (id: string, kind: string, sort: number, pct: number, start: number, dur: number) => ({
    id: `00000000-0000-4000-8000-0000000000${id}`,
    chunk_project_id: CHUNK_ID,
    template_step_id: null,
    name: kind,
    kind,
    sort_order: sort,
    pct_of_tpc: pct,
    start_slot: start,
    duration_slots: dur,
    duration_locked: false,
    created_at: '2026-01-01T00:00:00Z',
  })
  return {
    line_items: [
      {
        id: 'li-1',
        project_id: PROJECT_ID,
        item_number: 'A1',
        name: 'Item',
        estimated_first_cost: '$10,000,000',
        ecc_amount: 10_000_000,
        annual_energy_savings: 1000,
        annual_cost_savings: 0,
        custom_fields: {},
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
        chunk_project_items: [{ chunk_project_id: CHUNK_ID, line_item_id: 'li-1', quantity: '1', position: 0 }],
      },
    ],
    // Design mid-2026, construction Oct 2033 - Sep 2037: past the 10-year
    // Timeline Length and nowhere near a year boundary.
    chunk_phases: [phase('a1', 'design', 0, 10, 5, 7), phase('a2', 'construction', 1, 90, 93, 48)],
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
    project_energy_settings: { project_id: PROJECT_ID, unit_label: 'kBtu/yr', baseline_annual: null, interaction_factor: 1 },
    project_timeline_settings: {
      project_id: PROJECT_ID,
      years: 10,
      interval_unit: 'yearly',
      zoom_level: zoomLevel,
      escalation_percent: 0,
      escalation_every_years: 5,
      start_calendar_year: 2026,
      fiscal_year_start_month: 7,
      fiscal_year_labels_by: 'end_year',
    },
    form_fields: [],
    scenarios: [],
  }
}

describe('Excel export (M-01, M-26, M-27)', () => {
  const PROJECT = { id: PROJECT_ID, name: 'Wave B' } as never
  const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0)

  test('the workbook is the same whatever zoom the project was saved at', async () => {
    const at = await Promise.all(
      [1, 2, 3, 4, 5].map((z) => report.buildProjectReportData(stubClient(exportTables(z)), PROJECT))
    )
    for (const data of at.slice(1)) {
      assert.deepEqual(data.packages, at[0].packages)
      assert.deepEqual(data.phases, at[0].phases)
      assert.deepEqual(data.annualCostSummary, at[0].annualCostSummary)
      assert.deepEqual(data.energySummary, at[0].energySummary)
    }
  })

  test('Annual Cost Summary total == Packages total == headline (spec §6 check 4)', async () => {
    const data = await report.buildProjectReportData(stubClient(exportTables(3)), PROJECT)
    const packages = sum(data.packages, (p) => p.totalCost)
    const annual = sum(data.annualCostSummary, (r) => r.escalatedTotal)
    assertCents(annual, packages, 'annual summary vs packages')
    for (const row of data.annualCostSummary) {
      assertCents(sum(row.quarterTotals, (q) => q), row.escalatedTotal, `${row.fiscalYearLabel} quarters`)
    }
    // The horizon was extended to include the late construction, and said so.
    assert.ok(data.annualCostSummary.some((r) => r.fiscalYearLabel === 'FY38'))
    assert.ok(data.notices.some((n) => /run past the 10-year timeline/.test(n)))
    // The phase sheet speaks months.
    assert.equal(data.phases[1].startMonth, 'Oct 2033')
    assert.equal(data.phases[1].durationMonths, 48)
    assert.equal(data.phases[1].durationYears, 4)
  })

  test('the workbook carries fiscal-quarter columns that add up', async () => {
    const data = await report.buildProjectReportData(stubClient(exportTables(5)), PROJECT)
    const workbook = excel.buildExcelWorkbook(data)
    const sheet = workbook.getWorksheet('Annual Cost Summary')!
    let header = 0
    sheet.eachRow((row, n) => {
      if (row.getCell(1).value === 'Fiscal Year') header = n
    })
    assert.deepEqual(
      [2, 3, 4, 5, 6].map((c) => sheet.getRow(header).getCell(c).value),
      ['Q1', 'Q2', 'Q3', 'Q4', 'Total Cost']
    )
    let total = 0
    for (let n = header + 1; n <= sheet.rowCount; n += 1) total += Number(sheet.getRow(n).getCell(6).value)
    assertCents(total, sum(data.packages, (p) => p.totalCost), 'sheet total')
  })
})
