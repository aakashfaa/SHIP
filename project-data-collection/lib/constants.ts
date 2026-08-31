/**
 * Enum-like label lists for the SHIP data model.
 *
 * IMPORTANT: every list in this file is mirrored by a CHECK constraint in
 * `supabase/migrations/0001_ship_schema.sql`. The two are a single contract:
 * if you add, remove or rename a value here you MUST change the matching CHECK
 * constraint in that migration in the same commit, and vice-versa. A value that
 * exists in only one of the two places will fail at insert time with a
 * `violates check constraint` error rather than at compile time.
 *
 * The union types themselves live in `lib/types.ts` — these arrays are the
 * runtime (iterable, dropdown-renderable) form of those types, and the
 * `satisfies` clauses keep the two from drifting apart.
 */

import {
  BooleanChoice,
  BuildingAreaImpacted,
  BuildingLevelImpacted,
  ConsultantType,
  LineItemCategory,
  RelativeFirstCost,
  RelativeImpact,
  RelativeOperationCostImpact,
  RelativeOperationalEnergyUsage,
  TimelineInterval,
  TimelinePriority,
} from './types'

export const CONSULTANT_TYPES = [
  'Architecture',
  'Accessibility',
  'Civil',
  'Electrical',
  'Envelope',
  'Fire Alarm',
  'Hazardous Materials',
  'Historic Preservation',
  'Landscape',
  'Mechanical',
  'Plumbing',
  'Structural',
  'Security',
  'Telecom',
] as const satisfies readonly ConsultantType[]

export const LINE_ITEM_CATEGORIES = [
  'END OF LIFE',
  'DEFERRED MAINTENANCE',
  'UPGRADES / IMPROVEMENTS',
  'RESTORATION *',
  'STUDY / DOCUMENTATION',
] as const satisfies readonly LineItemCategory[]

export const TIMELINE_PRIORITIES = [
  '0_PRIORITY *',
  '1_HIGH <5 years',
  '2_MID 5-10 years',
  '3_LOW 10-20 years',
  '4_FUTURE >20 years',
  '5_250th ANNIVERSARY',
] as const satisfies readonly TimelinePriority[]

export const BUILDING_AREAS = [
  'WHOLE BUILDING',
  'ANNEX',
  'WEST WING',
  'EAST WING',
  'BULFINCH',
  'SITE',
  'OTHER *',
] as const satisfies readonly BuildingAreaImpacted[]

export const BUILDING_LEVELS = [
  'WHOLE BUILDING',
  'ROOF',
  'ENVELOPE (EXT. WALLS)',
  'LEVELS ABOVE GRADE',
  'LEVELS BELOW GRADE',
  'L5',
  'L4',
  'L3',
  'L2',
  'L1',
  'BASEMENT',
  'SUB BASEMENT',
  'OTHER *',
] as const satisfies readonly BuildingLevelImpacted[]

export const RELATIVE_IMPACTS = [
  'NONE',
  'LOW',
  'MODERATE',
  'HIGH',
] as const satisfies readonly RelativeImpact[]

export const RELATIVE_FIRST_COSTS = [
  '$LOW',
  '$$Moderate',
  '$$$High',
] as const satisfies readonly RelativeFirstCost[]

export const RELATIVE_OPERATION_COST_IMPACTS = [
  'MINIMAL IMPACT',
  'MODERATE REDUCTION',
  'HIGH REDUCTION',
  'INCREASE',
  'N/A',
] as const satisfies readonly RelativeOperationCostImpact[]

export const RELATIVE_OPERATIONAL_ENERGY_USAGES = [
  'MINIMAL IMPACT',
  'MODERATE REDUCTION',
  'HIGH REDUCTION',
  'N/A',
] as const satisfies readonly RelativeOperationalEnergyUsage[]

export const BOOLEAN_CHOICES = ['Yes', 'No'] as const satisfies readonly BooleanChoice[]

export const TIMELINE_INTERVALS = [
  'monthly',
  'quarterly',
  'yearly',
  'bi-yearly',
  '3-yearly',
  '5-yearly',
] as const satisfies readonly TimelineInterval[]
