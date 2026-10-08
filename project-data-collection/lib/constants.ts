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

import type {
  BooleanChoice,
  BuildingAreaImpacted,
  BuildingLevelImpacted,
  ConsultantType,
  KnownConsultantType,
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
] as const satisfies readonly KnownConsultantType[]

/**
 * Disciplines are NOT limited to CONSULTANT_TYPES: an admin can add a custom
 * one ("Other…"). Migration 0022 replaced the discipline CHECK lists with a
 * shape check that mirrors the rules below (non-blank, at most
 * MAX_DISCIPLINE_LENGTH characters, no control characters, not "Admin") and
 * stores roster names via ship.canonical_discipline(), which does what
 * normalizeDisciplineName() does. A custom discipline's item-number prefix is
 * assigned by the database; the UI never picks or shows it.
 */
export const MAX_DISCIPLINE_LENGTH = 60

export function isKnownConsultantType(value: string): value is KnownConsultantType {
  return (CONSULTANT_TYPES as readonly string[]).includes(value)
}

// The exact whitespace set ship.canonical_discipline() collapses (0022).
// Spelled out because JS \s and Postgres \s differ.
const DISCIPLINE_WHITESPACE =
  /[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g

/**
 * Trims, collapses inner whitespace, and maps a case-insensitive match of a
 * built-in discipline to its canonical spelling ("fire  alarm" -> "Fire Alarm").
 */
export function normalizeDisciplineName(value: string): ConsultantType {
  const cleaned = value.replace(DISCIPLINE_WHITESPACE, ' ').replace(/^ +| +$/g, '')
  const known = CONSULTANT_TYPES.find((type) => type.toLowerCase() === cleaned.toLowerCase())
  return known ?? cleaned
}

// = ship.is_valid_discipline()'s '[\u0001-\u001f\u007f-\u009f]' (U+0000
// cannot be stored at all).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

/**
 * Validates a typed ("Other…") discipline name against the disciplines already
 * in use. Returns an error message, or null when the name can be used. Pass
 * the already-normalized name.
 */
export function customDisciplineError(name: string, existing: readonly string[]): string | null {
  if (!name) return 'Enter a discipline name.'
  // Code points, like Postgres char_length() (an emoji is 1, not 2).
  if ([...name].length > MAX_DISCIPLINE_LENGTH) {
    return `Keep the discipline name to ${MAX_DISCIPLINE_LENGTH} characters or fewer.`
  }
  if (CONTROL_CHARS.test(name)) return 'The discipline name contains invalid characters.'
  const lower = name.toLowerCase()
  if (lower === 'admin') return '"Admin" can\'t be used as a discipline.'
  if (existing.some((type) => type.toLowerCase() === lower)) {
    return `${name} is already on this project.`
  }
  return null
}

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
