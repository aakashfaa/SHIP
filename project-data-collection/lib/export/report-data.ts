/**
 * Server-side data shaping for the Excel and PDF exports.
 *
 * One function, `buildProjectReportData`, loads every domain object a report
 * needs and runs it through `lib/cost-model.ts` — the same pure engine the
 * Timeline tab calls — so the numbers in the export can never disagree with
 * what a user sees on screen or between the two export formats. Nothing here
 * re-derives a figure the engine already computes.
 *
 * This file talks to Supabase directly with the SERVER (RLS-respecting)
 * client rather than going through `lib/store.ts`, because that module is
 * built exclusively on the browser client (`getSupabaseBrowserClient`) and
 * cannot run in a route handler. The row shapes and the row->domain mappers
 * are still shared with `lib/store.ts` via `lib/mappers.ts`, which is pure
 * and has no client binding, so the two data-access paths cannot drift on
 * what a column means — only on how the request gets made.
 *
 * COMMERCIAL CONSTRAINT — READ BEFORE ADDING A FIELD (spec R8.3)
 * ----------------------------------------------------------------
 * Neither export may include cost parameters, escalation settings, phase
 * percentages, or anything else that reveals the pricing model. This is a
 * deliberate decision by the client, not an oversight:
 *
 *   "we're not giving away the programming behind it per se. It becomes
 *    more of a deliverable." — Steve
 *   "they'll turn around and give it to some other architect. So we don't
 *    want to." — Megan
 *
 * Concretely, DO NOT add to any exported sheet:
 *   - `tpc_factor` (or the package's `eccBase`/`tpcBase` PAIR — showing both
 *     together lets a reader recover tpc_factor by division; only one of
 *     them, if either, may ever appear)
 *   - escalation rate, mode, basis, step-years, confidence-years
 *   - `pct_of_tpc` on any phase
 *   - the energy interaction factor
 *
 * What IS the deliverable and belongs in the export: escalated dollar
 * totals (per phase, per package, per fiscal year), the schedule itself
 * (start/duration), and the raw line-item/energy data the client typed in.
 * If you're unsure whether a new field crosses the line, don't add it —
 * ask, the way this file's author had to.
 */

import type { ShipSupabaseClient } from '../supabase/client'
import {
  ECC_COLUMN,
  UNREADABLE_CELL,
  eccCell,
  fieldCell,
  fieldColumn,
  type ReportCellValue,
  type ReportColumn,
} from './line-item-cells'
import { parseCostAmount, parseCostInput, parseQuantity, parseQuantityInput } from '../costs'
import { orderedVisibleFields } from '../form-values'
import {
  DEFAULT_ENERGY_SETTINGS,
  applyScenarioOverlay,
  computeEnergyByFiscalYear,
  computeFiscalYearTotals,
  fiscalYearForMonth,
  formatFiscalYear,
  monthLabel,
  resolveHorizon,
  summarisePackage,
  type CostSettings,
  type EnergySettings,
  type PackageInput,
  type PackageSummary,
  type Phase,
  type TimelineGeometry,
} from '../cost-model'
import {
  rowToChunkPhase,
  rowToChunkProject,
  rowToCostSettings,
  rowToEnergySettings,
  rowToFormField,
  rowToLineItem,
  rowToProject,
  rowToScenario,
  rowToTimelineSettings,
  type ChunkPhaseRow,
  type ChunkProjectRow,
  type EscalationRateOverrideRow,
  type FormFieldRow,
  type LineItemRow,
  type ProjectCostSettingsRow,
  type ProjectEnergySettingsRow,
  type ProjectRow,
  type ScenarioRow,
  type TimelineSettingsRow,
} from '../mappers'
import type {
  ChunkPhase,
  ChunkProject,
  FormField,
  LineItem,
  Project,
  ProjectCostSettings,
  ProjectEnergySettings,
  ProjectTimelineSettings,
  Scenario,
} from '../types'

/**
 * The export cannot be produced as asked, for a reason the caller can fix
 * (missing settings, a what-if that no longer exists). Carries an HTTP
 * status so the route can answer with it instead of a generic 500.
 */
export class ExportBlockedError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ExportBlockedError'
    this.status = status
  }
}

/* ------------------------------------------------------------- fetching -- */

const PROJECT_SELECT = '*, project_consultants(*), project_members(*)'
const CHUNK_SELECT = '*, chunk_project_items(*)'

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? 'unknown Supabase error'}`)
}

/**
 * Loads the project row exactly as `lib/store.ts#getProjectById` does, but
 * through the request-scoped server client so RLS sees the signed-in caller.
 * Returns `null` on "not found OR not readable" — the two collapse into one
 * state under RLS, same as the rest of the app (see
 * `app/projects/[id]/page.tsx`), and the route handler is expected to turn
 * that into a 404 rather than distinguishing the two.
 */
export async function fetchProjectForExport(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('id', projectId)
    .maybeSingle()

  if (error) fail(`Failed to load project "${projectId}"`, error)
  if (!data) return null

  return rowToProject(data as unknown as ProjectRow)
}

async function fetchLineItems(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<LineItem[]> {
  const { data, error } = await supabase
    .from('line_items')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (error) fail(`Failed to load line items for "${projectId}"`, error)

  return ((data ?? []) as unknown as LineItemRow[]).map(rowToLineItem)
}

async function fetchChunkProjects(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<ChunkProject[]> {
  const { data, error } = await supabase
    .from('chunk_projects')
    .select(CHUNK_SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (error) fail(`Failed to load packages for "${projectId}"`, error)

  return ((data ?? []) as unknown as ChunkProjectRow[]).map(rowToChunkProject)
}

/** Same `!inner` embed trick as `lib/store.ts#getChunkPhasesForProject` —
 *  chunk_phases carries no project_id of its own, so a left-embed filter
 *  would leak every project's phases with a null `chunk_projects`. */
async function fetchChunkPhases(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<ChunkPhase[]> {
  const { data, error } = await supabase
    .from('chunk_phases')
    .select('*, chunk_projects!inner(project_id)')
    .eq('chunk_projects.project_id', projectId)
    .order('sort_order', { ascending: true })

  if (error) fail(`Failed to load phases for "${projectId}"`, error)

  return ((data ?? []) as unknown as ChunkPhaseRow[]).map(rowToChunkPhase)
}

async function fetchCostSettings(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<ProjectCostSettings> {
  const [settingsResult, overridesResult] = await Promise.all([
    supabase.from('project_cost_settings').select('*').eq('project_id', projectId).maybeSingle(),
    supabase
      .from('escalation_rate_overrides')
      .select('*')
      .eq('project_id', projectId)
      .order('year_offset', { ascending: true }),
  ])

  if (settingsResult.error) {
    fail(`Failed to load cost settings for "${projectId}"`, settingsResult.error)
  }
  if (overridesResult.error) {
    fail(`Failed to load escalation overrides for "${projectId}"`, overridesResult.error)
  }

  return rowToCostSettings(
    settingsResult.data as unknown as ProjectCostSettingsRow | null,
    (overridesResult.data ?? []) as unknown as EscalationRateOverrideRow[],
    projectId
  )
}

async function fetchEnergySettings(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<ProjectEnergySettings> {
  const { data, error } = await supabase
    .from('project_energy_settings')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) fail(`Failed to load energy settings for "${projectId}"`, error)

  return rowToEnergySettings(data as unknown as ProjectEnergySettingsRow | null, projectId)
}

async function fetchTimelineSettings(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<ProjectTimelineSettings> {
  const { data, error } = await supabase
    .from('project_timeline_settings')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) fail(`Failed to load timeline settings for "${projectId}"`, error)

  return rowToTimelineSettings(data as unknown as TimelineSettingsRow | null, projectId)
}

/** The project's form definition (migration 0012) -- the Line Items sheet's
 *  columns come from here (M-28), same select as lib/store.ts. */
async function fetchFormFields(
  supabase: ShipSupabaseClient,
  projectId: string
): Promise<FormField[]> {
  const { data, error } = await supabase
    .from('form_fields')
    .select('*, form_field_options(*)')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })

  if (error) fail(`Failed to load form fields for "${projectId}"`, error)

  return ((data ?? []) as unknown as FormFieldRow[]).map(rowToFormField)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The what-if to export (M-24), read through RLS like everything else here:
 * a private scenario that belongs to someone else is simply not returned,
 * and comes back as "not found" -- the same as one that never existed.
 * Scoped to the project too, so a scenario id from another project can't be
 * laid over this one's phases.
 */
async function fetchScenarioForExport(
  supabase: ShipSupabaseClient,
  projectId: string,
  scenarioId: string
): Promise<Scenario> {
  // A malformed id would make Postgres raise 22P02 (a 500); it is a 404.
  if (!UUID_PATTERN.test(scenarioId)) {
    throw new ExportBlockedError('That what-if scenario was not found.', 404)
  }

  const { data, error } = await supabase
    .from('scenarios')
    .select('*')
    .eq('id', scenarioId)
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) fail(`Failed to load scenario "${scenarioId}"`, error)
  if (!data) {
    throw new ExportBlockedError(
      'That what-if scenario was not found, or you no longer have access to it.',
      404
    )
  }

  return rowToScenario(data as unknown as ScenarioRow)
}

/* --------------------------------------------------------- engine wiring -- */

function toEnginePhase(phase: ChunkPhase): Phase {
  return {
    id: phase.id,
    chunkProjectId: phase.chunkProjectId,
    name: phase.name,
    kind: phase.kind,
    sortOrder: phase.sortOrder,
    pctOfTpc: phase.pctOfTpc,
    startMonth: phase.startMonth,
    durationMonths: phase.durationMonths,
    durationLocked: phase.durationLocked,
  }
}

/** `baseYear` is passed in already checked: the export never prices from a
 *  stand-in year (M-25) -- see the guard in buildProjectReportData. */
function toCostSettings(row: ProjectCostSettings, baseYear: number): CostSettings {
  return {
    tpcFactor: row.tpcFactor,
    baseYear,
    escalationMode: row.escalationMode,
    escalationAnnualPercent: row.escalationAnnualPercent,
    escalationStepYears: row.escalationStepYears,
    escalationBasis: row.escalationBasis,
    escalationConfidenceYears: row.escalationConfidenceYears,
    rateOverrides: new Map(row.rateOverrides.map((o) => [o.yearOffset, o.ratePercent])),
  }
}

function toEnergySettings(row: ProjectEnergySettings | null): EnergySettings {
  if (!row) return DEFAULT_ENERGY_SETTINGS
  return {
    unitLabel: row.unitLabel,
    baselineAnnual: row.baselineAnnual,
    interactionFactor: row.interactionFactor,
  }
}

/* ------------------------------------------------------------- shaping -- */

// Cell/column shapes live with the per-cell helpers in line-item-cells.ts
// (shared with Master View's own export); re-exported for existing importers.
export type { ReportCellValue, ReportColumn }

/** A sheet whose columns are data, not code -- the Line Items sheet's
 *  columns come from the project's form definition (M-28). */
export type ReportTable = {
  columns: ReportColumn[]
  rows: ReportCellValue[][]
}

export type ReportPackage = {
  chunkNumber: string
  name: string
  /** The deliverable figure — escalated, fully rolled up. Never paired with
   *  `eccBase`/`tpcBase` in the same row; see the file header. */
  totalCost: number
  allocationIsIncomplete: boolean
  energySavingsAnnual: number
  annualCostSavings: number
  phaseCount: number
}

export type ReportPhase = {
  chunkNumber: string
  packageName: string
  phaseName: string
  kind: string
  startFiscalYear: string
  /** "Jul 2027": the phase's first month (D-1, schedules are in months). */
  startMonth: string
  durationMonths: number
  durationYears: number
  durationLocked: boolean
  escalatedCost: number
}

export type ReportAnnualTotal = {
  fiscalYear: number
  fiscalYearLabel: string
  escalatedTotal: number
  /** Fiscal quarters Q1..Q4 (D-11), summing to `escalatedTotal`. */
  quarterTotals: [number, number, number, number]
}

export type ReportEnergyPoint = {
  fiscalYear: string
  cumulativeSavings: number
  remainingConsumption: number | null
}

export type ProjectReportData = {
  project: { id: string; name: string }
  /** The what-if this export priced, or null for the live plan (M-24). */
  scenario: { id: string; name: string } | null
  generatedAt: string
  energyUnitLabel: string
  energyBaselineAnnual: number | null
  /**
   * Plain-sentence warnings the workbook must carry, e.g. "3 line items have
   * an unreadable cost (A4, M2, E7); they count as $0." Empty when clean.
   */
  notices: string[]
  /** Item numbers whose estimated first cost can't be read (M-09). */
  unreadableCostItems: string[]
  /** Package links whose quantity can't be read (M-10). */
  unreadableQuantityLinks: number
  lineItems: ReportTable
  packages: ReportPackage[]
  phases: ReportPhase[]
  annualCostSummary: ReportAnnualTotal[]
  energySummary: ReportEnergyPoint[]
}

export type BuildReportOptions = {
  /** Price this what-if instead of the live plan (M-24). */
  scenarioId?: string | null
}

/* ---------------------------------------------------- line-item columns -- */

export { UNREADABLE_CELL }

/**
 * The Line Items sheet, built from the project's VISIBLE form fields in form
 * order, with their current labels -- custom fields included, hidden ones
 * left out (M-28). Before this it was a hardcoded list of fifteen built-ins
 * with hardcoded labels: custom fields never reached the client and a field
 * an admin had hidden still did.
 *
 * Three system columns lead (they are not form fields, they are who/what
 * the row is), and "ECC Amount" -- the parsed per-unit cost every total is
 * built from -- sits right after the estimated-cost field, or at the end if
 * that field is hidden. D-4: nothing else is added or removed.
 */
export function buildLineItemTable(
  lineItems: readonly LineItem[],
  formFields: readonly FormField[]
): ReportTable {
  type Spec = { column: ReportColumn; value: (item: LineItem) => ReportCellValue }

  const specs: Spec[] = [
    { column: { header: 'Item #', width: 10 }, value: (item) => item.itemNumber },
    { column: { header: 'Discipline', width: 18 }, value: (item) => item.discipline },
    { column: { header: 'Company', width: 20 }, value: (item) => item.companyName },
  ]

  let eccPlaced = false
  for (const field of orderedVisibleFields(formFields)) {
    specs.push({ column: fieldColumn(field), value: (item) => fieldCell(item, field) })
    if (field.key === 'estimated_first_cost') {
      specs.push({ column: ECC_COLUMN, value: eccCell })
      eccPlaced = true
    }
  }
  if (!eccPlaced) specs.push({ column: ECC_COLUMN, value: eccCell })

  return {
    columns: specs.map((spec) => spec.column),
    rows: lineItems.map((item) => specs.map((spec) => spec.value(item))),
  }
}

function listItemNumbers(numbers: readonly string[]): string {
  const shown = numbers.slice(0, 10).join(', ')
  return numbers.length > 10 ? `${shown} and ${numbers.length - 10} more` : shown
}

/* ------------------------------------------------------------- building -- */

export async function buildProjectReportData(
  supabase: ShipSupabaseClient,
  project: Project,
  options: BuildReportOptions = {}
): Promise<ProjectReportData> {
  const scenarioId = options.scenarioId?.trim() || null

  const [
    lineItems,
    chunkProjects,
    chunkPhases,
    costSettingsRow,
    energySettingsRow,
    timelineSettings,
    formFields,
    scenario,
  ] = await Promise.all([
    fetchLineItems(supabase, project.id),
    fetchChunkProjects(supabase, project.id),
    fetchChunkPhases(supabase, project.id),
    fetchCostSettings(supabase, project.id),
    fetchEnergySettings(supabase, project.id),
    fetchTimelineSettings(supabase, project.id),
    fetchFormFields(supabase, project.id),
    scenarioId ? fetchScenarioForExport(supabase, project.id, scenarioId) : Promise.resolve(null),
  ])

  // M-25: a deliverable is never priced from a year nobody set. The screen
  // can show a labelled stand-in while settings load; a workbook handed to a
  // state agency cannot, so refuse with something the user can act on.
  const baseYear = costSettingsRow.baseYear
  const startCalendarYear = timelineSettings.startCalendarYear
  if (baseYear === null || startCalendarYear === null) {
    // The base year has an input on the Cost Model tab; the timeline start
    // year has none in the app (migration 0018 stores it at creation and
    // backfills older projects), so a missing one goes to an admin.
    const steps = [
      baseYear === null ? 'the base year is not set (Cost Model tab)' : null,
      startCalendarYear === null
        ? 'the timeline start year is not set (ask a platform admin to fix the project settings)'
        : null,
    ].filter(Boolean)
    throw new ExportBlockedError(`Can't export yet: ${steps.join(', and ')}.`, 409)
  }

  const costSettings = toCostSettings(costSettingsRow, baseYear)
  const energySettings = toEnergySettings(energySettingsRow)

  // No zoom here any more (M-01, D-1): schedules are in months and nothing
  // the workbook contains depends on how many months a screen column shows,
  // so two people exporting at different zooms get the same file. `interval`
  // is required by the type and read by nothing below.
  const configuredGeometry: TimelineGeometry = {
    interval: 'yearly',
    years: timelineSettings.years,
    startCalendarYear,
    fiscalYearStartMonth: timelineSettings.fiscalYearStartMonth,
    fiscalYearLabelsBy: timelineSettings.fiscalYearLabelsBy,
  }

  const lineItemMap = new Map(lineItems.map((item) => [item.id, item]))

  // M-24: inside a what-if, the screen prices the live phases with the
  // scenario's placements laid over them (TimelineTab `effectivePhases`).
  // The export goes through the same rule, so the workbook, the PDF and
  // the screen show one number.
  const effectivePhases = scenario
    ? applyScenarioOverlay(chunkPhases, scenario.payload.phases)
    : chunkPhases

  const phasesByChunk = new Map<string, ChunkPhase[]>()
  for (const phase of effectivePhases) {
    phasesByChunk.set(phase.chunkProjectId, [
      ...(phasesByChunk.get(phase.chunkProjectId) ?? []),
      phase,
    ])
  }
  for (const list of phasesByChunk.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)

  // The one horizon rule the Timeline uses too (M-27): stretched to the end
  // of the furthest phase, so the Annual Cost Summary adds up to the
  // Packages total instead of silently dropping what is scheduled late.
  const horizon = resolveHorizon(configuredGeometry, effectivePhases.map(toEnginePhase))
  const geometry = horizon.geometry

  let unreadableQuantityLinks = 0

  // Package inputs, summed from line items exactly as
  // TimelineTab.tsx#packageInputs does — same fallback from the
  // trigger-maintained `eccAmount` to a live parse of `estimatedFirstCost`.
  // An unreadable cost or quantity contributes 0 here, as on screen, and is
  // COUNTED so the workbook says so (M-09 / M-10).
  const packageInputs: PackageInput[] = chunkProjects.map((chunk) => {
    let eccBase = 0
    let energySavingsAnnual = 0
    let annualCostSavings = 0

    for (const link of chunk.itemLinks) {
      const item = lineItemMap.get(link.lineItemId)
      if (!item) continue
      if (!parseQuantity(link.quantity).ok) unreadableQuantityLinks += 1
      const quantity = parseQuantityInput(link.quantity)
      const unitCost = item.eccAmount || parseCostInput(item.estimatedFirstCost)

      eccBase += unitCost * quantity
      // Blank (null) is "not answered" (D-9); for a sum it contributes nothing.
      energySavingsAnnual += (item.annualEnergySavings ?? 0) * quantity
      annualCostSavings += (item.annualCostSavings ?? 0) * quantity
    }

    return {
      chunkProjectId: chunk.id,
      chunkNumber: chunk.chunkNumber,
      name: chunk.name,
      eccBase,
      energySavingsAnnual,
      annualCostSavings,
    }
  })

  const summaries: PackageSummary[] = packageInputs.map((input) =>
    summarisePackage(
      input,
      (phasesByChunk.get(input.chunkProjectId) ?? []).map(toEnginePhase),
      costSettings,
      geometry
    )
  )

  // Monthly resolution, fiscal quarters (M-26, D-11): the same function the
  // Timeline's "By fiscal year" strip calls.
  const fiscalTotals = computeFiscalYearTotals(summaries, geometry)
  const energyByYear = computeEnergyByFiscalYear(summaries, energySettings, geometry)

  const unreadableCostItems = lineItems
    .filter((item) => !parseCostAmount(item.estimatedFirstCost).ok)
    .map((item) => item.itemNumber || item.name || item.id)

  const notices: string[] = []
  if (scenario) {
    notices.push(
      `What-if scenario "${scenario.name}": these figures are the scenario's schedule, not the live plan.`
    )
  }
  if (horizon.extended) {
    notices.push(
      `Some phases run past the ${horizon.configuredYears}-year timeline, so the annual figures run to ` +
        `${geometry.years} years to include them.`
    )
  }
  if (unreadableCostItems.length > 0) {
    notices.push(
      `${unreadableCostItems.length} line item${unreadableCostItems.length === 1 ? ' has an' : 's have an'} ` +
        `unreadable cost (${listItemNumbers(unreadableCostItems)}); ` +
        `${unreadableCostItems.length === 1 ? 'it counts' : 'they count'} as $0 until corrected.`
    )
  }
  if (unreadableQuantityLinks > 0) {
    notices.push(
      `${unreadableQuantityLinks} package line${unreadableQuantityLinks === 1 ? ' has an' : 's have an'} ` +
        `unreadable quantity; ${unreadableQuantityLinks === 1 ? 'it counts' : 'they count'} as 0 until corrected.`
    )
  }

  const reportPackages: ReportPackage[] = summaries.map((summary) => ({
    chunkNumber: summary.input.chunkNumber,
    name: summary.input.name,
    totalCost: summary.totalEscalatedCost,
    allocationIsIncomplete: summary.allocationIsIncomplete,
    energySavingsAnnual: summary.input.energySavingsAnnual,
    annualCostSavings: summary.input.annualCostSavings,
    phaseCount: summary.phases.length,
  }))

  const reportPhases: ReportPhase[] = summaries.flatMap((summary) =>
    summary.phases.map((phaseCost) => ({
      chunkNumber: summary.input.chunkNumber,
      packageName: summary.input.name,
      phaseName: phaseCost.phase.name,
      kind: phaseCost.phase.kind,
      startFiscalYear: formatFiscalYear(fiscalYearForMonth(phaseCost.phase.startMonth, geometry)),
      startMonth: monthLabel(phaseCost.phase.startMonth, geometry),
      durationMonths: Math.round(phaseCost.phase.durationMonths * 100) / 100,
      durationYears: Math.round((phaseCost.phase.durationMonths / 12) * 100) / 100,
      durationLocked: phaseCost.phase.durationLocked,
      escalatedCost: phaseCost.escalatedCost,
    }))
  )

  const annualCostSummary: ReportAnnualTotal[] = fiscalTotals.map((total) => ({
    fiscalYear: total.fiscalYear,
    fiscalYearLabel: formatFiscalYear(total.fiscalYear),
    escalatedTotal: total.escalatedTotal,
    quarterTotals: [
      total.quarters[0].escalatedTotal,
      total.quarters[1].escalatedTotal,
      total.quarters[2].escalatedTotal,
      total.quarters[3].escalatedTotal,
    ],
  }))

  // One row per fiscal year, read at the year's end -- not one row per
  // screen column, which made this sheet's length depend on the zoom.
  const energySummary: ReportEnergyPoint[] = energyByYear.map((point) => ({
    fiscalYear: formatFiscalYear(point.fiscalYear),
    cumulativeSavings: point.cumulativeSavings,
    remainingConsumption: point.remainingConsumption,
  }))

  return {
    project: { id: project.id, name: project.name },
    scenario: scenario ? { id: scenario.id, name: scenario.name } : null,
    generatedAt: new Date().toISOString(),
    energyUnitLabel: energySettings.unitLabel,
    energyBaselineAnnual: energySettings.baselineAnnual,
    notices,
    unreadableCostItems,
    unreadableQuantityLinks,
    lineItems: buildLineItemTable(lineItems, formFields),
    packages: reportPackages,
    phases: reportPhases,
    annualCostSummary,
    energySummary,
  }
}
