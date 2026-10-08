export type UserRole = 'admin' | 'consultant'

/** The built-in disciplines (the dropdown list; each has a fixed item-number prefix). */
export type KnownConsultantType =
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

/**
 * A discipline: one of the built-in names, or a custom one an admin typed via
 * "Other…" (migration 0022). `string & {}` keeps editor completion for the
 * known names while accepting any string, so code must not assume the closed
 * set -- anything keyed by discipline (colours, ordering) needs a fallback.
 */
export type ConsultantType = KnownConsultantType | (string & {})

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
  // `projects.updated_at`, bumped by every `update_project` call. Pass it back
  // as `expectedUpdatedAt` to lib/store.ts updateProject so a Settings save
  // made from a stale draft is refused instead of silently replacing a
  // colleague's roster edit (DATA-19). Optional only so the handful of places
  // that build a Project literal by hand keep compiling; rowToProject always
  // sets it.
  updatedAt?: string | null
}

/**
 * "You've been added to <project>" -- one row of `ship.project_access_notices`
 * (migration 0013, product decision D-7). Written by the invite route (service
 * role) when an invite names someone who ALREADY has an account; read back on
 * their next sign-in and shown as a toast, then stamped `seenAt`. RLS limits
 * both the read and the update to rows addressed to the caller's own email.
 */
export type AccessNotice = {
  id: string
  email: string
  projectId: string
  // Resolved separately from the notice row (see lib/store.ts
  // fetchAccessNotices); falls back to the project id when the caller can't
  // read the project (e.g. access was granted and then revoked again).
  projectName: string
  createdAt: string
  seenAt: string | null
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
  addressingResiliencySustainability: BooleanChoice | null
  addressingDeferredMaintenance: BooleanChoice | null
  codeLifeSafetyImprovement: BooleanChoice | null
  accessibilityImprovement: BooleanChoice | null
  historicImpact: BooleanChoice | null
  potentialSynergies: ConsultantType[]
  supportingNotes: string
  createdAt: string
  // v2 (migration 0006). eccAmount is READ ONLY from here: a DB trigger
  // (ship.sync_line_item_ecc) derives it from estimatedFirstCost on every
  // write, so sending it back is at best a no-op and at worst a stale value
  // that loses a race with the trigger's own recompute. lib/mappers.ts strips
  // it from every write path.
  //
  // `null` since migration 0019: no number could be derived -- unanswered
  // when estimatedFirstCost is blank, unreadable when it isn't (tell the two
  // apart from the text with lib/costs.ts isUnreadableCost). Sums treat null
  // as 0 (`?? 0`); display code should not show it as "$0".
  eccAmount: number | null
  // D-9: blank is a real answer. `null` means "not answered", `0` means "no
  // saving". The columns became nullable in migration 0014; lib/mappers.ts
  // maps a blank/unparseable value to null in BOTH directions, so consumers
  // that sum these must decide what blank means for them (usually `?? 0`)
  // rather than having the mapper silently decide it for every caller.
  annualEnergySavings: number | null
  annualCostSavings: number | null
  energyNotes: string
  // v2 (migration 0012). Values for `storage='custom'` form_fields, keyed by
  // FormField.key. Built-in fields (the properties above) never appear in
  // here -- they live in their own column and are read/written the normal
  // way. See the FormField/FormFieldStorage comment below for the full
  // column-vs-custom split.
  //
  // Optional (unlike every other field on this type) because the column
  // itself is `not null default '{}'`: a caller building a line item that
  // predates the form builder, or that has no custom fields to set, can
  // simply omit this and get the same object rowToLineItem would have
  // produced anyway. lineItemToRow only sends it when present.
  customFields?: Record<string, unknown>
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
  // The DEFAULT VIEW only (D-1). Each viewer zooms locally on the Timeline;
  // nothing that is priced, stored or exported depends on either of these
  // since schedules moved to months (migration 0020).
  interval: TimelineInterval
  zoomLevel: number
  escalationPercent: number
  escalationEveryYears: number
  // v2 (migration 0006). Anchors slot 0 to a real calendar year so
  // escalation and fiscal-year reporting mean something; see
  // lib/cost-model.ts TimelineGeometry, which these three feed directly.
  //
  // `null` = "not set" (M-25). Migration 0018 guarantees every project has a
  // row with a real year, so null should never be seen in practice; when it
  // is, it is surfaced as missing rather than defaulted to the viewer's
  // current year, which used to shift every FY label and escalation anchor by
  // one on 1 January without anyone touching the project.
  startCalendarYear: number | null
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
  // Months from January of the timeline's start year, and length in months
  // (D-1). Stored in chunk_phases.start_slot / duration_slots -- the column
  // names predate the change; migration 0020 converted every row and
  // comments the columns. NEVER zoom-dependent: the zoom is a view.
  startMonth: number
  durationMonths: number
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
  // In months (column lag_slots, see migration 0020). May be negative,
  // which is a lead ("bidding can overlap the tail of CD").
  lagMonths: number
}

export type PhaseTemplateStep = {
  id: string
  templateId: string
  name: string
  kind: PhaseKind
  sortOrder: number
  defaultPctOfTpc: number
  // Months (column default_duration_slots, see migration 0020).
  defaultDurationMonths: number
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
  // `null` = "not set" -- same reasoning as ProjectTimelineSettings
  // .startCalendarYear (M-25). Never defaulted to "now" by the mapper:
  // a money base year that drifts with the clock re-prices the whole plan
  // every New Year. Consumers must treat null as an error state
  // ("base year not set"), not invent a year.
  baseYear: number | null
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

/**
 * The line-item FORM ITSELF, as data (migration 0012). Supersedes the fixed
 * 20-question wizard `TaxonomyKind` above was patching the vocabulary for --
 * this is the fields, not just their values.
 */
export type FormFieldInputType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'currency'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'date'

/**
 * Where a field's value actually lives, and the reason `storage` and
 * `isBuiltin` exist at all: every field that shipped before this migration
 * (name, estimated_first_cost, annual_energy_savings, ...) is a real column
 * on `line_items`, and other code reads those columns by name -- ecc_amount
 * is derived from estimated_first_cost, the energy chart reads
 * annual_energy_savings, numbering reads discipline. Those fields can be
 * relabelled, reordered, regrouped and hidden from a settings screen, but
 * deleting one or changing its input type would leave code reading a column
 * that no longer means what the form claims (or, for delete, a column with
 * no form control at all), so the database refuses both outright.
 *
 *   'column' -- backed by a real line_items column of the same name as
 *               `key`. Always `isBuiltin: true`.
 *   'custom' -- lives in LineItem.customFields, keyed by `key`. Fully
 *               editable and deletable; this is what "add a field" creates.
 */
export type FormFieldStorage = 'column' | 'custom'

export type FormFieldOption = {
  id: string
  fieldId: string
  value: string
  label: string
  sortOrder: number
  /** Soft delete, same rationale as ProjectTaxonomyValue.isArchived above: a
   *  value already written onto a line item cannot be withdrawn without that
   *  item failing validation on its next edit. */
  isArchived: boolean
}

export type FormField = {
  id: string
  projectId: string
  // Stable identifier. For a built-in it IS the line_items column name --
  // that's what lets code map a field definition onto a column without a
  // lookup table -- so it is immutable once created (enforced both by the
  // DB trigger for built-ins and by lib/store.ts createFormField deriving it
  // once, for custom fields).
  key: string
  label: string
  helpText: string
  inputType: FormFieldInputType
  storage: FormFieldStorage
  // Free text wizard-step name, same reasoning as ship.form_fields.group_label:
  // a firm that wants a different set of steps should not need a migration.
  groupLabel: string
  sortOrder: number
  isRequired: boolean
  // Hidden fields are still returned by getFormFieldsForProject -- the
  // builder needs to show them so they can be un-hidden -- and filtered out
  // by the pure helper `visibleFormFields` for the actual Add Data form.
  isHidden: boolean
  /** See FormFieldStorage above: true for every field ship.seed_default_form
   *  created. This is what ship.guard_form_field keys off to refuse a delete
   *  or a retype, and what a settings UI should key off to grey those
   *  controls out rather than let the user hit the database error. */
  isBuiltin: boolean
  config: Record<string, unknown>
  options: FormFieldOption[]
  createdAt: string
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
  // Months, like ChunkPhase. The payload's jsonb keys are still
  // `start_slot` / `duration_slots` (the RPCs read them by name); migration
  // 0020 converted their values.
  startMonth: number
  durationMonths: number
  durationLocked: boolean
}

export type ScenarioDependency = {
  id: string
  predecessorPhaseId: string
  successorPhaseId: string
  depType: DependencyType
  lagMonths: number
}

export type ScenarioPayload = {
  phases: ScenarioPhase[]
  dependencies: ScenarioDependency[]
}
