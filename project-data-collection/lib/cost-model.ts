/**
 * The cost, escalation, energy and scheduling engine.
 *
 * Pure functions only — no React, no Supabase, no DOM. That is a hard rule,
 * not a stylistic one: the Timeline tab, the Excel route handler and the PDF
 * route all have to produce the same numbers, and the only way to guarantee
 * that is for all three to call the same functions. The client is handing the
 * Excel output to a state agency; "the screen said one thing and the export
 * said another" is not a bug we get to have.
 *
 * It also means this file is directly unit-testable without a database or a
 * browser. See `tests/unit/cost-model.test.ts`.
 *
 * Spec: docs/SPEC-v2-phasing-and-cost-model.md §3.
 */

import type { TimelineInterval } from './types'

/* ------------------------------------------------------------------ types -- */

export type PhaseKind = 'study' | 'design' | 'construction' | 'closeout'

/** Precedence Diagramming Method link types. FS is ~all real usage; the other
 *  three are one line of arithmetic each, and omitting them would only
 *  guarantee a migration later. */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

export type EscalationMode = 'compound_annual' | 'stepped'

/** Which point in a phase the escalation clock is read at.
 *
 *  `midpoint` is the default and the estimating convention. Construction
 *  dollars are spent across the whole duration, so roughly half are committed
 *  after the halfway point; escalating a multi-year build only to its start
 *  date systematically under-prices it, and escalating to completion
 *  over-prices it. The midpoint approximates the weighted-average purchase
 *  date under a roughly symmetric spend curve.
 *
 *  `start` exists because some owners mandate it, not because it is better. */
export type EscalationBasis = 'midpoint' | 'start'

export type Phase = {
  id: string
  chunkProjectId: string
  name: string
  kind: PhaseKind
  sortOrder: number
  /** Share of the package's TPC, 0–100. Should sum to 100 across a package;
   *  deliberately not enforced — see `summarisePackage`. */
  pctOfTpc: number
  startSlot: number
  durationSlots: number
  /** Fixed Duration in the MS Project sense: the bar's length is constant, its
   *  position is not. A locked phase can still be moved. */
  durationLocked: boolean
}

export type PhaseDependency = {
  id: string
  predecessorPhaseId: string
  successorPhaseId: string
  depType: DependencyType
  /** In slots. May be negative, which is a lead — "bidding can overlap the
   *  tail of CD". */
  lagSlots: number
}

export type CostSettings = {
  tpcFactor: number
  /** The calendar year `eccBase` is priced in. Escalation is measured from
   *  here, not from the timeline anchor. */
  baseYear: number
  escalationMode: EscalationMode
  escalationAnnualPercent: number
  escalationStepYears: number
  escalationBasis: EscalationBasis
  /** Past this many years out, the UI presents a range rather than a number. */
  escalationConfidenceYears: number
  /** year offset from `baseYear` → percent. Overrides the default rate for
   *  that single year. */
  rateOverrides: ReadonlyMap<number, number>
}

export type TimelineGeometry = {
  interval: TimelineInterval
  years: number
  /** Calendar year that slot 0 begins in. */
  startCalendarYear: number
  /** 1–12. 7 = a July–June fiscal year. */
  fiscalYearStartMonth: number
  /** Which calendar year names the fiscal year. Massachusetts FY2029 runs
   *  Jul 2028 – Jun 2029, i.e. it is named for the year it ends in. */
  fiscalYearLabelsBy: 'start_year' | 'end_year'
}

export type EnergySettings = {
  unitLabel: string
  /** Null is a supported state: without a baseline the chart plots cumulative
   *  savings from zero instead of remaining consumption from a baseline. The
   *  feature has to be useful before the engineers deliver the baseline. */
  baselineAnnual: number | null
  /** De-rate for interactive effects between measures. 1.0 = savings taken as
   *  summed. ECM savings are genuinely not additive — a lighting retrofit cuts
   *  the internal heat gain that a separately-modelled HVAC measure claims
   *  savings against — and a single honest multiplier is the right resolution
   *  at master-plan grain. */
  interactionFactor: number
}

/** One package's aggregate inputs, already summed from its line items.
 *  Quantity lives on the line-item↔package join, so the caller applies it. */
export type PackageInput = {
  chunkProjectId: string
  chunkNumber: string
  name: string
  /** Un-escalated Expected Construction Cost, base-year dollars. */
  eccBase: number
  /** Annual energy saving once in service, before the interaction factor. */
  energySavingsAnnual: number
  annualCostSavings: number
}

/* --------------------------------------------------------- slot geometry -- */

/**
 * How many calendar years one timeline slot spans.
 *
 * Mirrors `getSlotStartYear` in the v1 Timeline tab, which maps slot index to
 * year as index/12, index/4, index, index*2, index*3, index*5. Expressed here
 * as a per-slot width so the conversion is one multiply in both directions.
 */
export function yearsPerSlot(interval: TimelineInterval): number {
  switch (interval) {
    case 'monthly':
      return 1 / 12
    case 'quarterly':
      return 1 / 4
    case 'yearly':
      return 1
    case 'bi-yearly':
      return 2
    case '3-yearly':
      return 3
    case '5-yearly':
      return 5
    default:
      return 1
  }
}

export function slotToYears(slot: number, interval: TimelineInterval): number {
  return slot * yearsPerSlot(interval)
}

export function slotCount(years: number, interval: TimelineInterval): number {
  const per = yearsPerSlot(interval)
  return per >= 1 ? Math.ceil(years / per) : Math.round(years / per)
}

/**
 * The fiscal year a given slot's start falls in.
 *
 * Worked example with the Massachusetts default (start month 7, labelled by
 * end year): a slot beginning July 2028 is in FY2029, and one beginning June
 * 2028 is in FY2028 — because FY2028 ran Jul 2027 – Jun 2028.
 */
export function fiscalYearForSlot(slot: number, geometry: TimelineGeometry): number {
  const monthsFromAnchor = slotToYears(slot, geometry.interval) * 12
  const absoluteMonth = Math.floor(monthsFromAnchor)

  const calendarYear = geometry.startCalendarYear + Math.floor(absoluteMonth / 12)
  // 0-based month within that calendar year.
  const monthIndex = ((absoluteMonth % 12) + 12) % 12
  const fyStartIndex = Math.min(Math.max(geometry.fiscalYearStartMonth, 1), 12) - 1

  // The calendar year the containing fiscal year BEGAN in. A date at or after
  // the fiscal start month belongs to the year that began this calendar year;
  // one before it belongs to the year that began last calendar year.
  const startYear = monthIndex >= fyStartIndex ? calendarYear : calendarYear - 1

  // A fiscal year beginning in January ends in the SAME calendar year; any
  // other start month means it ends in the next one. Collapsing these two
  // cases is the obvious mistake and it silently shifts every label on a
  // calendar-year project by one — which nobody notices until a client asks
  // why their FY2026 column is headed FY2027.
  const spansYearBoundary = fyStartIndex > 0
  const endYear = spansYearBoundary ? startYear + 1 : startYear

  return geometry.fiscalYearLabelsBy === 'end_year' ? endYear : startYear
}

export function fiscalYearLabel(slot: number, geometry: TimelineGeometry): string {
  return `FY${String(fiscalYearForSlot(slot, geometry) % 100).padStart(2, '0')}`
}

/* ----------------------------------------------------------- escalation -- */

function rateForYear(yearOffset: number, settings: CostSettings): number {
  const override = settings.rateOverrides.get(yearOffset)
  return (override ?? settings.escalationAnnualPercent) / 100
}

/**
 * The escalation multiplier for a point `yearsOut` years after `baseYear`.
 *
 * `compound_annual` is computed as a PRODUCT over years rather than
 * `(1 + r)^n`, which is what makes per-year overrides meaningful. A single
 * compound rate cannot express what an estimator actually knows — the next
 * year or two are forecastable and the back end of a fifteen-year plan is not
 * — so a project can pin specific years and let the rest fall back to the
 * default.
 *
 * A partial final year is applied fractionally, so escalation is continuous as
 * a bar is dragged rather than jumping at year boundaries.
 *
 * `stepped` is v1's "X% every N years" behaviour, preserved so that adopting
 * v2 does not silently re-price projects that already had escalation set.
 *
 * Negative `yearsOut` (a phase scheduled before the estimate's base year)
 * clamps to 1.0. De-escalating backwards would be arithmetically tidy and
 * commercially meaningless.
 */
export function escalationFactor(yearsOut: number, settings: CostSettings): number {
  if (!Number.isFinite(yearsOut) || yearsOut <= 0) return 1

  if (settings.escalationMode === 'stepped') {
    const step = Math.max(1, settings.escalationStepYears)
    const steps = Math.floor(yearsOut / step)
    return (1 + settings.escalationAnnualPercent / 100) ** steps
  }

  let factor = 1
  const wholeYears = Math.floor(yearsOut)

  for (let year = 0; year < wholeYears; year += 1) {
    factor *= 1 + rateForYear(year, settings)
  }

  const fraction = yearsOut - wholeYears
  if (fraction > 0) {
    factor *= (1 + rateForYear(wholeYears, settings)) ** fraction
  }

  return factor
}

/**
 * How far past `baseYear` a phase's escalation clock reads.
 *
 * Two offsets compose here and both matter:
 *   * where the phase sits on the timeline, read at the basis point, and
 *   * the gap between the estimate's base year and the timeline's anchor.
 *
 * The second is the one that is easy to forget. An estimate priced in 2026 and
 * used on a plan anchored at 2028 already carries two years of escalation
 * before anybody drags anything.
 */
export function phaseYearsOut(
  phase: Pick<Phase, 'startSlot' | 'durationSlots'>,
  settings: CostSettings,
  geometry: TimelineGeometry
): number {
  const basisSlot =
    settings.escalationBasis === 'midpoint'
      ? phase.startSlot + phase.durationSlots / 2
      : phase.startSlot

  const anchorOffset = geometry.startCalendarYear - settings.baseYear
  return anchorOffset + slotToYears(basisSlot, geometry.interval)
}

/* ------------------------------------------------------------ phase cost -- */

export type PhaseCost = {
  phase: Phase
  /** Package TPC × pctOfTpc, in base-year dollars. */
  baseCost: number
  escalationFactor: number
  escalatedCost: number
  /** Straight-line amortisation across the phase duration. This is the
   *  specified method: "Costs for each phase were amortized over the duration
   *  of each phase so that the total value of each phase were divided by the
   *  number of months in duration." */
  costPerSlot: number
  yearsOut: number
  /** True when the phase sits past the project's stated confidence horizon,
   *  so the UI can present a range instead of false precision. */
  beyondConfidenceHorizon: boolean
}

export function computePhaseCost(
  phase: Phase,
  packageTpcBase: number,
  settings: CostSettings,
  geometry: TimelineGeometry
): PhaseCost {
  const baseCost = packageTpcBase * (phase.pctOfTpc / 100)
  const yearsOut = phaseYearsOut(phase, settings, geometry)
  const factor = escalationFactor(yearsOut, settings)
  const escalatedCost = baseCost * factor
  const duration = Math.max(phase.durationSlots, Number.EPSILON)

  return {
    phase,
    baseCost,
    escalationFactor: factor,
    escalatedCost,
    costPerSlot: escalatedCost / duration,
    yearsOut,
    beyondConfidenceHorizon: yearsOut > settings.escalationConfidenceYears,
  }
}

/* ---------------------------------------------------------------- package -- */

export type PackageSummary = {
  input: PackageInput
  eccBase: number
  tpcBase: number
  phases: PhaseCost[]
  /** Sum of pctOfTpc across the package's phases. */
  allocatedPct: number
  /** True when `allocatedPct` is not 100 (within a cent's worth of rounding).
   *  Surfaced, never auto-corrected: silently rescaling a number a cost
   *  estimator typed is worse than showing them it is wrong. */
  allocationIsIncomplete: boolean
  totalBaseCost: number
  totalEscalatedCost: number
  /** Last slot at which a construction phase finishes — when this package's
   *  energy savings come online. Null when the package has no construction
   *  phase, in which case it never contributes savings. */
  energyOnsetSlot: number | null
}

const PCT_TOLERANCE = 1e-6

export function summarisePackage(
  input: PackageInput,
  phases: readonly Phase[],
  settings: CostSettings,
  geometry: TimelineGeometry
): PackageSummary {
  const tpcBase = input.eccBase * settings.tpcFactor

  const ordered = [...phases].sort((a, b) => a.sortOrder - b.sortOrder)
  const phaseCosts = ordered.map((phase) =>
    computePhaseCost(phase, tpcBase, settings, geometry)
  )

  const allocatedPct = ordered.reduce((sum, p) => sum + p.pctOfTpc, 0)

  const constructionEnds = ordered
    .filter((p) => p.kind === 'construction')
    .map((p) => p.startSlot + p.durationSlots)

  return {
    input,
    eccBase: input.eccBase,
    tpcBase,
    phases: phaseCosts,
    allocatedPct,
    allocationIsIncomplete: Math.abs(allocatedPct - 100) > PCT_TOLERANCE,
    totalBaseCost: phaseCosts.reduce((sum, p) => sum + p.baseCost, 0),
    totalEscalatedCost: phaseCosts.reduce((sum, p) => sum + p.escalatedCost, 0),
    energyOnsetSlot: constructionEnds.length > 0 ? Math.max(...constructionEnds) : null,
  }
}

/* ------------------------------------------------------- column rollups -- */

/**
 * How much of the integer slot `[slotIndex, slotIndex + 1)` a phase covers.
 *
 * Phases can sit on fractional slot boundaries (a drag at quarter zoom viewed
 * at year zoom, say), so this is an interval overlap rather than an integer
 * range check. Getting this wrong produces a column total that does not match
 * the sum of the bars above it, which is exactly the kind of discrepancy that
 * destroys trust in a costing tool.
 */
function slotOverlap(slotIndex: number, startSlot: number, durationSlots: number): number {
  const phaseStart = startSlot
  const phaseEnd = startSlot + durationSlots
  const overlapStart = Math.max(slotIndex, phaseStart)
  const overlapEnd = Math.min(slotIndex + 1, phaseEnd)
  return Math.max(0, overlapEnd - overlapStart)
}

export type SlotCost = {
  slotIndex: number
  baseTotal: number
  escalatedTotal: number
  escalationAmount: number
  fiscalYear: number
}

export function computeSlotCosts(
  summaries: readonly PackageSummary[],
  geometry: TimelineGeometry
): SlotCost[] {
  const count = slotCount(geometry.years, geometry.interval)

  return Array.from({ length: count }, (_, slotIndex) => {
    let baseTotal = 0
    let escalatedTotal = 0

    for (const summary of summaries) {
      for (const phaseCost of summary.phases) {
        const overlap = slotOverlap(
          slotIndex,
          phaseCost.phase.startSlot,
          phaseCost.phase.durationSlots
        )
        if (overlap <= 0) continue

        const share = overlap / Math.max(phaseCost.phase.durationSlots, Number.EPSILON)
        baseTotal += phaseCost.baseCost * share
        escalatedTotal += phaseCost.escalatedCost * share
      }
    }

    return {
      slotIndex,
      baseTotal,
      escalatedTotal,
      escalationAmount: escalatedTotal - baseTotal,
      fiscalYear: fiscalYearForSlot(slotIndex, geometry),
    }
  })
}

/** Annual totals keyed by fiscal year — what a capital plan actually gets
 *  presented as, and what the Excel export's summary sheet contains. */
export function computeFiscalYearTotals(
  slotCosts: readonly SlotCost[]
): Array<{ fiscalYear: number; baseTotal: number; escalatedTotal: number }> {
  const byYear = new Map<number, { baseTotal: number; escalatedTotal: number }>()

  for (const slot of slotCosts) {
    const entry = byYear.get(slot.fiscalYear) ?? { baseTotal: 0, escalatedTotal: 0 }
    entry.baseTotal += slot.baseTotal
    entry.escalatedTotal += slot.escalatedTotal
    byYear.set(slot.fiscalYear, entry)
  }

  return [...byYear.entries()]
    .map(([fiscalYear, totals]) => ({ fiscalYear, ...totals }))
    .sort((a, b) => a.fiscalYear - b.fiscalYear)
}

/* ---------------------------------------------------------------- energy -- */

export type EnergyPoint = {
  slotIndex: number
  /** Savings realised as of the END of this slot, after the interaction
   *  factor. */
  cumulativeSavings: number
  /** Baseline minus cumulative savings. Null when no baseline is set. */
  remainingConsumption: number | null
}

export type EnergySeries = {
  points: EnergyPoint[]
  baseline: number | null
  unitLabel: string
  /** Total savings once every package is in service — the floor the step chart
   *  descends to. */
  finalSavings: number
}

/**
 * The stepped savings series drawn under the timeline.
 *
 * Savings come online when a package's LAST CONSTRUCTION phase finishes.
 * Design phases deliver nothing — you do not save energy by drawing a boiler —
 * which is why `kind` is a closed set rather than free text.
 *
 * The result is a staircase: flat between completions, dropping at each one.
 * That is the shape Megan sketched, and it is also the conventional form for a
 * decarbonisation pathway chart.
 */
export function computeEnergySeries(
  summaries: readonly PackageSummary[],
  energy: EnergySettings,
  geometry: TimelineGeometry
): EnergySeries {
  const count = slotCount(geometry.years, geometry.interval)
  const factor = energy.interactionFactor

  const onsets = summaries
    .filter((s) => s.energyOnsetSlot !== null && s.input.energySavingsAnnual > 0)
    .map((s) => ({
      onsetSlot: s.energyOnsetSlot as number,
      savings: s.input.energySavingsAnnual * factor,
    }))

  const points: EnergyPoint[] = Array.from({ length: count }, (_, slotIndex) => {
    // `<= slotIndex + 1` because a package finishing anywhere inside this slot
    // is delivering savings by the end of it. Using `<= slotIndex` would delay
    // every step by one column relative to the bar that causes it, which reads
    // as a bug even though the totals are unchanged.
    const cumulativeSavings = onsets
      .filter((o) => o.onsetSlot <= slotIndex + 1)
      .reduce((sum, o) => sum + o.savings, 0)

    return {
      slotIndex,
      cumulativeSavings,
      remainingConsumption:
        energy.baselineAnnual === null
          ? null
          : Math.max(0, energy.baselineAnnual - cumulativeSavings),
    }
  })

  return {
    points,
    baseline: energy.baselineAnnual,
    unitLabel: energy.unitLabel,
    finalSavings: onsets.reduce((sum, o) => sum + o.savings, 0),
  }
}

/* ------------------------------------------------------ dependency graph -- */

export class DependencyCycleError extends Error {
  // Written out rather than as a TypeScript parameter property, because
  // Node's type-stripping runs the unit tests directly from source and does
  // not support that syntax.
  readonly cycle: string[]

  constructor(cycle: string[]) {
    super(`Dependency cycle: ${cycle.join(' → ')}`)
    this.name = 'DependencyCycleError'
    this.cycle = cycle
  }
}

/**
 * Kahn's algorithm. Returns phase ids in an order where every predecessor
 * precedes its successors.
 *
 * Throws `DependencyCycleError` rather than returning a partial order. The
 * database refuses cycles at write time, so reaching this is a bug or a
 * stale client — either way the caller needs to know, not silently schedule
 * a subset.
 */
export function topologicalOrder(
  phaseIds: readonly string[],
  dependencies: readonly PhaseDependency[]
): string[] {
  const inDegree = new Map<string, number>(phaseIds.map((id) => [id, 0]))
  const adjacency = new Map<string, string[]>(phaseIds.map((id) => [id, []]))

  for (const dep of dependencies) {
    if (!inDegree.has(dep.predecessorPhaseId) || !inDegree.has(dep.successorPhaseId)) {
      // A link pointing outside the supplied set — a phase from another
      // package that was not loaded. Skip rather than throw; the caller is
      // entitled to compute over a subset.
      continue
    }
    adjacency.get(dep.predecessorPhaseId)!.push(dep.successorPhaseId)
    inDegree.set(dep.successorPhaseId, inDegree.get(dep.successorPhaseId)! + 1)
  }

  const queue = phaseIds.filter((id) => inDegree.get(id) === 0)
  const order: string[] = []

  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adjacency.get(id) ?? []) {
      const degree = inDegree.get(next)! - 1
      inDegree.set(next, degree)
      if (degree === 0) queue.push(next)
    }
  }

  if (order.length !== phaseIds.length) {
    const stuck = phaseIds.filter((id) => !order.includes(id))
    throw new DependencyCycleError(stuck)
  }

  return order
}

/**
 * The earliest start a dependency permits its successor.
 *
 * The four PDM link types, each one line:
 *   FS  successor starts after predecessor finishes    (~all real usage)
 *   SS  successor starts after predecessor starts
 *   FF  successor finishes after predecessor finishes
 *   SF  successor finishes after predecessor starts
 *
 * FF and SF constrain the successor's FINISH, so they are converted to a start
 * constraint by subtracting the successor's own duration.
 */
export function constraintStart(
  depType: DependencyType,
  lagSlots: number,
  predecessorStart: number,
  predecessorDuration: number,
  successorDuration: number
): number {
  const predecessorEnd = predecessorStart + predecessorDuration

  switch (depType) {
    case 'FS':
      return predecessorEnd + lagSlots
    case 'SS':
      return predecessorStart + lagSlots
    case 'FF':
      return predecessorEnd + lagSlots - successorDuration
    case 'SF':
      return predecessorStart + lagSlots - successorDuration
    default:
      return predecessorEnd + lagSlots
  }
}

/**
 * Forward pass: push any successor that a move has left in violation.
 *
 * Pushes LATER only, never earlier. That is deliberate. A schedule where every
 * task is crammed against its predecessor is an as-soon-as-possible schedule,
 * and planners put slack in on purpose — "we're going to put this on the
 * shelf, we're going to wait until this because we already have a couple other
 * projects in the pipeline". Auto-pulling would silently delete a decision
 * someone made.
 *
 * Returns a new map; does not mutate the input.
 */
export function propagateDependencies(
  phases: readonly Phase[],
  dependencies: readonly PhaseDependency[]
): Map<string, Phase> {
  const byId = new Map(phases.map((p) => [p.id, { ...p }]))
  const order = topologicalOrder(
    phases.map((p) => p.id),
    dependencies
  )

  const incoming = new Map<string, PhaseDependency[]>()
  for (const dep of dependencies) {
    if (!byId.has(dep.predecessorPhaseId) || !byId.has(dep.successorPhaseId)) continue
    incoming.set(dep.successorPhaseId, [
      ...(incoming.get(dep.successorPhaseId) ?? []),
      dep,
    ])
  }

  for (const id of order) {
    const phase = byId.get(id)!
    const deps = incoming.get(id) ?? []
    if (deps.length === 0) continue

    let earliest = phase.startSlot
    for (const dep of deps) {
      const predecessor = byId.get(dep.predecessorPhaseId)!
      earliest = Math.max(
        earliest,
        constraintStart(
          dep.depType,
          dep.lagSlots,
          predecessor.startSlot,
          predecessor.durationSlots,
          phase.durationSlots
        )
      )
    }

    if (earliest > phase.startSlot) {
      // Duration is preserved even when locked — this moves the bar, it does
      // not stretch it. That is the whole meaning of "fixed duration".
      byId.set(id, { ...phase, startSlot: Math.max(0, earliest) })
    }
  }

  return byId
}

export type DependencyViolation = {
  dependency: PhaseDependency
  predecessor: Phase
  successor: Phase
  requiredStart: number
  actualStart: number
}

/**
 * Links that are currently unsatisfied.
 *
 * Propagation keeps the schedule consistent when a bar is dragged, but a
 * settings change can invalidate links without anything being dragged —
 * shortening the timeline, for instance. The UI lists these rather than
 * silently repairing them, because a repair moves work the user placed.
 */
export function findDependencyViolations(
  phases: readonly Phase[],
  dependencies: readonly PhaseDependency[]
): DependencyViolation[] {
  const byId = new Map(phases.map((p) => [p.id, p]))
  const violations: DependencyViolation[] = []

  for (const dep of dependencies) {
    const predecessor = byId.get(dep.predecessorPhaseId)
    const successor = byId.get(dep.successorPhaseId)
    if (!predecessor || !successor) continue

    const requiredStart = constraintStart(
      dep.depType,
      dep.lagSlots,
      predecessor.startSlot,
      predecessor.durationSlots,
      successor.durationSlots
    )

    if (successor.startSlot < requiredStart - PCT_TOLERANCE) {
      violations.push({
        dependency: dep,
        predecessor,
        successor,
        requiredStart,
        actualStart: successor.startSlot,
      })
    }
  }

  return violations
}

/**
 * Whether adding `predecessor → successor` would close a loop.
 *
 * The database refuses cycles too, but a client-side check means the UI can
 * refuse the drag with an explanation instead of letting the user complete an
 * interaction and then showing them a Postgres error.
 */
export function wouldCreateCycle(
  predecessorPhaseId: string,
  successorPhaseId: string,
  dependencies: readonly PhaseDependency[]
): boolean {
  if (predecessorPhaseId === successorPhaseId) return true

  const adjacency = new Map<string, string[]>()
  for (const dep of dependencies) {
    adjacency.set(dep.predecessorPhaseId, [
      ...(adjacency.get(dep.predecessorPhaseId) ?? []),
      dep.successorPhaseId,
    ])
  }

  // Can we already reach the proposed predecessor from the proposed successor?
  // If so, the new edge closes the loop.
  const seen = new Set<string>()
  const stack = [successorPhaseId]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === predecessorPhaseId) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(adjacency.get(current) ?? []))
  }

  return false
}

/* ------------------------------------------------------------- defaults -- */

/** Mirrors the column defaults in migration 0006. Used when a project has no
 *  settings row yet, which is a supported state — nothing has to be created up
 *  front for the app to render. */
export const DEFAULT_COST_SETTINGS: CostSettings = {
  tpcFactor: 1.33,
  baseYear: new Date().getUTCFullYear(),
  escalationMode: 'compound_annual',
  escalationAnnualPercent: 4,
  escalationStepYears: 5,
  escalationBasis: 'midpoint',
  escalationConfidenceYears: 5,
  rateOverrides: new Map(),
}

export const DEFAULT_ENERGY_SETTINGS: EnergySettings = {
  unitLabel: 'kBtu/yr',
  baselineAnnual: null,
  interactionFactor: 1,
}
