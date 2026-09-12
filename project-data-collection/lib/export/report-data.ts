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
import { parseCostInput, parseQuantityInput } from '../costs'
import {
  DEFAULT_COST_SETTINGS,
  DEFAULT_ENERGY_SETTINGS,
  computeEnergySeries,
  computeFiscalYearTotals,
  computeSlotCosts,
  fiscalYearForSlot,
  slotCount as computeSlotCount,
  summarisePackage,
  yearsPerSlot,
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
  rowToLineItem,
  rowToProject,
  rowToTimelineSettings,
  type ChunkPhaseRow,
  type ChunkProjectRow,
  type EscalationRateOverrideRow,
  type LineItemRow,
  type ProjectCostSettingsRow,
  type ProjectEnergySettingsRow,
  type ProjectRow,
  type TimelineSettingsRow,
} from '../mappers'
import type {
  ChunkPhase,
  ChunkProject,
  LineItem,
  Project,
  ProjectCostSettings,
  ProjectEnergySettings,
  ProjectTimelineSettings,
  TimelineInterval,
} from '../types'

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

/* --------------------------------------------------------- engine wiring -- */

/**
 * Maps the on-screen zoom slider (1-5) to the engine's `TimelineInterval`.
 *
 * This MUST mirror `ZOOM_LEVELS` / `intervalForZoom` in
 * `components/project-workspace/TimelineTab.tsx` exactly: the Timeline tab
 * derives its rendered geometry from `timelineSettings.zoomLevel`, NOT from
 * the stored `timelineSettings.interval` column, and spec §6 check 4
 * requires the export to equal the on-screen total "to the cent". That file
 * is owned by parallel work and is a Client Component (so it cannot be
 * imported into this server-only module) — this is a deliberate, commented
 * duplication of five lines rather than a shared import, not an
 * independent re-derivation of the mapping.
 */
function intervalForZoom(zoomLevel: number): TimelineInterval {
  switch (zoomLevel) {
    case 1:
      return '5-yearly'
    case 2:
      return '3-yearly'
    case 4:
      return 'quarterly'
    case 5:
      return 'monthly'
    default:
      return 'yearly'
  }
}

function toEnginePhase(phase: ChunkPhase): Phase {
  return {
    id: phase.id,
    chunkProjectId: phase.chunkProjectId,
    name: phase.name,
    kind: phase.kind,
    sortOrder: phase.sortOrder,
    pctOfTpc: phase.pctOfTpc,
    startSlot: phase.startSlot,
    durationSlots: phase.durationSlots,
    durationLocked: phase.durationLocked,
  }
}

function toCostSettings(row: ProjectCostSettings | null): CostSettings {
  if (!row) return DEFAULT_COST_SETTINGS
  return {
    tpcFactor: row.tpcFactor,
    baseYear: row.baseYear,
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

/** `FY29` — same tail-formatting `fiscalYearLabel` in lib/cost-model.ts
 *  uses, restated here because that helper takes a SLOT, and the fiscal
 *  years here already come out of `computeFiscalYearTotals` as plain
 *  numbers. */
function formatFiscalYear(year: number): string {
  return `FY${String(((year % 100) + 100) % 100).padStart(2, '0')}`
}

/* ------------------------------------------------------------- shaping -- */

export type ReportLineItem = {
  itemNumber: string
  name: string
  discipline: string
  companyName: string
  category: string
  timelinePriority: string
  buildingAreaImpacted: string
  buildingLevelImpacted: string
  relativeFirstCost: string
  estimatedFirstCost: string
  eccAmount: number
  annualEnergySavings: number
  annualCostSavings: number
  energyNotes: string
  supportingNotes: string
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
  durationYears: number
  durationLocked: boolean
  escalatedCost: number
}

export type ReportAnnualTotal = {
  fiscalYear: number
  fiscalYearLabel: string
  escalatedTotal: number
}

export type ReportEnergyPoint = {
  fiscalYear: string
  cumulativeSavings: number
  remainingConsumption: number | null
}

export type ProjectReportData = {
  project: { id: string; name: string }
  generatedAt: string
  energyUnitLabel: string
  energyBaselineAnnual: number | null
  lineItems: ReportLineItem[]
  packages: ReportPackage[]
  phases: ReportPhase[]
  annualCostSummary: ReportAnnualTotal[]
  energySummary: ReportEnergyPoint[]
}

export async function buildProjectReportData(
  supabase: ShipSupabaseClient,
  project: Project
): Promise<ProjectReportData> {
  const [lineItems, chunkProjects, chunkPhases, costSettingsRow, energySettingsRow, timelineSettings] =
    await Promise.all([
      fetchLineItems(supabase, project.id),
      fetchChunkProjects(supabase, project.id),
      fetchChunkPhases(supabase, project.id),
      fetchCostSettings(supabase, project.id),
      fetchEnergySettings(supabase, project.id),
      fetchTimelineSettings(supabase, project.id),
    ])

  const costSettings = toCostSettings(costSettingsRow)
  const energySettings = toEnergySettings(energySettingsRow)

  const geometry: TimelineGeometry = {
    interval: intervalForZoom(timelineSettings.zoomLevel),
    years: timelineSettings.years,
    startCalendarYear: timelineSettings.startCalendarYear,
    fiscalYearStartMonth: timelineSettings.fiscalYearStartMonth,
    fiscalYearLabelsBy: timelineSettings.fiscalYearLabelsBy,
  }

  const lineItemMap = new Map(lineItems.map((item) => [item.id, item]))

  const phasesByChunk = new Map<string, ChunkPhase[]>()
  for (const phase of chunkPhases) {
    phasesByChunk.set(phase.chunkProjectId, [
      ...(phasesByChunk.get(phase.chunkProjectId) ?? []),
      phase,
    ])
  }
  for (const list of phasesByChunk.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)

  // Package inputs, summed from line items exactly as
  // TimelineTab.tsx#packageInputs does — same fallback from the
  // trigger-maintained `eccAmount` to a live parse of `estimatedFirstCost`
  // for any row written before migration 0006 backfilled it.
  const packageInputs: PackageInput[] = chunkProjects.map((chunk) => {
    let eccBase = 0
    let energySavingsAnnual = 0
    let annualCostSavings = 0

    for (const link of chunk.itemLinks) {
      const item = lineItemMap.get(link.lineItemId)
      if (!item) continue
      const quantity = parseQuantityInput(link.quantity)
      const unitCost = item.eccAmount || parseCostInput(item.estimatedFirstCost)

      eccBase += unitCost * quantity
      energySavingsAnnual += item.annualEnergySavings * quantity
      annualCostSavings += item.annualCostSavings * quantity
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

  const slotCosts = computeSlotCosts(summaries, geometry)
  const energySeries = computeEnergySeries(summaries, energySettings, geometry)
  const fiscalTotals = computeFiscalYearTotals(slotCosts)

  const yearsPerSlotValue = yearsPerSlot(geometry.interval)
  const slotCountValue = computeSlotCount(geometry.years, geometry.interval)

  const reportLineItems: ReportLineItem[] = lineItems.map((item) => ({
    itemNumber: item.itemNumber,
    name: item.name,
    discipline: item.discipline,
    companyName: item.companyName,
    category: item.category,
    timelinePriority: item.timelinePriority,
    buildingAreaImpacted: item.buildingAreaImpacted,
    buildingLevelImpacted: item.buildingLevelImpacted,
    relativeFirstCost: item.relativeFirstCost,
    estimatedFirstCost: item.estimatedFirstCost,
    eccAmount: item.eccAmount,
    annualEnergySavings: item.annualEnergySavings,
    annualCostSavings: item.annualCostSavings,
    energyNotes: item.energyNotes,
    supportingNotes: item.supportingNotes,
  }))

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
      startFiscalYear: formatFiscalYear(fiscalYearForSlot(phaseCost.phase.startSlot, geometry)),
      durationYears: Math.round(phaseCost.phase.durationSlots * yearsPerSlotValue * 100) / 100,
      durationLocked: phaseCost.phase.durationLocked,
      escalatedCost: phaseCost.escalatedCost,
    }))
  )

  const annualCostSummary: ReportAnnualTotal[] = fiscalTotals.map((total) => ({
    fiscalYear: total.fiscalYear,
    fiscalYearLabel: formatFiscalYear(total.fiscalYear),
    escalatedTotal: total.escalatedTotal,
  }))

  const energySummary: ReportEnergyPoint[] = Array.from({ length: slotCountValue }, (_, slot) => {
    const point = energySeries.points[slot]
    return {
      fiscalYear: formatFiscalYear(fiscalYearForSlot(slot, geometry)),
      cumulativeSavings: point?.cumulativeSavings ?? 0,
      remainingConsumption: point?.remainingConsumption ?? null,
    }
  })

  return {
    project: { id: project.id, name: project.name },
    generatedAt: new Date().toISOString(),
    energyUnitLabel: energySettings.unitLabel,
    energyBaselineAnnual: energySettings.baselineAnnual,
    lineItems: reportLineItems,
    packages: reportPackages,
    phases: reportPhases,
    annualCostSummary,
    energySummary,
  }
}
