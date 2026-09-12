export type UserRole = 'admin' | 'consultant'

export type ConsultantType =
  | 'Architecture'
  | 'Accessibility'
  | 'Civil'
  | 'Electrical'
  | 'Envelope'
  | 'Fire Alarm'
  | 'Hazardous Materials'
  | 'Historic Preservation'
  | 'Landscape'
  | 'Mechanical'
  | 'Plumbing'
  | 'Structural'
  | 'Security'
  | 'Telecom'

export type SafeUser = {
  email: string
  role: UserRole
  name: string
}

export type ProjectConsultant = {
  type: ConsultantType
  orgName: string
  emails: string[]
}

export type Project = {
  id: string
  name: string
  consultants: ProjectConsultant[]
  assignedUsers: string[]
  createdAt: string
}

export type LineItemCategory =
  | 'END OF LIFE'
  | 'DEFERRED MAINTENANCE'
  | 'UPGRADES / IMPROVEMENTS'
  | 'RESTORATION *'
  | 'STUDY / DOCUMENTATION'

export type TimelinePriority =
  | '0_PRIORITY *'
  | '1_HIGH <5 years'
  | '2_MID 5-10 years'
  | '3_LOW 10-20 years'
  | '4_FUTURE >20 years'
  | '5_250th ANNIVERSARY'

export type BuildingAreaImpacted =
  | 'WHOLE BUILDING'
  | 'ANNEX'
  | 'WEST WING'
  | 'EAST WING'
  | 'BULFINCH'
  | 'SITE'
  | 'OTHER *'

export type BuildingLevelImpacted =
  | 'WHOLE BUILDING'
  | 'ROOF'
  | 'ENVELOPE (EXT. WALLS)'
  | 'LEVELS ABOVE GRADE'
  | 'LEVELS BELOW GRADE'
  | 'L5'
  | 'L4'
  | 'L3'
  | 'L2'
  | 'L1'
  | 'BASEMENT'
  | 'SUB BASEMENT'
  | 'OTHER *'

export type RelativeImpact = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH'

export type RelativeFirstCost = '$LOW' | '$$Moderate' | '$$$High'

export type RelativeOperationCostImpact =
  | 'MINIMAL IMPACT'
  | 'MODERATE REDUCTION'
  | 'HIGH REDUCTION'
  | 'INCREASE'
  | 'N/A'

export type RelativeOperationalEnergyUsage =
  | 'MINIMAL IMPACT'
  | 'MODERATE REDUCTION'
  | 'HIGH REDUCTION'
  | 'N/A'

export type BooleanChoice = 'Yes' | 'No'

export type LineItem = {
  id: string
  projectId: string
  userEmail: string
  consultantType: ConsultantType | 'Admin'
  companyName: string
  discipline: ConsultantType | 'Admin'
  itemNumber: string
  name: string
  shortDescription: string
  /*
   * These four are `string`, not the union types below them, and that is not
   * laziness.
   *
   * Migration 0008 dropped the CHECK constraints that made them closed sets
   * and replaced them with a trigger validating against
   * `ship.project_taxonomy_values` -- a PER-PROJECT vocabulary. The database
   * now accepts whatever this project's taxonomy says, so a union listing one
   * building's wings would be a type that claims more than it can deliver: it
   * would reject a legal value from any other firm's campus.
   *
   * The unions are kept as the DEFAULT vocabulary (lib/constants.ts seeds new
   * projects from them, and migration 0008 does the same server-side), which
   * is a genuinely different thing from "the set of legal values".
   */
  category: string
  timelinePriority: string
  buildingAreaImpacted: string
  buildingLevelImpacted: string
  operationalImpact: RelativeImpact
  benefitToUsers: RelativeImpact
  benefitToPublic: RelativeImpact
  relativeFirstCost: RelativeFirstCost
  estimatedFirstCost: string
  relativeOperationCostImpact: RelativeOperationCostImpact
  relativeOperationalEnergyUsage: RelativeOperationalEnergyUsage
  electrificationEO594: RelativeImpact
  addressingResiliencySustainability: BooleanChoice
  addressingDeferredMaintenance: BooleanChoice
  codeLifeSafetyImprovement: BooleanChoice
  accessibilityImprovement: BooleanChoice
  historicImpact: BooleanChoice
  potentialSynergies: ConsultantType[]
  supportingNotes: string
  createdAt: string
  // v2 (migration 0006). eccAmount is READ ONLY from here: a DB trigger
  // (ship.sync_line_item_ecc) derives it from estimatedFirstCost on every
  // write, so sending it back is at best a no-op and at worst a stale value
  // that loses a race with the trigger's own recompute. lib/mappers.ts strips
  // it from every write path.
  eccAmount: number
  annualEnergySavings: number
  annualCostSavings: number
  energyNotes: string
}

export type ChunkProjectItem = {
  lineItemId: string
  quantity: string
}

export type ChunkTimelineSegment = {
  id: string
  start: number
  duration: number
}

export type TimelineInterval =
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'bi-yearly'
  | '3-yearly'
  | '5-yearly'

export type ChunkProject = {
  id: string
  projectId: string
  chunkNumber: string
  name: string
  itemLinks: ChunkProjectItem[]
  timelineSegments: ChunkTimelineSegment[]
  timelineStart: number
  timelineDuration: number
  createdAt: string
}

export type FiscalYearLabelsBy = 'start_year' | 'end_year'

export type ProjectTimelineSettings = {
  projectId: string
  years: number
  interval: TimelineInterval
  zoomLevel: number
  escalationPercent: number
  escalationEveryYears: number
  // v2 (migration 0006). Anchors slot 0 to a real calendar year so
  // escalation and fiscal-year reporting mean something; see
  // lib/cost-model.ts TimelineGeometry, which these three feed directly.
  startCalendarYear: number
  fiscalYearStartMonth: number
  fiscalYearLabelsBy: FiscalYearLabelsBy
}

/* --------------------------------------------------------- v2: phasing --- */
// See supabase/migrations/0007_ship_phases.sql and
// docs/SPEC-v2-phasing-and-cost-model.md §1.1/§1.4/§2 for the "why" behind
// this shape. Names here are intentionally the same words used in
// lib/cost-model.ts's own Phase / PhaseDependency / CostSettings /
// EnergySettings types - those are the pure-function engine's view (no ids
// tying them to a project), these are the persisted, store-layer view. Do
// not try to unify the two: the engine's types are deliberately storage
// agnostic so tests can construct them by hand.

export type PhaseKind = 'study' | 'design' | 'construction' | 'closeout'

/** Precedence Diagramming Method link types. FS is ~all real usage; the
 *  other three are one line of arithmetic each in the engine, and omitting
 *  them would only guarantee a migration later. */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

export type EscalationMode = 'compound_annual' | 'stepped'

/** Which point in a phase the escalation clock is read at. See
 *  ship.project_cost_settings.escalation_basis for the full rationale. */
export type EscalationBasis = 'midpoint' | 'start'

export type ChunkPhase = {
  id: string
  chunkProjectId: string
  // Provenance only. Null once a user has edited the phase away from its
  // template starting point - a template change must never reach back into
  // packages already built from it (that would silently re-price scheduled
  // work), so this is not a live foreign key relationship in the UI's eyes.
  templateStepId: string | null
  name: string
  kind: PhaseKind
  sortOrder: number
  // Share of the package's TPC, 0-100. Should sum to 100 across a package's
  // phases; deliberately NOT enforced or auto-normalised here or in the DB -
  // rescaling a number a cost estimator typed is worse than showing them
  // it's wrong. See lib/cost-model.ts summarisePackage.
  pctOfTpc: number
  startSlot: number
  durationSlots: number
  // Fixed Duration in the MS Project sense: the bar's length is constant,
  // its position is not. A locked phase can still be moved.
  durationLocked: boolean
  createdAt: string
}

export type PhaseDependency = {
  id: string
  // Denormalised onto the row by a DB trigger from the predecessor phase -
  // never send this on insert, see lib/store.ts createPhaseDependency.
  projectId: string
  predecessorPhaseId: string
  successorPhaseId: string
  depType: DependencyType
  // In slots. May be negative, which is a lead ("bidding can overlap the
  // tail of CD").
  lagSlots: number
}

export type PhaseTemplateStep = {
  id: string
  templateId: string
  name: string
  kind: PhaseKind
  sortOrder: number
  defaultPctOfTpc: number
  defaultDurationSlots: number
}

export type PhaseTemplate = {
  id: string
  // Null means built-in: readable by every SHIP user, writable by nobody
  // through the API. See ship.phase_templates' builtin check constraint.
  projectId: string | null
  name: string
  description: string
  isBuiltin: boolean
  steps: PhaseTemplateStep[]
}

export type ProjectCostSettings = {
  projectId: string
  tpcFactor: number
  baseYear: number
  escalationMode: EscalationMode
  escalationAnnualPercent: number
  escalationStepYears: number
  escalationBasis: EscalationBasis
  escalationConfidenceYears: number
  defaultPhaseTemplateId: string | null
  // year offset from baseYear -> percent override. A single compound rate
  // cannot express "the next year or two are forecastable, the rest isn't" -
  // see lib/cost-model.ts escalationFactor, which consumes this as a Map.
  rateOverrides: Array<{ yearOffset: number; ratePercent: number }>
}

/**
 * Which line-item dropdown a taxonomy value belongs to.
 *
 * These four fields were `CHECK (col in (...))` constraints full of one
 * building's vocabulary -- 'ANNEX', 'WEST WING', 'BULFINCH',
 * '5_250th ANNIVERSARY'. Migration 0008 moved them to per-project rows so a
 * different firm on a different campus is not stuck naming their wings after
 * someone else's. See R9 in the v2 spec.
 */
export type TaxonomyKind =
  | 'building_area'
  | 'building_level'
  | 'category'
  | 'timeline_priority'

export type ProjectTaxonomyValue = {
  projectId: string
  kind: TaxonomyKind
  value: string
  sortOrder: number
  /** Soft delete. A value already written onto line items cannot just be
   *  removed -- those rows would still carry it and would stop validating on
   *  the next edit. Archiving stops it being OFFERED in new dropdowns while
   *  every historical record keeps working. */
  isArchived: boolean
}

export type ProjectEnergySettings = {
  projectId: string
  // Free text on purpose - see ship.project_energy_settings.unit_label:
  // the practice doesn't yet know its units project to project (kBtu, kWh,
  // therms, MMBtu, EUI, MTCO2e, or plain dollars), and a CHECK constraint
  // here would guarantee a migration the week the units are decided.
  unitLabel: string
  baselineAnnual: number | null
  interactionFactor: number
}

/**
 * A branched copy of a project's schedule — the Revit local-copy model the
 * client asked for by name.
 *
 * `payload` is deliberately untyped here. It is built and consumed exclusively
 * by `ship.create_scenario()` / `publish_scenario()` / `rebase_scenario()`; the
 * client overlays it in memory but never authors it, because a client-authored
 * payload would be an arbitrary-write primitive into the baseline. See
 * supabase/migrations/0010_ship_scenarios.sql.
 */
export type Scenario = {
  id: string
  projectId: string
  name: string
  description: string
  ownerEmail: string
  visibility: 'private' | 'project'
  payload: ScenarioPayload
  baselineFingerprint: string
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

/** The subset of a phase a scenario can move. Structural edits (adding or
 *  deleting phases) are deliberately out of scope — see the migration. */
export type ScenarioPhase = {
  id: string
  chunkProjectId: string
  name: string
  kind: PhaseKind
  sortOrder: number
  pctOfTpc: number
  startSlot: number
  durationSlots: number
  durationLocked: boolean
}

export type ScenarioDependency = {
  id: string
  predecessorPhaseId: string
  successorPhaseId: string
  depType: DependencyType
  lagSlots: number
}

export type ScenarioPayload = {
  phases: ScenarioPhase[]
  dependencies: ScenarioDependency[]
}
