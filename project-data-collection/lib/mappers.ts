/**
 * Row <-> domain-type conversion for the `ship` Postgres schema.
 *
 * Postgres columns are snake_case; `lib/types.ts` is camelCase and must not
 * change. Every translation between the two lives here, so the naming
 * difference never leaks into components. Two renames are load-bearing:
 *
 *   line_items.electrification_eo594          <-> LineItem.electrificationEO594
 *   project_timeline_settings.interval_unit   <-> ProjectTimelineSettings.interval
 *
 * The second exists because `interval` is a reserved type name in Postgres.
 *
 * This file also owns the defaulting/clamping that used to live in `store.ts`
 * as `normalizeChunkProject` and `normalizeTimelineSettings`.
 */

import { CONSULTANT_TYPES } from './constants'
import {
  ChunkPhase,
  ChunkProject,
  ChunkProjectItem,
  ChunkTimelineSegment,
  ConsultantType,
  DependencyType,
  EscalationBasis,
  EscalationMode,
  FiscalYearLabelsBy,
  LineItem,
  PhaseDependency,
  PhaseKind,
  PhaseTemplate,
  PhaseTemplateStep,
  Project,
  ProjectConsultant,
  ProjectCostSettings,
  ProjectEnergySettings,
  ProjectTimelineSettings,
  Scenario,
  ScenarioDependency,
  ScenarioPayload,
  ScenarioPhase,
  TimelineInterval,
} from './types'

/* ------------------------------------------------------------------ rows -- */

export type ProjectConsultantRow = {
  id?: string
  project_id?: string
  consultant_type: string
  org_name: string | null
}

export type ProjectMemberRow = {
  project_id?: string
  email: string
  consultant_type: string
}

export type ProjectRow = {
  id: string
  name: string
  created_at: string
  created_by?: string | null
  updated_at?: string | null
  project_consultants?: ProjectConsultantRow[] | null
  project_members?: ProjectMemberRow[] | null
}

export type LineItemRow = {
  id: string
  project_id: string
  user_email: string
  consultant_type: string
  company_name: string | null
  discipline: string
  item_number: string | null
  name: string
  short_description: string | null
  category: string
  timeline_priority: string
  building_area_impacted: string
  building_level_impacted: string
  operational_impact: string
  benefit_to_users: string
  benefit_to_public: string
  relative_first_cost: string
  estimated_first_cost: string | null
  relative_operation_cost_impact: string
  relative_operational_energy_usage: string
  electrification_eo594: string
  addressing_resiliency_sustainability: string
  addressing_deferred_maintenance: string
  code_life_safety_improvement: string
  accessibility_improvement: string
  historic_impact: string
  potential_synergies: string[] | null
  supporting_notes: string | null
  created_at: string
  // v2 (0006). ecc_amount is maintained by ship.sync_line_item_ecc(), a
  // BEFORE trigger keyed off estimated_first_cost - see lineItemToRow below,
  // which strips it on every write.
  ecc_amount: number | string
  annual_energy_savings: number | string
  annual_cost_savings: number | string
  energy_notes: string | null
}

export type ChunkProjectItemRow = {
  chunk_project_id?: string
  line_item_id: string
  quantity: string | null
  position: number | null
}

export type ChunkProjectRow = {
  id: string
  project_id: string
  chunk_number: string | null
  name: string
  timeline_segments: unknown
  timeline_start: number | string | null
  timeline_duration: number | string | null
  created_at: string
  chunk_project_items?: ChunkProjectItemRow[] | null
}

export type TimelineSettingsRow = {
  project_id: string
  years: number | string | null
  interval_unit: string | null
  zoom_level: number | string | null
  escalation_percent: number | string | null
  escalation_every_years: number | string | null
  // v2 (0006): calendar anchoring, consumed as lib/cost-model.ts's
  // TimelineGeometry.
  start_calendar_year: number | string | null
  fiscal_year_start_month: number | string | null
  fiscal_year_labels_by: string | null
}

/* --------------------------------------------------------------- helpers -- */

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function consultantTypeOrder(type: string): number {
  const index = (CONSULTANT_TYPES as readonly string[]).indexOf(type)
  return index === -1 ? CONSULTANT_TYPES.length : index
}

function distinct(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))]
}

/* -------------------------------------------------------------- projects -- */

export function rowToProject(row: ProjectRow): Project {
  const consultantRows = row.project_consultants ?? []
  const memberRows = row.project_members ?? []

  const consultants: ProjectConsultant[] = consultantRows
    .slice()
    .sort(
      (a, b) => consultantTypeOrder(a.consultant_type) - consultantTypeOrder(b.consultant_type)
    )
    .map((consultant) => ({
      type: consultant.consultant_type as ConsultantType,
      orgName: consultant.org_name ?? '',
      emails: distinct(
        memberRows
          .filter((member) => member.consultant_type === consultant.consultant_type)
          .map((member) => member.email)
      ),
    }))

  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    consultants,
    // `assignedUsers` is derived, never stored: the distinct set of member emails.
    assignedUsers: distinct(memberRows.map((member) => member.email)),
  }
}

/* ------------------------------------------------------------ line items -- */

export function rowToLineItem(row: LineItemRow): LineItem {
  return {
    id: row.id,
    projectId: row.project_id,
    userEmail: row.user_email,
    consultantType: row.consultant_type as LineItem['consultantType'],
    companyName: row.company_name ?? '',
    discipline: row.discipline as LineItem['discipline'],
    itemNumber: row.item_number ?? '',
    name: row.name,
    shortDescription: row.short_description ?? '',
    category: row.category as LineItem['category'],
    timelinePriority: row.timeline_priority as LineItem['timelinePriority'],
    buildingAreaImpacted: row.building_area_impacted as LineItem['buildingAreaImpacted'],
    buildingLevelImpacted: row.building_level_impacted as LineItem['buildingLevelImpacted'],
    operationalImpact: row.operational_impact as LineItem['operationalImpact'],
    benefitToUsers: row.benefit_to_users as LineItem['benefitToUsers'],
    benefitToPublic: row.benefit_to_public as LineItem['benefitToPublic'],
    relativeFirstCost: row.relative_first_cost as LineItem['relativeFirstCost'],
    estimatedFirstCost: row.estimated_first_cost ?? '',
    relativeOperationCostImpact:
      row.relative_operation_cost_impact as LineItem['relativeOperationCostImpact'],
    relativeOperationalEnergyUsage:
      row.relative_operational_energy_usage as LineItem['relativeOperationalEnergyUsage'],
    electrificationEO594: row.electrification_eo594 as LineItem['electrificationEO594'],
    addressingResiliencySustainability:
      row.addressing_resiliency_sustainability as LineItem['addressingResiliencySustainability'],
    addressingDeferredMaintenance:
      row.addressing_deferred_maintenance as LineItem['addressingDeferredMaintenance'],
    codeLifeSafetyImprovement:
      row.code_life_safety_improvement as LineItem['codeLifeSafetyImprovement'],
    accessibilityImprovement:
      row.accessibility_improvement as LineItem['accessibilityImprovement'],
    historicImpact: row.historic_impact as LineItem['historicImpact'],
    potentialSynergies: (row.potential_synergies ?? []) as ConsultantType[],
    supportingNotes: row.supporting_notes ?? '',
    createdAt: row.created_at,
    eccAmount: toNumber(row.ecc_amount) ?? 0,
    annualEnergySavings: toNumber(row.annual_energy_savings) ?? 0,
    annualCostSavings: toNumber(row.annual_cost_savings) ?? 0,
    energyNotes: row.energy_notes ?? '',
  }
}

const LINE_ITEM_COLUMNS: Array<[keyof LineItem, keyof LineItemRow]> = [
  ['id', 'id'],
  ['projectId', 'project_id'],
  ['userEmail', 'user_email'],
  ['consultantType', 'consultant_type'],
  ['companyName', 'company_name'],
  ['discipline', 'discipline'],
  ['itemNumber', 'item_number'],
  ['name', 'name'],
  ['shortDescription', 'short_description'],
  ['category', 'category'],
  ['timelinePriority', 'timeline_priority'],
  ['buildingAreaImpacted', 'building_area_impacted'],
  ['buildingLevelImpacted', 'building_level_impacted'],
  ['operationalImpact', 'operational_impact'],
  ['benefitToUsers', 'benefit_to_users'],
  ['benefitToPublic', 'benefit_to_public'],
  ['relativeFirstCost', 'relative_first_cost'],
  ['estimatedFirstCost', 'estimated_first_cost'],
  ['relativeOperationCostImpact', 'relative_operation_cost_impact'],
  ['relativeOperationalEnergyUsage', 'relative_operational_energy_usage'],
  ['electrificationEO594', 'electrification_eo594'],
  ['addressingResiliencySustainability', 'addressing_resiliency_sustainability'],
  ['addressingDeferredMaintenance', 'addressing_deferred_maintenance'],
  ['codeLifeSafetyImprovement', 'code_life_safety_improvement'],
  ['accessibilityImprovement', 'accessibility_improvement'],
  ['historicImpact', 'historic_impact'],
  ['potentialSynergies', 'potential_synergies'],
  ['supportingNotes', 'supporting_notes'],
  ['createdAt', 'created_at'],
  ['annualEnergySavings', 'annual_energy_savings'],
  ['annualCostSavings', 'annual_cost_savings'],
  ['energyNotes', 'energy_notes'],
  // `eccAmount` is DELIBERATELY ABSENT from this list, not merely unused.
  // ship.sync_line_item_ecc() (0006) recomputes it from estimated_first_cost
  // on every insert/update, so a write from here is at best a no-op and at
  // worst a stale value racing the trigger. Omitting it from the table -
  // rather than filtering it out below - means a future column added here
  // by copy-paste cannot silently start sending it again.
]

/**
 * Maps only the keys actually present on `patch`, so the same function serves
 * both inserts and partial updates. Callers must not send `company_name`,
 * `discipline`, `item_number` or `ecc_amount` on insert - those are filled by
 * triggers.
 */
export function lineItemToRow(patch: Partial<LineItem>): Partial<LineItemRow> {
  const row: Record<string, unknown> = {}

  LINE_ITEM_COLUMNS.forEach(([domainKey, columnKey]) => {
    const value = patch[domainKey]
    if (value === undefined) return
    row[columnKey] = value
  })

  return row as Partial<LineItemRow>
}

/* --------------------------------------------------------- chunk projects -- */

/**
 * Absorbs the old `normalizeChunkProject` segment handling: synthesize a single
 * segment when none is stored, give every segment an id, clamp `start >= 0` and
 * `duration > 0`.
 */
export function normalizeTimelineSegments(
  chunkId: string,
  segments: unknown,
  fallbackStartInput: unknown,
  fallbackDurationInput: unknown
): ChunkTimelineSegment[] {
  const fallbackStartValue = toNumber(fallbackStartInput)
  const fallbackStart =
    fallbackStartValue !== null && fallbackStartValue >= 0 ? fallbackStartValue : 0

  const fallbackDurationValue = toNumber(fallbackDurationInput)
  const fallbackDuration =
    fallbackDurationValue !== null && fallbackDurationValue > 0 ? fallbackDurationValue : 1

  const raw = Array.isArray(segments)
    ? (segments as Array<Partial<ChunkTimelineSegment> | null>)
    : []

  if (raw.length === 0) {
    return [{ id: chunkId + '-segment-1', start: fallbackStart, duration: fallbackDuration }]
  }

  return raw.map((segment, index) => {
    const start = toNumber(segment?.start)
    const duration = toNumber(segment?.duration)

    return {
      id: segment?.id || chunkId + '-segment-' + (index + 1),
      start: start !== null && start >= 0 ? start : 0,
      duration: duration !== null && duration > 0 ? duration : 1,
    }
  })
}

export function rowToChunkProject(row: ChunkProjectRow): ChunkProject {
  const itemLinks: ChunkProjectItem[] = (row.chunk_project_items ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((link) => ({
      lineItemId: link.line_item_id,
      quantity: link.quantity ?? '',
    }))

  const timelineSegments = normalizeTimelineSegments(
    row.id,
    row.timeline_segments,
    row.timeline_start,
    row.timeline_duration
  )

  return {
    id: row.id,
    projectId: row.project_id,
    chunkNumber: row.chunk_number ?? '',
    name: row.name,
    itemLinks,
    timelineSegments,
    // Derived mirrors of segment 0 - the stored columns are only a fallback.
    timelineStart: timelineSegments[0].start,
    timelineDuration: timelineSegments[0].duration,
    createdAt: row.created_at,
  }
}

/* ------------------------------------------------------ timeline settings -- */

/**
 * Absorbs the old `normalizeTimelineSettings`. Pass `null` for a project with
 * no stored row yet and you get the defaults.
 */
export function rowToTimelineSettings(
  row: Partial<TimelineSettingsRow> | null | undefined,
  projectId: string
): ProjectTimelineSettings {
  const yearsValue = toNumber(row?.years)
  const years = yearsValue !== null && yearsValue >= 0 ? Math.round(yearsValue) : 10

  const zoomValue = toNumber(row?.zoom_level)
  const zoomLevel = zoomValue !== null ? Math.min(Math.max(Math.round(zoomValue), 1), 5) : 3

  const escalationValue = toNumber(row?.escalation_percent)
  const escalationPercent = escalationValue !== null && escalationValue >= 0 ? escalationValue : 0

  const everyYearsValue = toNumber(row?.escalation_every_years)
  const escalationEveryYears =
    everyYearsValue !== null && everyYearsValue > 0 ? Math.round(everyYearsValue) : 5

  // Matches lib/cost-model.ts DEFAULT_COST_SETTINGS.baseYear's fallback: a
  // project with no row yet (or, in principle, a pre-backfill null) anchors
  // to "now" rather than a fixed literal, so a freshly created project does
  // not silently claim to start in some past year.
  const startYearValue = toNumber(row?.start_calendar_year)
  const startCalendarYear =
    startYearValue !== null ? Math.round(startYearValue) : new Date().getUTCFullYear()

  const fyStartMonthValue = toNumber(row?.fiscal_year_start_month)
  const fiscalYearStartMonth =
    fyStartMonthValue !== null
      ? Math.min(Math.max(Math.round(fyStartMonthValue), 1), 12)
      : 7

  const fiscalYearLabelsBy: FiscalYearLabelsBy =
    row?.fiscal_year_labels_by === 'start_year' ? 'start_year' : 'end_year'

  return {
    projectId: row?.project_id ?? projectId,
    years,
    // Column is `interval_unit`; `interval` is a reserved Postgres type name.
    interval: (row?.interval_unit as TimelineInterval) || 'yearly',
    zoomLevel,
    escalationPercent,
    escalationEveryYears,
    startCalendarYear,
    fiscalYearStartMonth,
    fiscalYearLabelsBy,
  }
}

export function timelineSettingsToRow(settings: ProjectTimelineSettings): TimelineSettingsRow {
  return {
    project_id: settings.projectId,
    years: settings.years,
    interval_unit: settings.interval,
    zoom_level: settings.zoomLevel,
    escalation_percent: settings.escalationPercent,
    escalation_every_years: settings.escalationEveryYears,
    start_calendar_year: settings.startCalendarYear,
    fiscal_year_start_month: settings.fiscalYearStartMonth,
    fiscal_year_labels_by: settings.fiscalYearLabelsBy,
  }
}

/* ------------------------------------------------------------ chunk phases -- */
// supabase/migrations/0007_ship_phases.sql

export type ChunkPhaseRow = {
  id: string
  chunk_project_id: string
  template_step_id: string | null
  name: string
  kind: string
  sort_order: number | string
  pct_of_tpc: number | string
  start_slot: number | string
  duration_slots: number | string
  duration_locked: boolean
  created_at: string
}

export function rowToChunkPhase(row: ChunkPhaseRow): ChunkPhase {
  return {
    id: row.id,
    chunkProjectId: row.chunk_project_id,
    templateStepId: row.template_step_id,
    name: row.name,
    kind: row.kind as PhaseKind,
    sortOrder: toNumber(row.sort_order) ?? 0,
    pctOfTpc: toNumber(row.pct_of_tpc) ?? 0,
    startSlot: toNumber(row.start_slot) ?? 0,
    durationSlots: toNumber(row.duration_slots) ?? 1,
    durationLocked: row.duration_locked,
    createdAt: row.created_at,
  }
}

/**
 * Same "only send what's present" contract as `lineItemToRow`. `id` and
 * `created_at` are never sent - callers `delete` them the same way
 * `updateLineItem` does before an update.
 */
export function chunkPhaseToRow(patch: Partial<ChunkPhase>): Partial<ChunkPhaseRow> {
  const row: Partial<ChunkPhaseRow> = {}

  if (patch.chunkProjectId !== undefined) row.chunk_project_id = patch.chunkProjectId
  if (patch.templateStepId !== undefined) row.template_step_id = patch.templateStepId
  if (patch.name !== undefined) row.name = patch.name
  if (patch.kind !== undefined) row.kind = patch.kind
  if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder
  if (patch.pctOfTpc !== undefined) row.pct_of_tpc = patch.pctOfTpc
  if (patch.startSlot !== undefined) row.start_slot = patch.startSlot
  if (patch.durationSlots !== undefined) row.duration_slots = patch.durationSlots
  if (patch.durationLocked !== undefined) row.duration_locked = patch.durationLocked

  return row
}

/* ------------------------------------------------------ phase dependencies -- */

export type PhaseDependencyRow = {
  id: string
  project_id: string
  predecessor_phase_id: string
  successor_phase_id: string
  dep_type: string
  lag_slots: number | string
  created_at: string
}

export function rowToPhaseDependency(row: PhaseDependencyRow): PhaseDependency {
  return {
    id: row.id,
    projectId: row.project_id,
    predecessorPhaseId: row.predecessor_phase_id,
    successorPhaseId: row.successor_phase_id,
    depType: row.dep_type as DependencyType,
    lagSlots: toNumber(row.lag_slots) ?? 0,
  }
}

/**
 * `project_id` has no domain-key counterpart here on purpose: it is filled by
 * `ship.sync_phase_dependency_project()` (a BEFORE trigger keyed off the
 * predecessor phase) and sending it from the client would either be ignored
 * or, on a row the trigger did not touch, corrupt the tenant key the RLS
 * policies rely on. See `createPhaseDependency` in lib/store.ts.
 */
export function phaseDependencyToRow(input: {
  predecessorPhaseId: string
  successorPhaseId: string
  depType?: DependencyType
  lagSlots?: number
}): Partial<PhaseDependencyRow> {
  const row: Partial<PhaseDependencyRow> = {
    predecessor_phase_id: input.predecessorPhaseId,
    successor_phase_id: input.successorPhaseId,
  }
  if (input.depType !== undefined) row.dep_type = input.depType
  if (input.lagSlots !== undefined) row.lag_slots = input.lagSlots
  return row
}

/* ---------------------------------------------------------- phase templates -- */

export type PhaseTemplateStepRow = {
  id: string
  template_id: string
  name: string
  kind: string
  sort_order: number | string
  default_pct_of_tpc: number | string
  default_duration_slots: number | string
}

export function rowToPhaseTemplateStep(row: PhaseTemplateStepRow): PhaseTemplateStep {
  return {
    id: row.id,
    templateId: row.template_id,
    name: row.name,
    kind: row.kind as PhaseKind,
    sortOrder: toNumber(row.sort_order) ?? 0,
    defaultPctOfTpc: toNumber(row.default_pct_of_tpc) ?? 0,
    defaultDurationSlots: toNumber(row.default_duration_slots) ?? 1,
  }
}

export type PhaseTemplateRow = {
  id: string
  project_id: string | null
  name: string
  description: string | null
  is_builtin: boolean
  created_at: string
  phase_template_steps?: PhaseTemplateStepRow[] | null
}

export function rowToPhaseTemplate(row: PhaseTemplateRow): PhaseTemplate {
  const steps = (row.phase_template_steps ?? [])
    .slice()
    .sort((a, b) => (toNumber(a.sort_order) ?? 0) - (toNumber(b.sort_order) ?? 0))
    .map(rowToPhaseTemplateStep)

  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? '',
    isBuiltin: row.is_builtin,
    steps,
  }
}

/* ------------------------------------------------------------ cost settings -- */

export type ProjectCostSettingsRow = {
  project_id: string
  tpc_factor: number | string | null
  base_year: number | string | null
  escalation_mode: string | null
  escalation_annual_percent: number | string | null
  escalation_step_years: number | string | null
  escalation_basis: string | null
  escalation_confidence_years: number | string | null
  default_phase_template_id: string | null
}

export type EscalationRateOverrideRow = {
  project_id: string
  year_offset: number | string
  rate_percent: number | string
}

/**
 * Mirrors the column defaults in migration 0006 / `DEFAULT_COST_SETTINGS` in
 * lib/cost-model.ts, restated here rather than imported so this file keeps
 * its existing rule of owning every default by itself. Pass `null` row and
 * an empty overrides array for a project that has never had a settings row
 * written - a supported state, not an error (see the RLS note on
 * `getCostSettingsForProject` in lib/store.ts: a non-admin write is filtered
 * to 0 rows rather than erroring, so "no row yet" is common).
 */
export function rowToCostSettings(
  row: Partial<ProjectCostSettingsRow> | null | undefined,
  overrideRows: readonly EscalationRateOverrideRow[],
  projectId: string
): ProjectCostSettings {
  const tpcFactorValue = toNumber(row?.tpc_factor)
  const tpcFactor = tpcFactorValue !== null && tpcFactorValue > 0 ? tpcFactorValue : 1.33

  const baseYearValue = toNumber(row?.base_year)
  const baseYear = baseYearValue !== null ? Math.round(baseYearValue) : new Date().getUTCFullYear()

  const escalationMode: EscalationMode =
    row?.escalation_mode === 'stepped' ? 'stepped' : 'compound_annual'

  const annualPercentValue = toNumber(row?.escalation_annual_percent)
  const escalationAnnualPercent =
    annualPercentValue !== null && annualPercentValue >= 0 ? annualPercentValue : 4

  const stepYearsValue = toNumber(row?.escalation_step_years)
  const escalationStepYears =
    stepYearsValue !== null && stepYearsValue > 0 ? Math.round(stepYearsValue) : 5

  const escalationBasis: EscalationBasis = row?.escalation_basis === 'start' ? 'start' : 'midpoint'

  const confidenceValue = toNumber(row?.escalation_confidence_years)
  const escalationConfidenceYears =
    confidenceValue !== null && confidenceValue >= 0 ? Math.round(confidenceValue) : 5

  return {
    projectId: row?.project_id ?? projectId,
    tpcFactor,
    baseYear,
    escalationMode,
    escalationAnnualPercent,
    escalationStepYears,
    escalationBasis,
    escalationConfidenceYears,
    defaultPhaseTemplateId: row?.default_phase_template_id ?? null,
    rateOverrides: overrideRows
      .map((o) => ({
        yearOffset: toNumber(o.year_offset) ?? 0,
        ratePercent: toNumber(o.rate_percent) ?? 0,
      }))
      .sort((a, b) => a.yearOffset - b.yearOffset),
  }
}

export function costSettingsToRow(
  settings: Pick<
    ProjectCostSettings,
    | 'projectId'
    | 'tpcFactor'
    | 'baseYear'
    | 'escalationMode'
    | 'escalationAnnualPercent'
    | 'escalationStepYears'
    | 'escalationBasis'
    | 'escalationConfidenceYears'
    | 'defaultPhaseTemplateId'
  >
): ProjectCostSettingsRow {
  return {
    project_id: settings.projectId,
    tpc_factor: settings.tpcFactor,
    base_year: settings.baseYear,
    escalation_mode: settings.escalationMode,
    escalation_annual_percent: settings.escalationAnnualPercent,
    escalation_step_years: settings.escalationStepYears,
    escalation_basis: settings.escalationBasis,
    escalation_confidence_years: settings.escalationConfidenceYears,
    default_phase_template_id: settings.defaultPhaseTemplateId,
  }
}

/* ---------------------------------------------------------- energy settings -- */

export type ProjectEnergySettingsRow = {
  project_id: string
  unit_label: string | null
  baseline_annual: number | string | null
  interaction_factor: number | string | null
}

/** Mirrors `DEFAULT_ENERGY_SETTINGS` in lib/cost-model.ts - see the comment
 *  on `rowToCostSettings` for why the defaults are restated rather than
 *  imported. */
export function rowToEnergySettings(
  row: Partial<ProjectEnergySettingsRow> | null | undefined,
  projectId: string
): ProjectEnergySettings {
  const unitLabel = row?.unit_label && row.unit_label.trim() !== '' ? row.unit_label : 'kBtu/yr'

  const baselineValue = toNumber(row?.baseline_annual)
  const baselineAnnual = baselineValue !== null && baselineValue >= 0 ? baselineValue : null

  const interactionValue = toNumber(row?.interaction_factor)
  const interactionFactor =
    interactionValue !== null && interactionValue > 0 ? interactionValue : 1.0

  return {
    projectId: row?.project_id ?? projectId,
    unitLabel,
    baselineAnnual,
    interactionFactor,
  }
}

export function energySettingsToRow(settings: ProjectEnergySettings): ProjectEnergySettingsRow {
  return {
    project_id: settings.projectId,
    unit_label: settings.unitLabel,
    baseline_annual: settings.baselineAnnual,
    interaction_factor: settings.interactionFactor,
  }
}

/* ------------------------------------------------------------- scenarios -- */

export type ScenarioRow = {
  id: string
  project_id: string
  name: string
  description: string | null
  owner_email: string
  visibility: string
  payload: unknown
  payload_version?: number | null
  baseline_fingerprint: string | null
  created_at: string
  updated_at: string
  published_at: string | null
}

/**
 * The payload is a jsonb blob the database builds, so nothing in the schema
 * constrains its shape on the way out. It is narrowed defensively rather than
 * cast: a malformed payload must render as an empty overlay (the user sees the
 * baseline and can discard the scenario) rather than throwing inside a render
 * and taking the whole Timeline down with it.
 */
function toScenarioPayload(value: unknown): ScenarioPayload {
  const raw = (value ?? {}) as Record<string, unknown>

  const phases = Array.isArray(raw.phases)
    ? raw.phases.flatMap((entry): ScenarioPhase[] => {
        const p = entry as Record<string, unknown>
        if (typeof p.id !== 'string') return []
        return [
          {
            id: p.id,
            chunkProjectId: String(p.chunk_project_id ?? ''),
            name: String(p.name ?? ''),
            kind: (p.kind as ScenarioPhase['kind']) ?? 'construction',
            sortOrder: toNumber(p.sort_order) ?? 0,
            pctOfTpc: toNumber(p.pct_of_tpc) ?? 0,
            startSlot: toNumber(p.start_slot) ?? 0,
            durationSlots: Math.max(toNumber(p.duration_slots) ?? 1, 1),
            durationLocked: p.duration_locked === true,
          },
        ]
      })
    : []

  const dependencies = Array.isArray(raw.dependencies)
    ? raw.dependencies.flatMap((entry): ScenarioDependency[] => {
        const d = entry as Record<string, unknown>
        if (typeof d.id !== 'string') return []
        return [
          {
            id: d.id,
            predecessorPhaseId: String(d.predecessor_phase_id ?? ''),
            successorPhaseId: String(d.successor_phase_id ?? ''),
            depType: (d.dep_type as ScenarioDependency['depType']) ?? 'FS',
            lagSlots: toNumber(d.lag_slots) ?? 0,
          },
        ]
      })
    : []

  return { phases, dependencies }
}

export function rowToScenario(row: ScenarioRow): Scenario {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? '',
    ownerEmail: row.owner_email,
    visibility: row.visibility === 'project' ? 'project' : 'private',
    payload: toScenarioPayload(row.payload),
    baselineFingerprint: row.baseline_fingerprint ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }
}

/** Domain phases -> the payload shape the publish RPC reads. Only the movable
 *  fields are written back; everything else in the payload is carried through
 *  untouched so a future column does not silently get reset to a default. */
export function scenarioPayloadToRow(payload: ScenarioPayload): Record<string, unknown> {
  return {
    phases: payload.phases.map((p) => ({
      id: p.id,
      chunk_project_id: p.chunkProjectId,
      name: p.name,
      kind: p.kind,
      sort_order: p.sortOrder,
      pct_of_tpc: p.pctOfTpc,
      start_slot: p.startSlot,
      duration_slots: p.durationSlots,
      duration_locked: p.durationLocked,
    })),
    dependencies: payload.dependencies.map((d) => ({
      id: d.id,
      predecessor_phase_id: d.predecessorPhaseId,
      successor_phase_id: d.successorPhaseId,
      dep_type: d.depType,
      lag_slots: d.lagSlots,
    })),
  }
}
