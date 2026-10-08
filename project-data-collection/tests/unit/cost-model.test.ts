/**
 * Unit tests for lib/cost-model.ts.
 *
 * Run with `npm run test:unit` — Node's built-in test runner, no extra
 * dependency, and Node strips the TypeScript types natively.
 *
 * These are the assertions that matter most in the whole project. The cost
 * engine is the one place where a wrong answer is both plausible and invisible:
 * a mis-signed escalation exponent or an off-by-one in slot overlap produces a
 * number that looks entirely reasonable and is wrong by millions, and the
 * output goes to a state agency in a spreadsheet.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_COST_SETTINGS,
  DependencyCycleError,
  computeEnergySeries,
  computeFiscalYearTotals,
  computePhaseCost,
  computeSlotCosts,
  constraintStart,
  escalationFactor,
  fiscalYearForSlot,
  findDependencyViolations,
  monthsPerSlot,
  phaseYearsOut,
  propagateDependencies,
  slotToYears,
  summarisePackage,
  topologicalOrder,
  wouldCreateCycle,
  yearsPerSlot,
  type CostSettings,
  type EnergySettings,
  type Phase,
  type PhaseDependency,
  type TimelineGeometry,
} from '../../lib/cost-model.ts'

/* ------------------------------------------------------------- fixtures -- */

/** Months in a year. Phases are stored in MONTHS (D-1, migration 0020);
 *  these tests were written in years at Year zoom, so `3 * Y` reads as
 *  "year 3" and is the same calendar position the old `startSlot: 3` was. */
const Y = 12

const GEOMETRY: TimelineGeometry = {
  interval: 'yearly',
  years: 10,
  startCalendarYear: 2026,
  fiscalYearStartMonth: 7,
  fiscalYearLabelsBy: 'end_year',
}

const SETTINGS: CostSettings = {
  ...DEFAULT_COST_SETTINGS,
  tpcFactor: 1.33,
  baseYear: 2026,
  escalationAnnualPercent: 4,
  escalationBasis: 'midpoint',
  rateOverrides: new Map(),
}

function phase(overrides: Partial<Phase> & { id: string }): Phase {
  return {
    chunkProjectId: 'pkg-1',
    name: 'Phase',
    kind: 'construction',
    sortOrder: 0,
    pctOfTpc: 100,
    startMonth: 0,
    durationMonths: Y,
    durationLocked: false,
    ...overrides,
  }
}

function dep(
  predecessorPhaseId: string,
  successorPhaseId: string,
  overrides: Partial<PhaseDependency> = {}
): PhaseDependency {
  return {
    id: `${predecessorPhaseId}->${successorPhaseId}`,
    predecessorPhaseId,
    successorPhaseId,
    depType: 'FS',
    lagMonths: 0,
    ...overrides,
  }
}

/** Money compared to the cent. Anything looser hides real arithmetic bugs. */
function assertMoney(actual: number, expected: number, message?: string) {
  assert.ok(
    Math.abs(actual - expected) < 0.01,
    message ?? `expected ${expected}, got ${actual} (difference ${actual - expected})`
  )
}

/* ------------------------------------------------------- slot geometry -- */

describe('slot geometry', () => {
  test('matches the v1 Timeline tab slot-to-year mapping', () => {
    // v1's getSlotStartYear: monthly index/12, quarterly index/4, yearly index,
    // bi-yearly index*2, 3-yearly index*3, 5-yearly index*5.
    assert.equal(slotToYears(12, 'monthly'), 1)
    assert.equal(slotToYears(4, 'quarterly'), 1)
    assert.equal(slotToYears(3, 'yearly'), 3)
    assert.equal(slotToYears(2, 'bi-yearly'), 4)
    assert.equal(slotToYears(2, '3-yearly'), 6)
    assert.equal(slotToYears(2, '5-yearly'), 10)
  })

  test('yearsPerSlot is the inverse mapping', () => {
    assert.equal(yearsPerSlot('monthly'), 1 / 12)
    assert.equal(yearsPerSlot('yearly'), 1)
    assert.equal(yearsPerSlot('5-yearly'), 5)
  })

  test('monthsPerSlot is exact integers -- the 0020 conversion factors', () => {
    assert.deepEqual(
      (['monthly', 'quarterly', 'yearly', 'bi-yearly', '3-yearly', '5-yearly'] as const).map(
        monthsPerSlot
      ),
      [1, 3, 12, 24, 36, 60]
    )
  })
})

describe('fiscal years', () => {
  test('a July start means slot 0 of calendar 2026 is FY2026', () => {
    // Slot 0 begins January 2026, which falls in FY2026 (Jul 2025 - Jun 2026).
    assert.equal(fiscalYearForSlot(0, GEOMETRY), 2026)
  })

  test('Massachusetts FY2029 runs Jul 2028 to Jun 2029', () => {
    const monthly: TimelineGeometry = { ...GEOMETRY, interval: 'monthly', years: 10 }

    // June 2028 = month 29 from Jan 2026. Still FY2028.
    assert.equal(fiscalYearForSlot(29, monthly), 2028)
    // July 2028 = month 30. FY2029 begins.
    assert.equal(fiscalYearForSlot(30, monthly), 2029)
  })

  test('labelling by start year shifts the name down one', () => {
    const byStart: TimelineGeometry = { ...GEOMETRY, fiscalYearLabelsBy: 'start_year' }
    assert.equal(fiscalYearForSlot(0, byStart), fiscalYearForSlot(0, GEOMETRY) - 1)
  })

  test('a January fiscal year makes fiscal and calendar years coincide', () => {
    const calendar: TimelineGeometry = { ...GEOMETRY, fiscalYearStartMonth: 1 }
    assert.equal(fiscalYearForSlot(0, calendar), 2026)
    assert.equal(fiscalYearForSlot(3, calendar), 2029)
  })
})

/* ---------------------------------------------------------- escalation -- */

describe('escalation', () => {
  test('is 1.0 at the base year and never runs backwards', () => {
    assert.equal(escalationFactor(0, SETTINGS), 1)
    assert.equal(escalationFactor(-3, SETTINGS), 1)
  })

  test('compounds annually', () => {
    assertMoney(escalationFactor(1, SETTINGS), 1.04)
    assertMoney(escalationFactor(3, SETTINGS), 1.04 ** 3)
    assertMoney(escalationFactor(10, SETTINGS), 1.04 ** 10)
  })

  test('applies a partial final year fractionally, so dragging is continuous', () => {
    assertMoney(escalationFactor(2.5, SETTINGS), 1.04 ** 2.5)
  })

  test('per-year overrides beat the default rate for their year only', () => {
    const withOverrides: CostSettings = {
      ...SETTINGS,
      rateOverrides: new Map([
        [0, 6.5],
        [1, 5.25],
      ]),
    }

    // Year 0 at 6.5%, year 1 at 5.25%, year 2 back to the 4% default.
    assertMoney(escalationFactor(1, withOverrides), 1.065)
    assertMoney(escalationFactor(2, withOverrides), 1.065 * 1.0525)
    assertMoney(escalationFactor(3, withOverrides), 1.065 * 1.0525 * 1.04)
  })

  test('stepped mode reproduces v1 behaviour and does not compound between steps', () => {
    const stepped: CostSettings = {
      ...SETTINGS,
      escalationMode: 'stepped',
      escalationStepYears: 5,
      escalationAnnualPercent: 10,
    }

    assert.equal(escalationFactor(4.9, stepped), 1)
    assertMoney(escalationFactor(5, stepped), 1.1)
    assertMoney(escalationFactor(9.9, stepped), 1.1)
    assertMoney(escalationFactor(10, stepped), 1.1 ** 2)
  })
})

describe('escalation basis', () => {
  const p = phase({ id: 'p', startMonth: 2 * Y, durationMonths: 4 * Y })

  test('midpoint reads the clock half a duration later than start', () => {
    const atStart = phaseYearsOut(p, { ...SETTINGS, escalationBasis: 'start' }, GEOMETRY)
    const atMid = phaseYearsOut(p, { ...SETTINGS, escalationBasis: 'midpoint' }, GEOMETRY)

    assert.equal(atStart, 2)
    assert.equal(atMid, 4)
    assert.equal(atMid - atStart, p.durationMonths / 2 / Y)
  })

  test('midpoint prices a multi-year build higher than start — the whole reason it is the default', () => {
    const atStart = computePhaseCost(p, 1_000_000, { ...SETTINGS, escalationBasis: 'start' }, GEOMETRY)
    const atMid = computePhaseCost(p, 1_000_000, { ...SETTINGS, escalationBasis: 'midpoint' }, GEOMETRY)

    assert.ok(atMid.escalatedCost > atStart.escalatedCost)
    assertMoney(atMid.escalatedCost / atStart.escalatedCost, 1.04 ** 2)
  })

  test('the gap between base year and timeline anchor is carried', () => {
    // An estimate priced in 2026 used on a plan anchored at 2028 already
    // carries two years before anything is dragged.
    const anchored: TimelineGeometry = { ...GEOMETRY, startCalendarYear: 2028 }
    const atSlotZero = phase({ id: 'z', startMonth: 0, durationMonths: 0 })

    assert.equal(phaseYearsOut(atSlotZero, SETTINGS, anchored), 2)
    assert.equal(phaseYearsOut(atSlotZero, SETTINGS, GEOMETRY), 0)
  })
})

/* ---------------------------------------------------------- phase cost -- */

describe('phase cost', () => {
  test('a phase at the base year costs exactly its share of TPC', () => {
    const p = phase({ id: 'p', pctOfTpc: 90, startMonth: 0, durationMonths: 0 })
    const cost = computePhaseCost(p, 1_000_000, SETTINGS, GEOMETRY)

    assertMoney(cost.baseCost, 900_000)
    assertMoney(cost.escalationFactor, 1)
    assertMoney(cost.escalatedCost, 900_000)
  })

  test('amortises straight-line across the duration, as specified', () => {
    // "Costs for each phase were amortized over the duration of each phase so
    // that the total value of each phase were divided by the number of months
    // in duration."
    const p = phase({ id: 'p', pctOfTpc: 100, startMonth: 0, durationMonths: 4 * Y })
    const cost = computePhaseCost(p, 1_000_000, { ...SETTINGS, escalationAnnualPercent: 0 }, GEOMETRY)

    // Per MONTH since D-1: $1M over 48 months.
    assertMoney(cost.costPerMonth, 1_000_000 / 48)
    assertMoney(cost.costPerMonth * p.durationMonths, cost.escalatedCost)
  })

  test('flags phases past the confidence horizon', () => {
    const near = computePhaseCost(phase({ id: 'n', startMonth: 1 * Y, durationMonths: 1 * Y }), 1e6, SETTINGS, GEOMETRY)
    const far = computePhaseCost(phase({ id: 'f', startMonth: 8 * Y, durationMonths: 2 * Y }), 1e6, SETTINGS, GEOMETRY)

    assert.equal(near.beyondConfidenceHorizon, false)
    assert.equal(far.beyondConfidenceHorizon, true)
  })
})

/* -------------------------------------------------------------- package -- */

describe('package summary', () => {
  const input = {
    chunkProjectId: 'pkg-1',
    chunkNumber: 'PP10',
    name: 'Wings',
    eccBase: 1_000_000,
    energySavingsAnnual: 500_000,
    annualCostSavings: 60_000,
  }

  const dcammPhases = [
    phase({ id: 'study', kind: 'study', sortOrder: 0, pctOfTpc: 1, startMonth: 0, durationMonths: 1 * Y }),
    phase({ id: 'design', kind: 'design', sortOrder: 1, pctOfTpc: 9, startMonth: 1 * Y, durationMonths: 2 * Y }),
    phase({ id: 'build', kind: 'construction', sortOrder: 2, pctOfTpc: 90, startMonth: 3 * Y, durationMonths: 4 * Y }),
  ]

  test('applies the TPC factor to the ECC', () => {
    const summary = summarisePackage(input, dcammPhases, SETTINGS, GEOMETRY)
    assertMoney(summary.tpcBase, 1_330_000)
  })

  test('phases divide the package total rather than adding to it', () => {
    const noEscalation = { ...SETTINGS, escalationAnnualPercent: 0 }
    const summary = summarisePackage(input, dcammPhases, noEscalation, GEOMETRY)

    assertMoney(summary.totalBaseCost, summary.tpcBase)
    assertMoney(summary.totalEscalatedCost, summary.tpcBase)
  })

  test('reports an incomplete allocation instead of silently normalising it', () => {
    const short = dcammPhases.map((p) =>
      p.id === 'build' ? { ...p, pctOfTpc: 80 } : p
    )
    const summary = summarisePackage(input, short, SETTINGS, GEOMETRY)

    assert.equal(summary.allocatedPct, 90)
    assert.equal(summary.allocationIsIncomplete, true)
    // The cost reflects the 90% the user actually entered. Auto-scaling to 100
    // would rewrite a number a cost estimator typed.
    assertMoney(summary.phases.find((p) => p.phase.id === 'build')!.baseCost, 1_330_000 * 0.8)
  })

  test('a fully allocated package is not flagged', () => {
    assert.equal(summarisePackage(input, dcammPhases, SETTINGS, GEOMETRY).allocationIsIncomplete, false)
  })

  test('energy onset is the end of the last construction phase, not design', () => {
    const summary = summarisePackage(input, dcammPhases, SETTINGS, GEOMETRY)
    assert.equal(summary.energyOnsetMonth, 7 * Y) // build starts year 3, runs 4 years
  })

  test('a package with no construction phase never delivers savings', () => {
    const designOnly = [dcammPhases[0], dcammPhases[1]]
    assert.equal(summarisePackage(input, designOnly, SETTINGS, GEOMETRY).energyOnsetMonth, null)
  })
})

/* --------------------------------------------------------- slot rollups -- */

describe('slot costs', () => {
  const noEscalation = { ...SETTINGS, escalationAnnualPercent: 0, tpcFactor: 1 }

  const input = {
    chunkProjectId: 'pkg-1',
    chunkNumber: 'PP10',
    name: 'Pkg',
    eccBase: 400_000,
    energySavingsAnnual: 0,
    annualCostSavings: 0,
  }

  test('column totals equal the sum of the bars above them', () => {
    // This is the invariant that makes the header row trustworthy. If it ever
    // fails, the tool is reporting a different number than it is drawing.
    const phases = [phase({ id: 'p', pctOfTpc: 100, startMonth: 1 * Y, durationMonths: 4 * Y })]
    const summary = summarisePackage(input, phases, noEscalation, GEOMETRY)
    const slots = computeSlotCosts([summary], GEOMETRY)

    const columnSum = slots.reduce((sum, s) => sum + s.escalatedTotal, 0)
    assertMoney(columnSum, summary.totalEscalatedCost)
  })

  test('spreads evenly and lands in exactly the covered slots', () => {
    const phases = [phase({ id: 'p', pctOfTpc: 100, startMonth: 2 * Y, durationMonths: 4 * Y })]
    const slots = computeSlotCosts([summarisePackage(input, phases, noEscalation, GEOMETRY)], GEOMETRY)

    assertMoney(slots[0].escalatedTotal, 0)
    assertMoney(slots[1].escalatedTotal, 0)
    for (const i of [2, 3, 4, 5]) assertMoney(slots[i].escalatedTotal, 100_000)
    assertMoney(slots[6].escalatedTotal, 0)
  })

  test('handles fractional placement by interval overlap, not integer rounding', () => {
    // A phase that starts mid-year, viewed at year zoom, sits on a
    // fractional column boundary. Half in column 1, half in column 2.
    const phases = [phase({ id: 'p', pctOfTpc: 100, startMonth: 1.5 * Y, durationMonths: 1 * Y })]
    const slots = computeSlotCosts([summarisePackage(input, phases, noEscalation, GEOMETRY)], GEOMETRY)

    assertMoney(slots[1].escalatedTotal, 200_000)
    assertMoney(slots[2].escalatedTotal, 200_000)
    assertMoney(slots.reduce((s, x) => s + x.escalatedTotal, 0), 400_000)
  })

  test('escalation shows up as the gap between base and escalated totals', () => {
    const phases = [phase({ id: 'p', pctOfTpc: 100, startMonth: 4 * Y, durationMonths: 2 * Y })]
    const slots = computeSlotCosts([summarisePackage(input, phases, SETTINGS, GEOMETRY)], GEOMETRY)

    const base = slots.reduce((s, x) => s + x.baseTotal, 0)
    const escalated = slots.reduce((s, x) => s + x.escalatedTotal, 0)
    const escalation = slots.reduce((s, x) => s + x.escalationAmount, 0)

    assert.ok(escalated > base)
    assertMoney(escalation, escalated - base)
  })

  test('fiscal-year totals partition the slot totals with nothing lost', () => {
    const phases = [phase({ id: 'p', pctOfTpc: 100, startMonth: 0, durationMonths: 6 * Y })]
    const summaries = [summarisePackage(input, phases, SETTINGS, GEOMETRY)]
    const slots = computeSlotCosts(summaries, GEOMETRY)
    const byYear = computeFiscalYearTotals(summaries, GEOMETRY)

    assertMoney(
      byYear.reduce((s, y) => s + y.escalatedTotal, 0),
      slots.reduce((s, x) => s + x.escalatedTotal, 0)
    )
  })
})

/* --------------------------------------------------------------- energy -- */

describe('energy series', () => {
  const energy: EnergySettings = {
    unitLabel: 'kBtu/yr',
    baselineAnnual: 1_000_000,
    interactionFactor: 1,
  }

  function pkg(id: string, savings: number, buildStart: number, buildDuration: number) {
    return summarisePackage(
      {
        chunkProjectId: id,
        chunkNumber: id,
        name: id,
        eccBase: 100_000,
        energySavingsAnnual: savings,
        annualCostSavings: 0,
      },
      [
        phase({ id: `${id}-d`, kind: 'design', sortOrder: 0, pctOfTpc: 10, startMonth: 0, durationMonths: 1 * Y }),
        phase({
          id: `${id}-c`,
          kind: 'construction',
          sortOrder: 1,
          pctOfTpc: 90,
          // Arguments are in years, at the yearly GEOMETRY these tests use.
          startMonth: buildStart * Y,
          durationMonths: buildDuration * Y,
        }),
      ],
      SETTINGS,
      GEOMETRY
    )
  }

  test('steps down when construction completes, not when design does', () => {
    const series = computeEnergySeries([pkg('A', 100_000, 3, 2)], energy, GEOMETRY)

    // Design finishes at slot 1; nothing must happen there.
    assert.equal(series.points[1].cumulativeSavings, 0)
    assert.equal(series.points[2].cumulativeSavings, 0)
    // Construction finishes at slot 5.
    assert.equal(series.points[4].cumulativeSavings, 100_000)
    assert.equal(series.points[5].cumulativeSavings, 100_000)
  })

  test('savings accumulate across packages', () => {
    const series = computeEnergySeries(
      [pkg('A', 100_000, 0, 2), pkg('B', 250_000, 4, 2)],
      energy,
      GEOMETRY
    )

    assert.equal(series.points[2].cumulativeSavings, 100_000)
    assert.equal(series.points[8].cumulativeSavings, 350_000)
    assert.equal(series.finalSavings, 350_000)
  })

  test('remaining consumption falls away from the baseline', () => {
    const series = computeEnergySeries([pkg('A', 100_000, 0, 2)], energy, GEOMETRY)

    assert.equal(series.points[0].remainingConsumption, 1_000_000)
    assert.equal(series.points[9].remainingConsumption, 900_000)
  })

  test('the interaction factor de-rates every package', () => {
    const derated = computeEnergySeries(
      [pkg('A', 100_000, 0, 2), pkg('B', 100_000, 0, 2)],
      { ...energy, interactionFactor: 0.9 },
      GEOMETRY
    )

    // 200,000 summed, 180,000 after the de-rate. ECM savings are not additive.
    assert.equal(derated.finalSavings, 180_000)
  })

  test('works with no baseline at all', () => {
    // The feature has to be useful before the engineers deliver a baseline.
    const series = computeEnergySeries([pkg('A', 100_000, 0, 2)], { ...energy, baselineAnnual: null }, GEOMETRY)

    assert.equal(series.points[9].remainingConsumption, null)
    assert.equal(series.points[9].cumulativeSavings, 100_000)
  })

  test('remaining consumption never goes negative', () => {
    const series = computeEnergySeries(
      [pkg('A', 5_000_000, 0, 1)],
      { ...energy, baselineAnnual: 1_000_000 },
      GEOMETRY
    )
    assert.equal(series.points[9].remainingConsumption, 0)
  })
})

/* ---------------------------------------------------------- dependencies -- */

describe('dependency constraints', () => {
  test('the four PDM link types', () => {
    // predecessor: start 2, duration 3, so it ends at 5. successor duration 2.
    assert.equal(constraintStart('FS', 0, 2, 3, 2), 5)
    assert.equal(constraintStart('SS', 0, 2, 3, 2), 2)
    assert.equal(constraintStart('FF', 0, 2, 3, 2), 3) // finish at 5 => start at 3
    assert.equal(constraintStart('SF', 0, 2, 3, 2), 0) // finish at 2 => start at 0
  })

  test('lag delays and a negative lag leads', () => {
    assert.equal(constraintStart('FS', 2, 2, 3, 1), 7)
    assert.equal(constraintStart('FS', -1, 2, 3, 1), 4)
  })
})

describe('topological order', () => {
  test('orders predecessors before successors', () => {
    const ids = ['c', 'a', 'b']
    const order = topologicalOrder(ids, [dep('a', 'b'), dep('b', 'c')])

    assert.deepEqual(order, ['a', 'b', 'c'])
  })

  test('throws on a cycle rather than returning a partial order', () => {
    assert.throws(
      () => topologicalOrder(['a', 'b'], [dep('a', 'b'), dep('b', 'a')]),
      DependencyCycleError
    )
  })

  test('ignores links pointing outside the supplied set', () => {
    // The caller is entitled to compute over one package's phases.
    const order = topologicalOrder(['a'], [dep('a', 'elsewhere')])
    assert.deepEqual(order, ['a'])
  })
})

describe('dependency propagation', () => {
  test('pushes a violating successor forward', () => {
    const phases = [
      phase({ id: 'a', startMonth: 0, durationMonths: 3 }),
      phase({ id: 'b', startMonth: 1, durationMonths: 2 }),
    ]
    const result = propagateDependencies(phases, [dep('a', 'b')])

    assert.equal(result.get('b')!.startMonth, 3)
  })

  test('cascades transitively', () => {
    // Jeff's question: "if you push out the wings project, will it
    // automatically push out the bulfinch?"
    const phases = [
      phase({ id: 'a', startMonth: 5, durationMonths: 2 }),
      phase({ id: 'b', startMonth: 0, durationMonths: 2 }),
      phase({ id: 'c', startMonth: 0, durationMonths: 2 }),
    ]
    const result = propagateDependencies(phases, [dep('a', 'b'), dep('b', 'c')])

    assert.equal(result.get('b')!.startMonth, 7)
    assert.equal(result.get('c')!.startMonth, 9)
  })

  test('preserves slack — it never pulls a successor earlier', () => {
    // Planners leave gaps on purpose: "we're going to put this on the shelf...
    // because we already have a couple other projects in the pipeline".
    const phases = [
      phase({ id: 'a', startMonth: 0, durationMonths: 2 }),
      phase({ id: 'b', startMonth: 8, durationMonths: 2 }),
    ]
    const result = propagateDependencies(phases, [dep('a', 'b')])

    assert.equal(result.get('b')!.startMonth, 8)
  })

  test('moves a locked phase without stretching it', () => {
    // "Fixed duration" means the bar's length is constant, not that it cannot
    // be rescheduled.
    const phases = [
      phase({ id: 'a', startMonth: 4, durationMonths: 2 }),
      phase({ id: 'b', startMonth: 0, durationMonths: 3, durationLocked: true }),
    ]
    const result = propagateDependencies(phases, [dep('a', 'b')])

    assert.equal(result.get('b')!.startMonth, 6)
    assert.equal(result.get('b')!.durationMonths, 3)
  })

  test('honours lag when pushing', () => {
    const phases = [
      phase({ id: 'a', startMonth: 0, durationMonths: 2 }),
      phase({ id: 'b', startMonth: 0, durationMonths: 1 }),
    ]
    const result = propagateDependencies(phases, [dep('a', 'b', { lagMonths: 3 })])

    assert.equal(result.get('b')!.startMonth, 5)
  })

  test('does not mutate its input', () => {
    const phases = [
      phase({ id: 'a', startMonth: 0, durationMonths: 3 }),
      phase({ id: 'b', startMonth: 0, durationMonths: 1 }),
    ]
    propagateDependencies(phases, [dep('a', 'b')])

    assert.equal(phases[1].startMonth, 0)
  })
})

describe('violations', () => {
  test('reports an unsatisfied link', () => {
    const phases = [
      phase({ id: 'a', startMonth: 0, durationMonths: 4 }),
      phase({ id: 'b', startMonth: 1, durationMonths: 1 }),
    ]
    const violations = findDependencyViolations(phases, [dep('a', 'b')])

    assert.equal(violations.length, 1)
    assert.equal(violations[0].requiredStart, 4)
    assert.equal(violations[0].actualStart, 1)
  })

  test('a satisfied link is silent, including one with slack', () => {
    const phases = [
      phase({ id: 'a', startMonth: 0, durationMonths: 2 }),
      phase({ id: 'b', startMonth: 6, durationMonths: 1 }),
    ]
    assert.equal(findDependencyViolations(phases, [dep('a', 'b')]).length, 0)
  })

  test('propagation leaves no violations behind', () => {
    const phases = [
      phase({ id: 'a', startMonth: 3, durationMonths: 2 }),
      phase({ id: 'b', startMonth: 0, durationMonths: 2 }),
      phase({ id: 'c', startMonth: 0, durationMonths: 2 }),
    ]
    const deps = [dep('a', 'b'), dep('b', 'c', { lagMonths: 1 })]
    const settled = [...propagateDependencies(phases, deps).values()]

    assert.deepEqual(findDependencyViolations(settled, deps), [])
  })
})

describe('cycle prediction', () => {
  test('catches a self link', () => {
    assert.equal(wouldCreateCycle('a', 'a', []), true)
  })

  test('catches a direct reversal', () => {
    assert.equal(wouldCreateCycle('b', 'a', [dep('a', 'b')]), true)
  })

  test('catches a transitive loop', () => {
    assert.equal(wouldCreateCycle('c', 'a', [dep('a', 'b'), dep('b', 'c')]), true)
  })

  test('allows a legitimate new edge', () => {
    assert.equal(wouldCreateCycle('a', 'c', [dep('a', 'b')]), false)
  })

  test('allows a diamond, which is not a cycle', () => {
    const deps = [dep('a', 'b'), dep('a', 'c')]
    assert.equal(wouldCreateCycle('b', 'd', deps), false)
    assert.equal(wouldCreateCycle('c', 'd', deps), false)
  })
})

/* ---------------------------------------------------- WS-3 (M-24, M-25) -- */

describe('defaults never follow the clock (M-25)', () => {
  test('DEFAULT_COST_SETTINGS.baseYear is the fixed stand-in, not the current year', async () => {
    const { STAND_IN_BASE_YEAR } = await import('../../lib/cost-model.ts')
    assert.equal(DEFAULT_COST_SETTINGS.baseYear, STAND_IN_BASE_YEAR)
    // Re-reading the module on another day must give the same number.
    assert.equal(Number.isInteger(DEFAULT_COST_SETTINGS.baseYear), true)
  })
})

describe('applyScenarioOverlay (M-24)', () => {
  test('a what-if reprices exactly as if the live phase had moved', async () => {
    const { applyScenarioOverlay } = await import('../../lib/cost-model.ts')
    const live: Phase = {
      id: 'p',
      chunkProjectId: 'c',
      name: 'Construction',
      kind: 'construction',
      sortOrder: 0,
      pctOfTpc: 1,
      startMonth: 0,
      durationMonths: 1,
      durationLocked: false,
    }
    const [moved] = applyScenarioOverlay([live], [
      { id: 'p', startMonth: 3 * Y, durationMonths: 2 * Y, pctOfTpc: 1, durationLocked: false },
    ])
    assert.deepEqual(
      computePhaseCost(moved, 1_000_000, SETTINGS, GEOMETRY),
      computePhaseCost({ ...live, startMonth: 3 * Y, durationMonths: 2 * Y }, 1_000_000, SETTINGS, GEOMETRY)
    )
  })
})
