/**
 * Data layer for the SHIP app: thin wrappers over Supabase queries against the
 * `ship` schema, plus the row <-> domain mappers in `lib/mappers.ts`.
 *
 * Everything here runs against the browser client, so these functions are for
 * Client Components. Slug generation, item/chunk numbering, company-name
 * derivation, discipline normalization and invite seeding all live in SQL
 * (triggers + the `create_project` / `update_project` RPCs) and are no longer
 * duplicated here.
 *
 * RLS denials surface as an empty result set on reads and as an error on
 * writes; both are allowed to propagate to the caller.
 */

import { getSupabaseBrowserClient } from './supabase/client'
import {
  ChunkPhaseRow,
  ChunkProjectRow,
  EscalationRateOverrideRow,
  LineItemRow,
  PhaseDependencyRow,
  PhaseTemplateRow,
  PhaseTemplateStepRow,
  ProjectCostSettingsRow,
  ProjectEnergySettingsRow,
  ProjectRow,
  ScenarioRow,
  TimelineSettingsRow,
  chunkPhaseToRow,
  costSettingsToRow,
  energySettingsToRow,
  lineItemToRow,
  normalizeTimelineSegments,
  phaseDependencyToRow,
  rowToChunkPhase,
  rowToChunkProject,
  rowToCostSettings,
  rowToEnergySettings,
  rowToLineItem,
  rowToPhaseDependency,
  rowToPhaseTemplate,
  rowToProject,
  rowToScenario,
  rowToTimelineSettings,
  scenarioPayloadToRow,
  timelineSettingsToRow,
} from './mappers'
import {
  ChunkPhase,
  ChunkProject,
  ConsultantType,
  DependencyType,
  LineItem,
  PhaseDependency,
  PhaseTemplate,
  Project,
  ProjectConsultant,
  ProjectCostSettings,
  ProjectEnergySettings,
  ProjectTimelineSettings,
  Scenario,
  ScenarioPayload,
} from './types'

const PROJECT_SELECT = '*, project_consultants(*), project_members(*)'
const CHUNK_SELECT = '*, chunk_project_items(*)'

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? 'unknown Supabase error'}`)
}

/**
 * The jsonb `create_project` / `update_project` both return:
 *   { "project_id": "some-slug", "invited_emails": ["a@b.com"] }
 *
 * `invited_emails` is the set the DB actually added to the allowlist on
 * THIS call -- not the project's member list. Callers POST it straight to
 * /api/admin/invite, which mails every address in it, and this Supabase
 * project shares a ~2-4 emails/hour project-wide quota with an unrelated
 * production app. Never widen this to `project.assignedUsers`: that would
 * re-mail every existing consultant on every Save.
 */
type ProjectMutationResult = {
  project_id: string
  invited_emails: string[] | null
}

/** Narrow the RPC's jsonb defensively -- a malformed payload must not
 *  become a silent blast of invite emails. */
function readMutationResult(context: string, data: unknown): ProjectMutationResult {
  const payload = (data ?? {}) as Partial<ProjectMutationResult>
  const projectId = payload.project_id

  if (typeof projectId !== 'string' || projectId === '') {
    fail(context, { message: 'RPC did not return a project_id' })
  }

  const invited = payload.invited_emails
  return {
    project_id: projectId,
    invited_emails: Array.isArray(invited)
      ? invited.filter((email): email is string => typeof email === 'string')
      : [],
  }
}

/* -------------------------------------------------------------- projects -- */

export async function getStoredProjects(): Promise<Project[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_SELECT)
    .order('created_at', { ascending: false })

  if (error) fail('Failed to load projects', error)

  return ((data ?? []) as unknown as ProjectRow[]).map(rowToProject)
}

export async function getProjectById(id: string): Promise<Project | null> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('id', id)
    .maybeSingle()

  if (error) fail(`Failed to load project "${id}"`, error)
  if (!data) return null

  return rowToProject(data as unknown as ProjectRow)
}

export async function createProject(input: {
  name: string
  consultants: ProjectConsultant[]
}): Promise<{ project: Project; invitedEmails: string[] }> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase.rpc('create_project', {
    p_name: input.name.trim(),
    p_consultants: input.consultants,
  })

  if (error) fail('Failed to create project', error)

  const result = readMutationResult('Failed to create project', data)
  const projectId = result.project_id

  const project = await getProjectById(projectId)
  if (!project) fail('Failed to create project', { message: `project "${projectId}" not readable after creation` })

  return { project, invitedEmails: result.invited_emails ?? [] }
}

export async function updateProject(
  projectId: string,
  updates: Partial<Project>
): Promise<{ project: Project; invitedEmails: string[] } | null> {
  const supabase = getSupabaseBrowserClient()

  const existing = await getProjectById(projectId)
  if (!existing) return null

  const { data, error } = await supabase.rpc('update_project', {
    p_project_id: projectId,
    p_name: (updates.name ?? existing.name).trim(),
    p_consultants: updates.consultants ?? existing.consultants,
  })

  if (error) fail(`Failed to update project "${projectId}"`, error)

  const result = readMutationResult(`Failed to update project "${projectId}"`, data)

  const project = await getProjectById(result.project_id)
  if (!project) return null

  return { project, invitedEmails: result.invited_emails ?? [] }
}

export async function addConsultantToProject(
  projectId: string,
  consultant: ProjectConsultant
): Promise<{ project: Project; invitedEmails: string[] } | null> {
  const project = await getProjectById(projectId)
  if (!project) return null
  if (project.consultants.some((c) => c.type === consultant.type)) return null

  return updateProject(projectId, {
    consultants: [...project.consultants, consultant],
  })
}

export async function removeConsultantFromProject(
  projectId: string,
  consultantType: ConsultantType
): Promise<{ project: Project; invitedEmails: string[] } | null> {
  const project = await getProjectById(projectId)
  if (!project) return null

  return updateProject(projectId, {
    consultants: project.consultants.filter((c) => c.type !== consultantType),
  })
}

/* ------------------------------------------------------------ line items -- */

export async function getLineItemsForProject(projectId: string): Promise<LineItem[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('line_items')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (error) fail(`Failed to load line items for project "${projectId}"`, error)

  return ((data ?? []) as unknown as LineItemRow[]).map(rowToLineItem)
}

export async function getLineItemsForProjectUser(
  projectId: string,
  userEmail: string
): Promise<LineItem[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('line_items')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_email', userEmail)
    .order('created_at', { ascending: true })

  if (error) fail(`Failed to load line items for "${userEmail}"`, error)

  return ((data ?? []) as unknown as LineItemRow[]).map(rowToLineItem)
}

export async function createLineItem(
  input: Omit<
    LineItem,
    // `eccAmount` belongs with the other trigger-owned fields: migration 0006
    // recomputes it from `estimated_first_cost` on every write, so accepting it
    // here would let a caller believe they had set a cost that the database
    // immediately overwrote.
    'id' | 'createdAt' | 'companyName' | 'discipline' | 'itemNumber' | 'eccAmount'
  >
): Promise<LineItem> {
  const supabase = getSupabaseBrowserClient()

  // `item_number`, `company_name` and the normalized `discipline` /
  // `consultant_type` are filled by triggers; never send them from here.
  const { data, error } = await supabase
    .from('line_items')
    .insert(lineItemToRow(input))
    .select('*')
    .single()

  if (error) fail('Failed to create line item', error)

  return rowToLineItem(data as unknown as LineItemRow)
}

export async function updateLineItem(
  lineItemId: string,
  updates: Partial<LineItem>
): Promise<LineItem | null> {
  const supabase = getSupabaseBrowserClient()

  const row = lineItemToRow(updates)
  delete row.id
  delete row.created_at

  const { data, error } = await supabase
    .from('line_items')
    .update(row)
    .eq('id', lineItemId)
    .select('*')
    .maybeSingle()

  if (error) fail(`Failed to update line item "${lineItemId}"`, error)
  if (!data) return null

  return rowToLineItem(data as unknown as LineItemRow)
}

export async function deleteLineItem(lineItemId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.from('line_items').delete().eq('id', lineItemId)

  if (error) fail(`Failed to delete line item "${lineItemId}"`, error)
}

/* --------------------------------------------------------- chunk projects -- */

async function fetchChunkProject(chunkId: string): Promise<ChunkProject | null> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('chunk_projects')
    .select(CHUNK_SELECT)
    .eq('id', chunkId)
    .maybeSingle()

  if (error) fail(`Failed to load chunk project "${chunkId}"`, error)
  if (!data) return null

  return rowToChunkProject(data as unknown as ChunkProjectRow)
}

export async function getChunkProjectsForProject(projectId: string): Promise<ChunkProject[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('chunk_projects')
    .select(CHUNK_SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (error) fail(`Failed to load chunk projects for "${projectId}"`, error)

  return ((data ?? []) as unknown as ChunkProjectRow[]).map(rowToChunkProject)
}

export async function createChunkProject(input: {
  projectId: string
  name: string
}): Promise<ChunkProject> {
  const supabase = getSupabaseBrowserClient()

  // `chunk_number` is assigned by a trigger.
  const { data, error } = await supabase
    .from('chunk_projects')
    .insert({ project_id: input.projectId, name: input.name.trim() })
    .select(CHUNK_SELECT)
    .single()

  if (error) fail('Failed to create chunk project', error)

  return rowToChunkProject(data as unknown as ChunkProjectRow)
}

export async function updateChunkProject(
  chunkId: string,
  updates: Partial<ChunkProject>
): Promise<ChunkProject | null> {
  const supabase = getSupabaseBrowserClient()

  const row: Record<string, unknown> = {}
  if (updates.name !== undefined) row.name = updates.name

  if (updates.timelineSegments !== undefined) {
    const segments = normalizeTimelineSegments(
      chunkId,
      updates.timelineSegments,
      updates.timelineStart,
      updates.timelineDuration
    )
    // Keep the scalar columns in sync with segment 0.
    row.timeline_segments = segments
    row.timeline_start = segments[0].start
    row.timeline_duration = segments[0].duration
  } else {
    if (updates.timelineStart !== undefined) row.timeline_start = updates.timelineStart
    if (updates.timelineDuration !== undefined) row.timeline_duration = updates.timelineDuration
  }

  if (Object.keys(row).length === 0) return fetchChunkProject(chunkId)

  const { data, error } = await supabase
    .from('chunk_projects')
    .update(row)
    .eq('id', chunkId)
    .select(CHUNK_SELECT)
    .maybeSingle()

  if (error) fail(`Failed to update chunk project "${chunkId}"`, error)
  if (!data) return null

  return rowToChunkProject(data as unknown as ChunkProjectRow)
}

export async function deleteChunkProject(chunkId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.from('chunk_projects').delete().eq('id', chunkId)

  if (error) fail(`Failed to delete chunk project "${chunkId}"`, error)
}

export async function addLineItemToChunkProject(
  chunkId: string,
  lineItemId: string
): Promise<ChunkProject | null> {
  return addLineItemsToChunkProject(chunkId, [lineItemId])
}

export async function addLineItemsToChunkProject(
  chunkId: string,
  lineItemIds: string[]
): Promise<ChunkProject | null> {
  const supabase = getSupabaseBrowserClient()

  const chunk = await fetchChunkProject(chunkId)
  if (!chunk) return null

  const existing = new Set(chunk.itemLinks.map((link) => link.lineItemId))
  const toAdd = [...new Set(lineItemIds)].filter((id) => !existing.has(id))
  if (toAdd.length === 0) return chunk

  const rows = toAdd.map((lineItemId, index) => ({
    chunk_project_id: chunkId,
    line_item_id: lineItemId,
    quantity: '',
    position: chunk.itemLinks.length + index,
  }))

  const { error } = await supabase.from('chunk_project_items').insert(rows)

  if (error) fail(`Failed to add line items to chunk project "${chunkId}"`, error)

  return fetchChunkProject(chunkId)
}

export async function removeLineItemFromChunkProject(
  chunkId: string,
  lineItemId: string
): Promise<ChunkProject | null> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase
    .from('chunk_project_items')
    .delete()
    .eq('chunk_project_id', chunkId)
    .eq('line_item_id', lineItemId)

  if (error) fail(`Failed to remove line item from chunk project "${chunkId}"`, error)

  return fetchChunkProject(chunkId)
}

export async function updateChunkProjectItemQuantity(
  chunkId: string,
  lineItemId: string,
  quantity: string
): Promise<ChunkProject | null> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase
    .from('chunk_project_items')
    .update({ quantity })
    .eq('chunk_project_id', chunkId)
    .eq('line_item_id', lineItemId)

  if (error) fail(`Failed to update quantity on chunk project "${chunkId}"`, error)

  return fetchChunkProject(chunkId)
}

/* ------------------------------------------------------ timeline settings -- */

export async function getTimelineSettingsForProject(
  projectId: string
): Promise<ProjectTimelineSettings> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('project_timeline_settings')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) fail(`Failed to load timeline settings for "${projectId}"`, error)

  return rowToTimelineSettings(data as unknown as TimelineSettingsRow | null, projectId)
}

export async function updateTimelineSettingsForProject(
  projectId: string,
  updates: Partial<ProjectTimelineSettings>
): Promise<ProjectTimelineSettings> {
  const supabase = getSupabaseBrowserClient()

  const existing = await getTimelineSettingsForProject(projectId)
  const next = rowToTimelineSettings(
    timelineSettingsToRow({ ...existing, ...updates, projectId }),
    projectId
  )

  const { data, error } = await supabase
    .from('project_timeline_settings')
    .upsert(timelineSettingsToRow(next), { onConflict: 'project_id' })
    .select('*')
    .single()

  if (error) fail(`Failed to save timeline settings for "${projectId}"`, error)

  return rowToTimelineSettings(data as unknown as TimelineSettingsRow, projectId)
}

/* ------------------------------------------------------------ chunk phases -- */
// supabase/migrations/0007_ship_phases.sql

export async function getChunkPhasesForProject(projectId: string): Promise<ChunkPhase[]> {
  const supabase = getSupabaseBrowserClient()

  // chunk_phases carries no project_id of its own -- RLS authorises through
  // chunk_project_id (ship.can_access_chunk()), which is fine for row-level
  // security but does not help a query that needs to filter BY project. The
  // `!inner` modifier is load-bearing here: PostgREST's default embed is a
  // left join, so a `.eq` on an embedded column only filters which embedded
  // rows come back, not which top-level rows do -- every phase from every
  // project would still be returned, just with `chunk_projects: null` on the
  // ones that don't match. `!inner` turns it into an actual join, which is
  // what lets the `.eq` act as a WHERE on chunk_phases. Verified against the
  // local stack.
  const { data, error } = await supabase
    .from('chunk_phases')
    .select('*, chunk_projects!inner(project_id)')
    .eq('chunk_projects.project_id', projectId)
    .order('sort_order', { ascending: true })

  if (error) fail(`Failed to load phases for project "${projectId}"`, error)

  return ((data ?? []) as unknown as ChunkPhaseRow[]).map(rowToChunkPhase)
}

export async function createChunkPhase(
  input: Omit<ChunkPhase, 'id' | 'createdAt'>
): Promise<ChunkPhase> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('chunk_phases')
    .insert(chunkPhaseToRow(input))
    .select('*')
    .single()

  if (error) fail('Failed to create phase', error)

  return rowToChunkPhase(data as unknown as ChunkPhaseRow)
}

export async function updateChunkPhase(
  id: string,
  updates: Partial<ChunkPhase>
): Promise<ChunkPhase | null> {
  const supabase = getSupabaseBrowserClient()

  const row = chunkPhaseToRow(updates)

  const { data, error } = await supabase
    .from('chunk_phases')
    .update(row)
    .eq('id', id)
    .select('*')
    .maybeSingle()

  if (error) fail(`Failed to update phase "${id}"`, error)
  if (!data) return null

  return rowToChunkPhase(data as unknown as ChunkPhaseRow)
}

export async function deleteChunkPhase(id: string): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.from('chunk_phases').delete().eq('id', id)

  if (error) fail(`Failed to delete phase "${id}"`, error)
}

/**
 * Persists a full reorder in one round trip via upsert rather than N
 * sequential `.update()` calls. PostgREST's upsert compiles to
 * `INSERT ... ON CONFLICT (id) DO UPDATE SET <only the supplied columns>`,
 * so it never touches `name`, `kind`, `pct_of_tpc`, etc. There is no insert
 * branch to worry about in practice: every id here is an existing phase
 * being reordered, never a new one. `chunk_project_id` is included, at the
 * value the caller already asserts these phases belong to, purely so a
 * caller that accidentally passes a foreign id fails loudly (a NOT NULL /
 * FK mismatch) rather than silently reparenting a phase.
 */
export async function reorderChunkPhases(
  chunkProjectId: string,
  orderedIds: string[]
): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const rows = orderedIds.map((id, index) => ({
    id,
    chunk_project_id: chunkProjectId,
    sort_order: index,
  }))

  if (rows.length === 0) return

  const { error } = await supabase.from('chunk_phases').upsert(rows, { onConflict: 'id' })

  if (error) fail(`Failed to reorder phases for chunk "${chunkProjectId}"`, error)
}

/**
 * Copies a template's steps into a chunk as new phases, at the template's
 * default percentages and durations, all starting at slot 0 -- the user
 * places them on the timeline afterwards. `template_step_id` is kept as
 * provenance; editing the resulting phase does not reach back into the
 * template, and editing the template later does not reach into phases
 * already copied from it (see the header of 0007 on why).
 */
export async function applyPhaseTemplateToChunk(
  chunkProjectId: string,
  templateId: string
): Promise<ChunkPhase[]> {
  const supabase = getSupabaseBrowserClient()

  const { data: stepRows, error: stepError } = await supabase
    .from('phase_template_steps')
    .select('*')
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true })

  if (stepError) fail(`Failed to load phase template "${templateId}"`, stepError)

  const steps = (stepRows ?? []) as unknown as PhaseTemplateStepRow[]
  if (steps.length === 0) return []

  const inserts = steps.map((step) => ({
    chunk_project_id: chunkProjectId,
    template_step_id: step.id,
    name: step.name,
    kind: step.kind,
    sort_order: step.sort_order,
    pct_of_tpc: step.default_pct_of_tpc,
    start_slot: 0,
    duration_slots: step.default_duration_slots,
    duration_locked: false,
  }))

  const { data, error } = await supabase.from('chunk_phases').insert(inserts).select('*')

  if (error) fail(`Failed to apply phase template "${templateId}" to chunk "${chunkProjectId}"`, error)

  return ((data ?? []) as unknown as ChunkPhaseRow[])
    .slice()
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
    .map(rowToChunkPhase)
}

/* ------------------------------------------------------ phase dependencies -- */

export async function getPhaseDependenciesForProject(
  projectId: string
): Promise<PhaseDependency[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('phase_dependencies')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (error) fail(`Failed to load phase dependencies for "${projectId}"`, error)

  return ((data ?? []) as unknown as PhaseDependencyRow[]).map(rowToPhaseDependency)
}

export async function createPhaseDependency(input: {
  predecessorPhaseId: string
  successorPhaseId: string
  depType?: DependencyType
  lagSlots?: number
}): Promise<PhaseDependency> {
  const supabase = getSupabaseBrowserClient()

  // `project_id` is never sent: ship.sync_phase_dependency_project(), a
  // BEFORE trigger, derives it from the predecessor phase and refuses a
  // link whose two endpoints live in different projects. Sending our own
  // value here would only ever be overwritten or (if it disagreed with what
  // the trigger computes) misleading about which project this row actually
  // belongs to.
  const { data, error } = await supabase
    .from('phase_dependencies')
    .insert(phaseDependencyToRow(input))
    .select('*')
    .single()

  if (error) fail('Failed to create phase dependency', error)

  return rowToPhaseDependency(data as unknown as PhaseDependencyRow)
}

export async function deletePhaseDependency(id: string): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.from('phase_dependencies').delete().eq('id', id)

  if (error) fail(`Failed to delete phase dependency "${id}"`, error)
}

/* ---------------------------------------------------------- phase templates -- */

export async function getPhaseTemplates(projectId: string): Promise<PhaseTemplate[]> {
  const supabase = getSupabaseBrowserClient()

  // Built-ins (`project_id is null`) plus this project's own. Matches the
  // read policy in 0007 exactly: `(project_id is null) or can_read_project`.
  const { data, error } = await supabase
    .from('phase_templates')
    .select('*, phase_template_steps(*)')
    .or(`project_id.is.null,project_id.eq.${projectId}`)
    .order('is_builtin', { ascending: false })
    .order('name', { ascending: true })

  if (error) fail(`Failed to load phase templates for "${projectId}"`, error)

  return ((data ?? []) as unknown as PhaseTemplateRow[]).map(rowToPhaseTemplate)
}

/* ------------------------------------------------------------ cost settings -- */

export async function getCostSettingsForProject(projectId: string): Promise<ProjectCostSettings> {
  const supabase = getSupabaseBrowserClient()

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

/**
 * Cost settings are admin-write-only under current RLS (0006; widened when
 * per-project roles land in 0009). A non-admin caller's write does not
 * necessarily surface as a thrown error -- depending on whether the row
 * already exists, Postgres either updates 0 rows (USING clause excludes it,
 * no error) or raises 42501 (WITH CHECK fails on the insert branch). Both
 * mean the same thing from here, "you don't have permission", and neither
 * should crash a consultant's read-mostly session. Re-reading afterwards
 * rather than trusting the upsert's own response is what collapses both
 * cases to one: the caller always gets back what is actually on record.
 */
export async function updateCostSettingsForProject(
  projectId: string,
  updates: Partial<ProjectCostSettings>
): Promise<ProjectCostSettings> {
  const supabase = getSupabaseBrowserClient()

  const existing = await getCostSettingsForProject(projectId)
  const row = costSettingsToRow({ ...existing, ...updates, projectId })

  const { error } = await supabase
    .from('project_cost_settings')
    .upsert(row, { onConflict: 'project_id' })

  if (error && error.code !== '42501') {
    fail(`Failed to save cost settings for "${projectId}"`, error)
  }

  return getCostSettingsForProject(projectId)
}

export async function setEscalationRateOverride(
  projectId: string,
  yearOffset: number,
  ratePercent: number
): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.from('escalation_rate_overrides').upsert(
    { project_id: projectId, year_offset: yearOffset, rate_percent: ratePercent },
    { onConflict: 'project_id,year_offset' }
  )

  // Same admin-only write / silently-filtered-or-42501 story as
  // updateCostSettingsForProject above.
  if (error && error.code !== '42501') {
    fail(`Failed to set escalation override for "${projectId}" year ${yearOffset}`, error)
  }
}

export async function clearEscalationRateOverride(
  projectId: string,
  yearOffset: number
): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase
    .from('escalation_rate_overrides')
    .delete()
    .eq('project_id', projectId)
    .eq('year_offset', yearOffset)

  if (error && error.code !== '42501') {
    fail(`Failed to clear escalation override for "${projectId}" year ${yearOffset}`, error)
  }
}

/* ---------------------------------------------------------- energy settings -- */

export async function getEnergySettingsForProject(
  projectId: string
): Promise<ProjectEnergySettings> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('project_energy_settings')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) fail(`Failed to load energy settings for "${projectId}"`, error)

  return rowToEnergySettings(data as unknown as ProjectEnergySettingsRow | null, projectId)
}

/** Same admin-only write / RLS-graceful-degradation story as
 *  updateCostSettingsForProject above. */
export async function updateEnergySettingsForProject(
  projectId: string,
  updates: Partial<ProjectEnergySettings>
): Promise<ProjectEnergySettings> {
  const supabase = getSupabaseBrowserClient()

  const existing = await getEnergySettingsForProject(projectId)
  const row = energySettingsToRow({ ...existing, ...updates, projectId })

  const { error } = await supabase
    .from('project_energy_settings')
    .upsert(row, { onConflict: 'project_id' })

  if (error && error.code !== '42501') {
    fail(`Failed to save energy settings for "${projectId}"`, error)
  }

  return getEnergySettingsForProject(projectId)
}

/* --------------------------------------------------------------- scenarios -- */

/**
 * Scenarios are created, published and rebased exclusively through RPCs.
 *
 * There is no `createScenario` that INSERTs: the table grants no INSERT to
 * `authenticated` at all. The payload names real row ids that
 * `publish_scenario()` later writes back, so a client able to author one would
 * hold an arbitrary-write primitive into the baseline. Building it server-side
 * means a payload can only ever describe rows that already exist in a project
 * the caller belongs to. See supabase/migrations/0010_ship_scenarios.sql.
 */

export async function getScenariosForProject(projectId: string): Promise<Scenario[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('scenarios')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) fail(`Failed to load scenarios for "${projectId}"`, error)

  return ((data ?? []) as unknown as ScenarioRow[]).map(rowToScenario)
}

export async function createScenario(
  projectId: string,
  name: string,
  description = ''
): Promise<Scenario> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase.rpc('create_scenario', {
    p_project_id: projectId,
    p_name: name.trim(),
    p_description: description,
  })

  if (error) fail('Failed to create the scenario', error)

  return rowToScenario(data as unknown as ScenarioRow)
}

/** Persists the in-memory overlay back onto the scenario row — NOT onto the
 *  baseline. This is the "save my sandbox" write; `publishScenario` is the
 *  separate, deliberate act of pushing it to the shared plan. */
export async function saveScenarioPayload(
  scenarioId: string,
  payload: ScenarioPayload
): Promise<Scenario | null> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('scenarios')
    .update({ payload: scenarioPayloadToRow(payload), updated_at: new Date().toISOString() })
    .eq('id', scenarioId)
    .select('*')
    .maybeSingle()

  if (error) fail('Failed to save the scenario', error)
  if (!data) return null

  return rowToScenario(data as unknown as ScenarioRow)
}

export type PublishScenarioResult =
  | { ok: true; phasesUpdated: number; dependenciesUpdated: number }
  /** The baseline moved under the scenario. This is the Revit
   *  sync-with-central conflict, and it is surfaced rather than resolved: the
   *  alternative is one user silently reverting another's work. */
  | { ok: false; reason: 'conflict' | 'already-published' | 'denied'; message: string }

export async function publishScenario(scenarioId: string): Promise<PublishScenarioResult> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase.rpc('publish_scenario', {
    p_scenario_id: scenarioId,
  })

  if (error) {
    // The RPC raises with meaningful SQLSTATEs so the UI can offer the right
    // next action — rebase on a conflict, nothing on an already-published
    // scenario — rather than showing one generic failure for all three.
    const reason =
      error.code === '40001'
        ? 'conflict'
        : error.code === '22023'
          ? 'already-published'
          : 'denied'
    return { ok: false, reason, message: error.message }
  }

  const payload = (data ?? {}) as Record<string, unknown>
  return {
    ok: true,
    phasesUpdated: Number(payload.phases_updated ?? 0),
    dependenciesUpdated: Number(payload.dependencies_updated ?? 0),
  }
}

/** Re-reads the current baseline into the scenario, keeping its own placements
 *  where the underlying row still exists. The way out of a publish conflict
 *  that is not "lose your work". */
export async function rebaseScenario(scenarioId: string): Promise<Scenario> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase.rpc('rebase_scenario', {
    p_scenario_id: scenarioId,
  })

  if (error) fail('Failed to rebase the scenario', error)

  return rowToScenario(data as unknown as ScenarioRow)
}

export async function deleteScenario(scenarioId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.from('scenarios').delete().eq('id', scenarioId)

  if (error) fail('Failed to discard the scenario', error)
}
