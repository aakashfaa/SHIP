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
  ChunkProject,
  ChunkProjectItem,
  ChunkTimelineSegment,
  ConsultantType,
  LineItem,
  Project,
  ProjectConsultant,
  ProjectTimelineSettings,
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
]

/**
 * Maps only the keys actually present on `patch`, so the same function serves
 * both inserts and partial updates. Callers must not send `company_name`,
 * `discipline` or `item_number` on insert - those are filled by triggers.
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

  return {
    projectId: row?.project_id ?? projectId,
    years,
    // Column is `interval_unit`; `interval` is a reserved Postgres type name.
    interval: (row?.interval_unit as TimelineInterval) || 'yearly',
    zoomLevel,
    escalationPercent,
    escalationEveryYears,
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
  }
}
