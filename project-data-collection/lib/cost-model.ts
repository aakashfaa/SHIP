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
  /** Months after the timeline anchor (January of `startCalendarYear`), and
   *  length in months. ALWAYS months, whatever the zoom (D-1, M-01): the
   *  zoom is a view of the schedule, never part of it. These used to be
   *  "slots", whose size the zoom slider set, so zooming re-priced the plan
   *  ($78.7M at Month vs $366M at Year on the same rows). May be fractional
   *  for legacy rows; the engine handles any non-negative value. */
  startMonth: number
  durationMonths: number
  /** Fixed Duration in the MS Project sense: the bar's length is constant, its
   *  position is not. A locked phase can still be moved. */
  durationLocked: boolean
}

export type PhaseDependency = {
  id: string
  predecessorPhaseId: string
  successorPhaseId: string
  depType: DependencyType
  /** In months. May be negative, which is a lead — "bidding can overlap
   *  the tail of CD". */
  lagMonths: number
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
  /** The VIEW: how many months one on-screen column spans. Only column
   *  layout (`computeSlotCosts`, `computeEnergySeries`, labels) reads it.
   *  No money function does -- headline, package, phase and fiscal-year
   *  totals are identical at every zoom, and tests/unit/waveb-months.test.ts
   *  pins that. */
  interval: TimelineInterval
  /** Horizon length in years. Pass it through `resolveHorizon` first: that
   *  is the one rule (M-27) that stretches it to cover every phase. */
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
 * How many calendar years one timeline column spans at a given zoom.
 *
 * Mirrors `getSlotStartYear` in the v1 Timeline tab, which maps slot index to
 * year as index/12, index/4, index, index*2, index*3, index*5.
 *
 * Since D-1 a "slot" is purely a column on screen. Schedules are stored in
 * months (`Phase.startMonth` / `durationMonths`), and a column is just "N
 * months wide" for the current zoom -- see `monthsPerSlot`.
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

/**
 * How many months one column spans at a given zoom. Integers on purpose
 * (1, 3, 12, 24, 36, 60) so month <-> column conversions are exact; deriving
 * this from `yearsPerSlot * 12` would bring 1/12 floating-point error into
 * every bar position.
 *
 * This is also the factor migration 0020 multiplied every stored slot by,
 * per project, when schedules moved to months.
 */
export function monthsPerSlot(interval: TimelineInterval): number {
  switch (interval) {
    case 'monthly':
      return 1
    case 'quarterly':
      return 3
    case 'yearly':
      return 12
    case 'bi-yearly':
      return 24
    case '3-yearly':
      return 36
    case '5-yearly':
      return 60
    default:
      return 12
  }
}

export function slotToYears(slot: number, interval: TimelineInterval): number {
  return slot * yearsPerSlot(interval)
}

/** Column index -> months from the anchor. Fractional in, fractional out. */
export function slotToMonths(slot: number, interval: TimelineInterval): number {
  return slot * monthsPerSlot(interval)
}

/** Months from the anchor -> (fractional) column index at this zoom. A phase
 *  that doesn't start on a column boundary at a coarse zoom lands part-way
 *  into a column and is drawn there, proportionally. */
export function monthsToSlots(months: number, interval: TimelineInterval): number {
  return months / monthsPerSlot(interval)
}

/** Columns needed to show `years` at this zoom. A partial last column (10
 *  years at 3-year zoom) is shown whole rather than dropped. */
export function slotCount(years: number, interval: TimelineInterval): number {
  return Math.ceil((years * 12) / monthsPerSlot(interval) - 1e-9)
}

/* -------------------------------------------------------------- horizon -- */

export type Horizon = {
  /** The geometry every total, column and export row must use. */
  geometry: TimelineGeometry
  /** What the project's "Timeline Length" setting says. */
  configuredYears: number
  /** True when a phase runs past `configuredYears`, so the horizon was
   *  stretched to include it. The screen and the workbook say so in words. */
  extended: boolean
}

/**
 * THE horizon rule (M-27), shared by the Timeline and every export.
 *
 * The rule is EXTEND: the horizon runs to the end of the furthest phase,
 * rounded up to a whole year, and is never shorter than the project's
 * Timeline Length. The alternative -- keep the horizon and add a "Scheduled
 * beyond the timeline: $X" line -- was rejected because it leaves money that
 * has no column, no fiscal year and no energy step, so every report needs a
 * special case and the FY table can no longer be checked against the
 * headline by adding it up. Extending means every dollar in the headline
 * sits in exactly one column and one fiscal year, on screen and in the
 * workbook, and "Annual Cost Summary == headline" (spec §6 check 4) holds by
 * construction.
 *
 * Before this the headline and package totals counted a phase past the end
 * but the columns, the FY strip and the Excel Annual Summary silently
 * dropped it ($7.4M of $14.8M on a test plan).
 */
export function resolveHorizon(
  geometry: TimelineGeometry,
  phases: ReadonlyArray<Pick<Phase, 'startMonth' | 'durationMonths'>>
): Horizon {
  const configuredYears = Math.max(1, Math.ceil(geometry.years))
  let furthestMonth = 0
  for (const phase of phases) {
    const end = phase.startMonth + Math.max(phase.durationMonths, 0)
    if (Number.isFinite(end) && end > furthestMonth) furthestMonth = end
  }
  // The tolerance stops a float like 120.0000000001 adding a whole year.
  const neededYears = Math.ceil(furthestMonth / 12 - 1e-9)
  const years = Math.max(configuredYears, neededYears)
  return {
    geometry: years === geometry.years ? geometry : { ...geometry, years },
    configuredYears,
    extended: years > configuredYears,
  }
}

/* --------------------------------------------------------- fiscal years -- */

function fiscalStartIndex(geometry: TimelineGeometry): number {
  return Math.min(Math.max(Math.round(geometry.fiscalYearStartMonth), 1), 12) - 1
}

/**
 * The fiscal year a month falls in, where `month` counts whole months from
 * January of `startCalendarYear` (month 0).
 *
 * Worked example with the Massachusetts default (start month 7, labelled by
 * end year): July 2028 is in FY2029, and June 2028 is in FY2028 — because
 * FY2028 ran Jul 2027 – Jun 2028.
 */
export function fiscalYearForMonth(month: number, geometry: TimelineGeometry): number {
  const absoluteMonth = Math.floor(month)

  const calendarYear = geometry.startCalendarYear + Math.floor(absoluteMonth / 12)
  // 0-based month within that calendar year.
  const monthIndex = ((absoluteMonth % 12) + 12) % 12
  const fyStartIndex = fiscalStartIndex(geometry)

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

/**
 * The FISCAL quarter (1-4) a month falls in (D-11). Q1 is the first three
 * months of the fiscal year -- Jul-Sep for a July fiscal year, which is how
 * the client's own budget sheets head their quarters -- not Jan-Mar.
 */
export function fiscalQuarterForMonth(month: number, geometry: TimelineGeometry): number {
  const monthIndex = ((Math.floor(month) % 12) + 12) % 12
  const monthsIntoFiscalYear = (monthIndex - fiscalStartIndex(geometry) + 12) % 12
  return Math.floor(monthsIntoFiscalYear / 3) + 1
}

/** The fiscal year a column's FIRST month falls in. A column can span
 *  several fiscal years at coarse zoom; `slotFiscalLabel` says so. */
export function fiscalYearForSlot(slot: number, geometry: TimelineGeometry): number {
  return fiscalYearForMonth(slotToMonths(slot, geometry.interval), geometry)
}

/** `FY29` from 2029. Two digits, wrapping at a century, as the client writes it. */
export function formatFiscalYear(year: number): string {
  return `FY${String(((year % 100) + 100) % 100).padStart(2, '0')}`
}

export function fiscalYearLabel(slot: number, geometry: TimelineGeometry): string {
  return formatFiscalYear(fiscalYearForSlot(slot, geometry))
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function twoDigitYear(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, '0')
}

/** "Jan".."Dec" for a 0-based calendar month index (wraps). */
export function calendarMonthName(monthIndex: number): string {
  return MONTH_NAMES[((Math.floor(monthIndex) % 12) + 12) % 12]
}

/** "Jul 2027" for a month offset from the anchor. */
export function monthLabel(month: number, geometry: TimelineGeometry): string {
  const whole = Math.floor(month)
  const year = geometry.startCalendarYear + Math.floor(whole / 12)
  return `${MONTH_NAMES[((whole % 12) + 12) % 12]} ${year}`
}

/**
 * The calendar span of a column: "Jan 26", "Jan–Mar 26", "CY2026",
 * "CY2026–28". Columns are calendar-anchored (column 0 starts in January of
 * the start year), so at Year zoom a column is a CALENDAR year and is
 * labelled as one (D-11). Heading it with a single FY was the M-26 bug
 * whenever the fiscal year doesn't start in January.
 */
export function slotCalendarLabel(slot: number, geometry: TimelineGeometry): string {
  const per = monthsPerSlot(geometry.interval)
  const first = slot * per
  const last = first + per - 1
  const yearOf = (m: number) => geometry.startCalendarYear + Math.floor(m / 12)
  const monthName = (m: number) => MONTH_NAMES[((m % 12) + 12) % 12]

  if (per === 1) return `${monthName(first)} ${twoDigitYear(yearOf(first))}`
  if (per < 12) return `${monthName(first)}–${monthName(last)} ${twoDigitYear(yearOf(first))}`
  if (per === 12) return `CY${yearOf(first)}`
  return `CY${yearOf(first)}–${twoDigitYear(yearOf(last))}`
}

/**
 * The fiscal span of a column, shown under its calendar label: "FY26 Q3" for
 * a month or quarter, "FY26–27" for a calendar year that straddles two fiscal
 * years, "FY26–FY31" for a multi-year block. Quarters are FISCAL quarters.
 */
export function slotFiscalLabel(slot: number, geometry: TimelineGeometry): string {
  const per = monthsPerSlot(geometry.interval)
  const first = slot * per
  const last = first + per - 1
  const fyFirst = fiscalYearForMonth(first, geometry)
  const fyLast = fiscalYearForMonth(last, geometry)

  if (per < 12) {
    const qFirst = fiscalQuarterForMonth(first, geometry)
    const qLast = fiscalQuarterForMonth(last, geometry)
    if (fyFirst === fyLast && qFirst === qLast) return `${formatFiscalYear(fyFirst)} Q${qFirst}`
    if (fyFirst === fyLast) return `${formatFiscalYear(fyFirst)} Q${qFirst}–Q${qLast}`
    return `${formatFiscalYear(fyFirst)} Q${qFirst}–${formatFiscalYear(fyLast)} Q${qLast}`
  }
  if (fyFirst === fyLast) return formatFiscalYear(fyFirst)
  if (fyLast === fyFirst + 1) return `${formatFiscalYear(fyFirst)}–${twoDigitYear(fyLast)}`
  return `${formatFiscalYear(fyFirst)}–${formatFiscalYear(fyLast)}`
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
  phase: Pick<Phase, 'startMonth' | 'durationMonths'>,
  settings: CostSettings,
  geometry: Pick<TimelineGeometry, 'startCalendarYear'>
): number {
  const basisMonth =
    settings.escalationBasis === 'midpoint'
      ? phase.startMonth + phase.durationMonths / 2
      : phase.startMonth

  // Months, never columns: the zoom is not an input to any price (M-01).
  const anchorOffset = geometry.startCalendarYear - settings.baseYear
  return anchorOffset + basisMonth / 12
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
   *  number of months in duration." Per MONTH, literally, since D-1. */
  costPerMonth: number
  yearsOut: number
  /** True when the phase sits past the project's stated confidence horizon,
   *  so the UI can present a range instead of false precision. */
  beyondConfidenceHorizon: boolean
}

export function computePhaseCost(
  phase: Phase,
  packageTpcBase: number,
  settings: CostSettings,
  geometry: Pick<TimelineGeometry, 'startCalendarYear'>
): PhaseCost {
  const baseCost = packageTpcBase * (phase.pctOfTpc / 100)
  const yearsOut = phaseYearsOut(phase, settings, geometry)
  const factor = escalationFactor(yearsOut, settings)
  const escalatedCost = baseCost * factor
  const duration = Math.max(phase.durationMonths, Number.EPSILON)

  return {
    phase,
    baseCost,
    escalationFactor: factor,
    escalatedCost,
    costPerMonth: escalatedCost / duration,
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
  /** Month (from the anchor) at which the last construction phase finishes —
   *  when this package's energy savings come online. Null when the package
   *  has no construction phase, in which case it never contributes savings. */
  energyOnsetMonth: number | null
}

const PCT_TOLERANCE = 1e-6

export function summarisePackage(
  input: PackageInput,
  phases: readonly Phase[],
  settings: CostSettings,
  geometry: Pick<TimelineGeometry, 'startCalendarYear'>
): PackageSummary {
  const tpcBase = input.eccBase * settings.tpcFactor

  const ordered = [...phases].sort((a, b) => a.sortOrder - b.sortOrder)
  const phaseCosts = ordered.map((phase) =>
    computePhaseCost(phase, tpcBase, settings, geometry)
  )

  const allocatedPct = ordered.reduce((sum, p) => sum + p.pctOfTpc, 0)

  const constructionEnds = ordered
    .filter((p) => p.kind === 'construction')
    .map((p) => p.startMonth + p.durationMonths)

  return {
    input,
    eccBase: input.eccBase,
    tpcBase,
    phases: phaseCosts,
    allocatedPct,
    allocationIsIncomplete: Math.abs(allocatedPct - 100) > PCT_TOLERANCE,
    totalBaseCost: phaseCosts.reduce((sum, p) => sum + p.baseCost, 0),
    totalEscalatedCost: phaseCosts.reduce((sum, p) => sum + p.escalatedCost, 0),
    energyOnsetMonth: constructionEnds.length > 0 ? Math.max(...constructionEnds) : null,
  }
}

/* ------------------------------------------------------- column rollups -- */

/** Length of the overlap of `[aStart, aEnd)` and `[bStart, bEnd)`, in months. */
function overlapMonths(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

export type SlotCost = {
  slotIndex: number
  baseTotal: number
  escalatedTotal: number
  escalationAmount: number
  /** The fiscal year of the column's first month; a coarse column can span
   *  several -- see `slotFiscalLabel`. */
  fiscalYear: number
}

/**
 * Money per on-screen column.
 *
 * A column covers months `[slot * N, (slot + 1) * N)` at the current zoom, and
 * each phase contributes its straight-line cost for exactly the months it
 * shares with that column. Phases need not sit on column boundaries -- a
 * 6-month phase at Year zoom puts half a year's worth in one column -- so this
 * is an interval overlap in months rather than an integer range check. The
 * column totals therefore add up to the same grand total at every zoom, and
 * to the sum of the bars above them.
 *
 * Pass `resolveHorizon(...).geometry` so no phase falls past the last column.
 */
export function computeSlotCosts(
  summaries: readonly PackageSummary[],
  geometry: TimelineGeometry
): SlotCost[] {
  const count = slotCount(geometry.years, geometry.interval)
  const per = monthsPerSlot(geometry.interval)

  return Array.from({ length: count }, (_, slotIndex) => {
    const columnStart = slotIndex * per
    const columnEnd = columnStart + per
    let baseTotal = 0
    let escalatedTotal = 0

    for (const summary of summaries) {
      for (const phaseCost of summary.phases) {
        const { startMonth, durationMonths } = phaseCost.phase
        const overlap = overlapMonths(
          columnStart,
          columnEnd,
          startMonth,
          startMonth + durationMonths
        )
        if (overlap <= 0) continue

        const share = overlap / Math.max(durationMonths, Number.EPSILON)
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

export type FiscalQuarterTotal = {
  /** Fiscal quarter, 1-4 (Q1 = the fiscal year's first three months). */
  quarter: number
  baseTotal: number
  escalatedTotal: number
}

export type FiscalYearTotal = {
  fiscalYear: number
  baseTotal: number
  escalatedTotal: number
  /** Always four entries, Q1..Q4, zero where nothing is scheduled. */
  quarters: FiscalQuarterTotal[]
}

/**
 * Totals by fiscal year and fiscal quarter, at MONTHLY resolution (M-26,
 * D-11) -- the ONE function the Timeline's "By fiscal year" strip and the
 * Excel Annual Cost Summary both call.
 *
 * Every phase's straight-line cost is split month by month and each month
 * lands in its own fiscal year and quarter. The old version bucketed whole
 * columns by the FY of the column's START, so at Year zoom all of a Jan-Dec
 * spend landed in one FY (half of it belongs to the next one under a July
 * fiscal year), and at 3/5-year zoom whole multi-year blocks did.
 *
 * Nothing here reads the zoom. Every month of every phase is counted, so the
 * FY totals always add up to the headline total; every fiscal year the
 * horizon touches is listed, including empty ones, so a gap in the plan
 * shows as a $0 year rather than a missing row.
 */
export function computeFiscalYearTotals(
  summaries: readonly PackageSummary[],
  geometry: TimelineGeometry
): FiscalYearTotal[] {
  const byYear = new Map<number, FiscalYearTotal>()
  const entryFor = (fiscalYear: number): FiscalYearTotal => {
    let entry = byYear.get(fiscalYear)
    if (!entry) {
      entry = {
        fiscalYear,
        baseTotal: 0,
        escalatedTotal: 0,
        quarters: [1, 2, 3, 4].map((quarter) => ({ quarter, baseTotal: 0, escalatedTotal: 0 })),
      }
      byYear.set(fiscalYear, entry)
    }
    return entry
  }

  const horizonMonths = Math.max(0, Math.round(geometry.years * 12))
  for (let month = 0; month < horizonMonths; month += 1) {
    entryFor(fiscalYearForMonth(month, geometry))
  }

  for (const summary of summaries) {
    for (const phaseCost of summary.phases) {
      const { startMonth, durationMonths } = phaseCost.phase
      const end = startMonth + durationMonths
      const duration = Math.max(durationMonths, Number.EPSILON)
      for (let month = Math.floor(startMonth); month < end; month += 1) {
        const overlap = overlapMonths(month, month + 1, startMonth, end)
        if (overlap <= 0) continue
        const share = overlap / duration
        const base = phaseCost.baseCost * share
        const escalated = phaseCost.escalatedCost * share

        const entry = entryFor(fiscalYearForMonth(month, geometry))
        entry.baseTotal += base
        entry.escalatedTotal += escalated
        const quarter = entry.quarters[fiscalQuarterForMonth(month, geometry) - 1]
        quarter.baseTotal += base
        quarter.escalatedTotal += escalated
      }
    }
  }

  return [...byYear.values()].sort((a, b) => a.fiscalYear - b.fiscalYear)
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

function energyOnsets(summaries: readonly PackageSummary[], energy: EnergySettings) {
  return summaries
    .filter((s) => s.energyOnsetMonth !== null && s.input.energySavingsAnnual > 0)
    .map((s) => ({
      onsetMonth: s.energyOnsetMonth as number,
      savings: s.input.energySavingsAnnual * energy.interactionFactor,
    }))
}

/**
 * The stepped savings series drawn under the timeline, one point per column.
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
  const per = monthsPerSlot(geometry.interval)
  const onsets = energyOnsets(summaries, energy)

  const points: EnergyPoint[] = Array.from({ length: count }, (_, slotIndex) => {
    // A package finishing anywhere inside this column is delivering savings
    // by the end of it. Comparing against the column's START would delay
    // every step by one column relative to the bar that causes it, which
    // reads as a bug even though the totals are unchanged.
    const columnEndMonth = (slotIndex + 1) * per
    const cumulativeSavings = onsets
      .filter((o) => o.onsetMonth <= columnEndMonth + 1e-9)
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

export type FiscalYearEnergy = {
  fiscalYear: number
  /** Savings in service by the END of this fiscal year. */
  cumulativeSavings: number
  remainingConsumption: number | null
}

/**
 * The same staircase, one row per fiscal year, for the export's Energy
 * Summary. Read at each fiscal year's end, from months -- so, like every other
 * exported figure, it no longer depends on the zoom the exporter happened to
 * have open (it used to be one row per column, labelled with that column's
 * starting FY, so a 5-year zoom produced two rows and a monthly one 180).
 */
export function computeEnergyByFiscalYear(
  summaries: readonly PackageSummary[],
  energy: EnergySettings,
  geometry: TimelineGeometry
): FiscalYearEnergy[] {
  const onsets = energyOnsets(summaries, energy)
  const horizonMonths = Math.max(0, Math.round(geometry.years * 12))

  // The month offset just past the end of each fiscal year in the horizon.
  const endOf = new Map<number, number>()
  for (let month = 0; month < horizonMonths; month += 1) {
    endOf.set(fiscalYearForMonth(month, geometry), month + 1)
  }

  return [...endOf.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fiscalYear, endMonth]) => {
      const cumulativeSavings = onsets
        .filter((o) => o.onsetMonth <= endMonth + 1e-9)
        .reduce((sum, o) => sum + o.savings, 0)
      return {
        fiscalYear,
        cumulativeSavings,
        remainingConsumption:
          energy.baselineAnnual === null
            ? null
            : Math.max(0, energy.baselineAnnual - cumulativeSavings),
      }
    })
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
 *
 * All four arguments and the result are in months (D-1).
 */
export function constraintStart(
  depType: DependencyType,
  lagMonths: number,
  predecessorStart: number,
  predecessorDuration: number,
  successorDuration: number
): number {
  const predecessorEnd = predecessorStart + predecessorDuration

  switch (depType) {
    case 'FS':
      return predecessorEnd + lagMonths
    case 'SS':
      return predecessorStart + lagMonths
    case 'FF':
      return predecessorEnd + lagMonths - successorDuration
    case 'SF':
      return predecessorStart + lagMonths - successorDuration
    default:
      return predecessorEnd + lagMonths
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

    let earliest = phase.startMonth
    for (const dep of deps) {
      const predecessor = byId.get(dep.predecessorPhaseId)!
      earliest = Math.max(
        earliest,
        constraintStart(
          dep.depType,
          dep.lagMonths,
          predecessor.startMonth,
          predecessor.durationMonths,
          phase.durationMonths
        )
      )
    }

    if (earliest > phase.startMonth) {
      // Duration is preserved even when locked — this moves the bar, it does
      // not stretch it. That is the whole meaning of "fixed duration".
      byId.set(id, { ...phase, startMonth: Math.max(0, earliest) })
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
      dep.lagMonths,
      predecessor.startMonth,
      predecessor.durationMonths,
      successor.durationMonths
    )

    if (successor.startMonth < requiredStart - PCT_TOLERANCE) {
      violations.push({
        dependency: dep,
        predecessor,
        successor,
        requiredStart,
        actualStart: successor.startMonth,
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

/**
 * A FIXED stand-in base year for rendering before a project's real settings
 * have loaded (or, before migration 0018, for a project that has none).
 *
 * This used to be `new Date().getUTCFullYear()`, which made every total
 * re-price itself on 1 January with nobody touching the project (M-25:
 * bsb2301 dropped $3.02M overnight on 2027-01-01). A constant cannot drift.
 * It is still NOT a real setting: anything that produces a deliverable (the
 * Excel export) refuses outright when the project's base year is missing --
 * see `ExportBlockedError` in lib/export/report-data.ts -- and the Timeline
 * labels a stand-in as such. Never use this as a project's actual year.
 */
export const STAND_IN_BASE_YEAR = 2026

/** Mirrors the column defaults in migration 0006, except `baseYear` -- see
 *  STAND_IN_BASE_YEAR above. Projects always have a settings row after
 *  migration 0018; this covers the moment before it has loaded. */
export const DEFAULT_COST_SETTINGS: CostSettings = {
  tpcFactor: 1.33,
  baseYear: STAND_IN_BASE_YEAR,
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

/* ------------------------------------------------------ scenario overlay -- */

/** The movable part of a phase, as a what-if stores it. */
export type PhasePlacement = {
  id: string
  startMonth: number
  durationMonths: number
  pctOfTpc: number
  durationLocked: boolean
}

/**
 * Lays a what-if's placements over the live phases: every phase the scenario
 * holds takes the scenario's start, duration, % and lock; every other phase
 * is returned unchanged, and phases the scenario mentions that no longer
 * exist are ignored (they were deleted from the live plan).
 *
 * This is the ONE overlay rule. The Timeline (TimelineTab's
 * `effectivePhases`) and the Excel export (M-24) must both price a what-if
 * through it, or the screen, the printed PDF and the workbook disagree --
 * which is exactly what happened when the export ignored scenarios.
 */
export function applyScenarioOverlay<T extends PhasePlacement>(
  phases: readonly T[],
  placements: readonly PhasePlacement[]
): T[] {
  if (placements.length === 0) return phases.slice()
  const byId = new Map(placements.map((placement) => [placement.id, placement]))
  return phases.map((phase) => {
    const moved = byId.get(phase.id)
    if (!moved) return phase
    return {
      ...phase,
      startMonth: moved.startMonth,
      durationMonths: moved.durationMonths,
      pctOfTpc: moved.pctOfTpc,
      durationLocked: moved.durationLocked,
    }
  })
}
