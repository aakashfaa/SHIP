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
  AccessNoticeRow,
  ChunkPhaseRow,
  ChunkProjectRow,
  EscalationRateOverrideRow,
  FormFieldOptionRow,
  FormFieldRow,
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
  formFieldToRow,
  lineItemToInsertRow,
  lineItemToUpdateRow,
  normalizeTimelineSegments,
  phaseDependencyToRow,
  rowToAccessNotice,
  rowToChunkPhase,
  rowToChunkProject,
  rowToCostSettings,
  rowToEnergySettings,
  rowToFormField,
  rowToFormFieldOption,
  rowToLineItem,
  rowToPhaseDependency,
  rowToPhaseTemplate,
  rowToProject,
  rowToScenario,
  rowToTimelineSettings,
  scenarioDependenciesToRows,
  scenarioPhasesToRows,
  timelineSettingsToRow,
} from './mappers'
import {
  AccessNotice,
  ChunkPhase,
  ChunkProject,
  ConsultantType,
  DependencyType,
  FormField,
  FormFieldInputType,
  FormFieldOption,
  LineItem,
  PhaseDependency,
  PhaseTemplate,
  Project,
  ProjectConsultant,
  ProjectCostSettings,
  ProjectEnergySettings,
  ProjectTaxonomyValue,
  ProjectTimelineSettings,
  Scenario,
  ScenarioDependency,
  ScenarioPayload,
  ScenarioPhase,
  TaxonomyKind,
} from './types'

const PROJECT_SELECT = '*, project_consultants(*), project_members(*)'
const CHUNK_SELECT = '*, chunk_project_items(*)'
const FORM_FIELD_SELECT = '*, form_field_options(*)'

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

  // Seed the building-agnostic taxonomy defaults (building_area, building_level,
  // category, timeline_priority) -- see migration 0008. This is deliberately
  // NOT allowed to fail project creation: the project row already exists by
  // this point, so throwing here would hand the user an error screen for a
  // project that in fact was created. Per 0008's `taxonomy_value_allowed`,
  // validation fails OPEN when a project has zero rows for a kind, so a
  // project that never gets seeded still works end to end -- its dropdowns are
  // just empty until an admin adds values in Settings. That degraded-but-not-
  // broken outcome is exactly why this is worth swallowing rather than
  // surfacing as a fatal error, while still logging it so a real, persistent
  // failure (as opposed to one flaky RPC call) doesn't go unnoticed.
  const { error: taxonomyError } = await supabase.rpc('seed_default_taxonomy', {
    p_project_id: projectId,
  })
  if (taxonomyError) {
    console.error(`Failed to seed default taxonomy for "${projectId}":`, taxonomyError)
  }

  // Seed the project's line-item form (migration 0012) the same way, and for
  // the same reason: without this, a brand new project has zero form_fields
  // rows, so the Add Data wizard would render no questions at all until an
  // admin visits the form builder. `seedDefaultForm` is additive-only (ON
  // CONFLICT DO NOTHING keyed on (project_id, key)), so this can never
  // overwrite anything even if called again later. Non-fatal for the same
  // reason as the taxonomy seed above: the project row already exists, so
  // throwing here would show an error for a project that was in fact created.
  try {
    await seedDefaultForm(projectId)
  } catch (formError) {
    console.error(`Failed to seed default form for "${projectId}":`, formError)
  }

  const project = await getProjectById(projectId)
  if (!project) fail('Failed to create project', { message: `project "${projectId}" not readable after creation` })

  return { project, invitedEmails: result.invited_emails ?? [] }
}

/**
 * Thrown by `updateProject` when `expectedUpdatedAt` no longer matches the
 * stored `projects.updated_at` -- someone else saved the project since the
 * caller loaded it (DATA-19). Callers should reload and let the user redo
 * their edit rather than retrying blind, which would silently replace the
 * other person's roster change.
 */
export class ProjectChangedError extends Error {
  constructor(projectId: string, detail?: string) {
    super(
      `Project "${projectId}" was changed by someone else since you opened it. ` +
        'Reload to see the latest version, then make your change again.' +
        (detail ? ` (${detail})` : '')
    )
    this.name = 'ProjectChangedError'
  }
}

/**
 * Two call shapes, same RPC:
 *
 *   updateProject(id, { name?, consultants? }, expectedUpdatedAt?)
 *   updateProject(id, name, consultants, expectedUpdatedAt?)
 *
 * The first is the original signature (fills whatever `updates` leaves out
 * from a fresh read); the second is the Phase 2 contract shape. Either way,
 * `expectedUpdatedAt` -- pass `project.updatedAt` from the copy the user was
 * editing -- makes `ship.update_project` (migration 0013) refuse the write
 * if the project changed in the meantime, surfaced as `ProjectChangedError`.
 * Omit it and the save is last-write-wins, as before.
 */
export async function updateProject(
  projectId: string,
  updates: Partial<Project>,
  expectedUpdatedAt?: string | null
): Promise<{ project: Project; invitedEmails: string[] } | null>
export async function updateProject(
  projectId: string,
  name: string,
  consultants: ProjectConsultant[],
  expectedUpdatedAt?: string | null
): Promise<{ project: Project; invitedEmails: string[] } | null>
export async function updateProject(
  projectId: string,
  updatesOrName: Partial<Project> | string,
  consultantsOrExpected?: ProjectConsultant[] | string | null,
  maybeExpected?: string | null
): Promise<{ project: Project; invitedEmails: string[] } | null> {
  const supabase = getSupabaseBrowserClient()

  let name: string
  let consultants: ProjectConsultant[]
  let expectedUpdatedAt: string | null | undefined

  if (typeof updatesOrName === 'string') {
    name = updatesOrName
    consultants = Array.isArray(consultantsOrExpected) ? consultantsOrExpected : []
    expectedUpdatedAt = maybeExpected
  } else {
    expectedUpdatedAt = typeof consultantsOrExpected === 'string' ? consultantsOrExpected : null
    let existing: Project | null = null
    if (updatesOrName.name === undefined || updatesOrName.consultants === undefined) {
      existing = await getProjectById(projectId)
      if (!existing) return null
    }
    name = updatesOrName.name ?? existing?.name ?? ''
    consultants = updatesOrName.consultants ?? existing?.consultants ?? []
  }

  const args: Record<string, unknown> = {
    p_project_id: projectId,
    p_name: name.trim(),
    p_consultants: consultants,
  }
  // Only sent when the caller has one: `p_expected_updated_at` defaults to
  // null in SQL (= no check), and leaving it out keeps this call valid
  // against a database that predates migration 0013.
  if (expectedUpdatedAt) args.p_expected_updated_at = expectedUpdatedAt

  const { data, error } = await supabase.rpc('update_project', args)

  if (error) {
    // 0013 raises serialization_failure (40001) for a stale
    // p_expected_updated_at -- the same SQLSTATE publish_scenario uses for
    // "the baseline moved under you".
    if (error.code === '40001') throw new ProjectChangedError(projectId, error.message)
    fail(`Failed to update project "${projectId}"`, error)
  }

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

/* -------------------------------------------------------- access notices -- */
// supabase/migrations/0013_access_hardening.sql, product decision D-7: when
// an invite names someone who already has an account, the invite route
// (service role) records a notice instead of handing anyone a login link,
// and the invitee sees "You've been added to <project>" on next sign-in.

/**
 * The signed-in user's UNSEEN notices, oldest first. No email filter here on
 * purpose: RLS on `project_access_notices` already restricts every read to
 * rows addressed to the caller's own email.
 */
export async function fetchAccessNotices(): Promise<AccessNotice[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('project_access_notices')
    .select('*')
    .is('seen_at', null)
    .order('created_at', { ascending: true })

  if (error) fail('Failed to load access notices', error)

  const rows = (data ?? []) as unknown as AccessNoticeRow[]
  if (rows.length === 0) return []

  // Project names are a best-effort lookup, not an embed: a project the user
  // can no longer read (access revoked again since) should still produce a
  // notice rather than an error -- it just falls back to the project id.
  const projectIds = [...new Set(rows.map((row) => row.project_id))]
  const names = new Map<string, string>()
  const { data: projectRows, error: projectError } = await supabase
    .from('projects')
    .select('id, name')
    .in('id', projectIds)

  if (projectError) {
    console.error('Failed to resolve project names for access notices:', projectError)
  } else {
    for (const project of (projectRows ?? []) as Array<{ id: string; name: string }>) {
      names.set(project.id, project.name)
    }
  }

  return rows.map((row) => rowToAccessNotice(row, names.get(row.project_id)))
}

/** Stamps `seen_at` so each toast shows once. RLS limits the update to the
 *  caller's own notices; `seen_at is null` keeps the first-seen time. */
export async function markAccessNoticesSeen(ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return

  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase
    .from('project_access_notices')
    .update({ seen_at: new Date().toISOString() })
    .in('id', unique)
    .is('seen_at', null)

  if (error) fail('Failed to mark access notices as seen', error)
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
  // lineItemToInsertRow enforces that (M-11): it has no mapping for them.
  const { data, error } = await supabase
    .from('line_items')
    .insert(lineItemToInsertRow(input))
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

  // Only user-editable columns (M-11). The filing/system columns -- project,
  // submitter, consultant type, number, company, discipline, created_at,
  // ecc_amount -- are dropped by the mapper even when `updates` is a whole
  // LineItem, because migration 0014's trigger refuses a change to any of
  // them from a non-platform-admin.
  const row = lineItemToUpdateRow(updates)

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

/**
 * Persists the in-memory overlay back onto the scenario row — NOT onto the
 * baseline. This is the "save my sandbox" write; `publishScenario` is the
 * separate, deliberate act of pushing it to the shared plan.
 *
 * Goes through `ship.save_scenario_payload` (migration 0015, M-13) rather
 * than a table UPDATE: the owner can no longer write `payload` directly. The
 * RPC is owner-only, merges the phases/dependencies into the stored payload
 * (so keys this client never sees -- `cost_settings` -- survive the save),
 * and rejects ids from another project and out-of-range slots.
 *
 * Accepts either `(id, payload)` -- the original signature -- or
 * `(id, phases, dependencies)`, the Phase 2 contract shape.
 */
export async function saveScenarioPayload(
  scenarioId: string,
  payload: ScenarioPayload
): Promise<Scenario | null>
export async function saveScenarioPayload(
  scenarioId: string,
  phases: readonly ScenarioPhase[],
  dependencies: readonly ScenarioDependency[]
): Promise<Scenario | null>
export async function saveScenarioPayload(
  scenarioId: string,
  payloadOrPhases: ScenarioPayload | readonly ScenarioPhase[],
  maybeDependencies?: readonly ScenarioDependency[]
): Promise<Scenario | null> {
  const supabase = getSupabaseBrowserClient()

  let phases: readonly ScenarioPhase[]
  let dependencies: readonly ScenarioDependency[]
  if (isScenarioPhaseList(payloadOrPhases)) {
    phases = payloadOrPhases
    dependencies = maybeDependencies ?? []
  } else {
    phases = payloadOrPhases.phases
    dependencies = payloadOrPhases.dependencies
  }

  const { data, error } = await supabase.rpc('save_scenario_payload', {
    p_scenario_id: scenarioId,
    p_phases: scenarioPhasesToRows(phases),
    p_dependencies: scenarioDependenciesToRows(dependencies),
  })

  if (error) fail('Failed to save the scenario', error)

  // `returns ship.scenarios` comes back as one object; tolerate a one-row
  // array as well rather than depend on PostgREST's composite-return shape.
  const row = (Array.isArray(data) ? data[0] : data) as ScenarioRow | null | undefined
  if (!row || typeof row !== 'object' || !row.id) return null

  return rowToScenario(row)
}

function isScenarioPhaseList(
  value: ScenarioPayload | readonly ScenarioPhase[]
): value is readonly ScenarioPhase[] {
  return Array.isArray(value)
}

/**
 * Renames / re-describes / shares a scenario. Since migration 0015 these
 * three columns are ALL an owner may UPDATE directly (the payload goes
 * through `saveScenarioPayload`), so this sends nothing else -- not even
 * `updated_at`, which the column grant would refuse. Returns null when the
 * update matched no row (not the owner, or the scenario is gone).
 */
export async function updateScenarioMeta(
  scenarioId: string,
  updates: { name?: string; description?: string; visibility?: Scenario['visibility'] }
): Promise<Scenario | null> {
  const supabase = getSupabaseBrowserClient()

  const row: Record<string, unknown> = {}
  if (updates.name !== undefined) {
    const name = updates.name.trim()
    if (name === '') throw new Error('A what-if needs a name.')
    row.name = name
  }
  if (updates.description !== undefined) row.description = updates.description
  if (updates.visibility !== undefined) row.visibility = updates.visibility

  if (Object.keys(row).length === 0) {
    const { data, error } = await supabase
      .from('scenarios')
      .select('*')
      .eq('id', scenarioId)
      .maybeSingle()
    if (error) fail('Failed to load the scenario', error)
    return data ? rowToScenario(data as unknown as ScenarioRow) : null
  }

  const { data, error } = await supabase
    .from('scenarios')
    .update(row)
    .eq('id', scenarioId)
    .select('*')
    .maybeSingle()

  if (error) fail('Failed to update the scenario', error)
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

/* ------------------------------------------------------------ taxonomies -- */

type TaxonomyRow = {
  project_id: string
  kind: string
  value: string
  sort_order: number | string | null
  is_archived: boolean | null
}

function rowToTaxonomyValue(row: TaxonomyRow): ProjectTaxonomyValue {
  return {
    projectId: row.project_id,
    kind: row.kind as TaxonomyKind,
    value: row.value,
    sortOrder: Number(row.sort_order ?? 0),
    isArchived: row.is_archived === true,
  }
}

/**
 * Every taxonomy value for a project, archived ones included.
 *
 * Archived rows come back deliberately. The Settings editor has to show them
 * (you cannot un-archive what you cannot see), and a line item written before
 * a value was archived still displays it. Callers building a *new* dropdown
 * filter them out -- see `taxonomyOptions`.
 */
export async function getTaxonomyForProject(
  projectId: string
): Promise<ProjectTaxonomyValue[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('project_taxonomy_values')
    .select('*')
    .eq('project_id', projectId)
    .order('kind', { ascending: true })
    .order('sort_order', { ascending: true })

  if (error) fail(`Failed to load taxonomies for "${projectId}"`, error)

  return ((data ?? []) as unknown as TaxonomyRow[]).map(rowToTaxonomyValue)
}

/**
 * The live options for one dropdown, in order.
 *
 * `current` is the value the record being edited already holds. If that value
 * has since been archived it is still included, because dropping it would
 * silently rewrite the record to something else the moment someone opened the
 * form -- a data change nobody asked for, caused by rendering.
 */
export function taxonomyOptions(
  values: readonly ProjectTaxonomyValue[],
  kind: TaxonomyKind,
  current?: string
): string[] {
  const options = values
    .filter((v) => v.kind === kind && !v.isArchived)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((v) => v.value)

  if (current && !options.includes(current)) return [current, ...options]
  return options
}

export async function addTaxonomyValue(
  projectId: string,
  kind: TaxonomyKind,
  value: string
): Promise<ProjectTaxonomyValue> {
  const supabase = getSupabaseBrowserClient()
  const trimmed = value.trim()

  if (trimmed === '') throw new Error('A taxonomy value cannot be blank.')

  // Append. Working out the next sort order client-side races another editor,
  // but the consequence is two values sharing a position and sorting by
  // whatever Postgres returns -- cosmetic, and cheaper than a round trip or a
  // sequence per (project, kind).
  const existing = await getTaxonomyForProject(projectId)
  const nextOrder =
    existing.filter((v) => v.kind === kind).reduce((max, v) => Math.max(max, v.sortOrder), -1) + 1

  const { data, error } = await supabase
    .from('project_taxonomy_values')
    .upsert(
      {
        project_id: projectId,
        kind,
        value: trimmed,
        sort_order: nextOrder,
        is_archived: false,
      },
      { onConflict: 'project_id,kind,value' }
    )
    .select('*')
    .single()

  if (error) fail(`Failed to add "${trimmed}"`, error)

  return rowToTaxonomyValue(data as unknown as TaxonomyRow)
}

/**
 * Archive or restore a value.
 *
 * There is deliberately no delete. A value already written onto line items
 * cannot be removed from the vocabulary without those rows failing validation
 * on their next edit -- see the column comment in migration 0008.
 */
export async function setTaxonomyValueArchived(
  projectId: string,
  kind: TaxonomyKind,
  value: string,
  isArchived: boolean
): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase
    .from('project_taxonomy_values')
    .update({ is_archived: isArchived })
    .eq('project_id', projectId)
    .eq('kind', kind)
    .eq('value', value)

  if (error) fail(`Failed to update "${value}"`, error)
}

/** Persist a reordering. One upsert per row; the lists are a dozen entries
 *  long, so a bulk RPC would be machinery for no gain. */
export async function reorderTaxonomyValues(
  projectId: string,
  kind: TaxonomyKind,
  orderedValues: readonly string[]
): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const rows = orderedValues.map((value, index) => ({
    project_id: projectId,
    kind,
    value,
    sort_order: index,
  }))

  const { error } = await supabase
    .from('project_taxonomy_values')
    .upsert(rows, { onConflict: 'project_id,kind,value' })

  if (error) fail('Failed to reorder values', error)
}

/* ------------------------------------------------------------ form fields -- */
// supabase/migrations/0012_ship_form_builder.sql. Supersedes the taxonomy
// functions above -- a "field" now carries its own label/type/order rather
// than being one of four hardcoded dropdowns -- but they are left in place
// (see the file header) because another component still imports them.

/**
 * A project's whole form definition, fields and options together, in
 * display order. Hidden fields and archived options are INCLUDED: the form
 * builder has to show a hidden field to offer "unhide" and an archived
 * option to offer "restore". Consumers building the actual Add Data form
 * want `visibleFormFields` / `fieldOptions` below instead.
 */
export async function getFormFieldsForProject(projectId: string): Promise<FormField[]> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('form_fields')
    .select(FORM_FIELD_SELECT)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })

  if (error) fail(`Failed to load form fields for "${projectId}"`, error)

  return ((data ?? []) as unknown as FormFieldRow[]).map(rowToFormField)
}

/**
 * Pure helper for the Add Data form: not hidden, in order. Takes the array
 * `getFormFieldsForProject` already returned rather than querying again, so
 * a component can call it on every render (e.g. while the user toggles a
 * step) without hitting Supabase.
 */
export function visibleFormFields(fields: readonly FormField[]): FormField[] {
  return fields
    .filter((field) => !field.isHidden)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * The live choices for one select/multiselect field, in order.
 *
 * Same rationale as `taxonomyOptions` above, which this supersedes: `current`
 * is the value (or, for multiselect, one value) the record being edited
 * already holds. If that value has since been archived it is still included
 * here, because dropping it would silently rewrite the record to something
 * else the moment someone opened the form -- a data change nobody asked for,
 * caused by rendering. Pure, like `visibleFormFields`: no Supabase call.
 */
export function fieldOptions(field: FormField, current?: string): string[] {
  const options = field.options
    .filter((option) => !option.isArchived)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((option) => option.value)

  if (current && !options.includes(current)) return [current, ...options]
  return options
}

/**
 * Turns a label into a `key` that satisfies the DB's `^[a-z][a-z0-9_]*$`
 * check and is unique within the project: lowercase, every run of
 * non-alphanumerics becomes one underscore, and a slug that would start with
 * a digit (or be empty) gets a `field_` prefix instead of being rejected on
 * save. Collisions get a numeric suffix.
 */
function deriveFieldKey(label: string, existingKeys: readonly string[]): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  const base = slug === '' ? 'field' : /^[a-z]/.test(slug) ? slug : `field_${slug}`

  if (!existingKeys.includes(base)) return base

  let suffix = 2
  while (existingKeys.includes(`${base}_${suffix}`)) suffix++
  return `${base}_${suffix}`
}

/**
 * Creates a CUSTOM field. There is no way to create a built-in one from
 * here -- `storage: 'custom'` and `is_builtin: false` are hardcoded below,
 * and `ship.form_fields_builtin_storage_ck` would reject anything else
 * anyway. `key` is derived from the label rather than accepted as an input:
 * it only has to exist, be stable and be unique, none of which a form
 * builder's user needs to think about.
 */
export async function createFormField(
  projectId: string,
  input: {
    label: string
    helpText?: string
    inputType: FormFieldInputType
    groupLabel?: string
    isRequired?: boolean
  }
): Promise<FormField> {
  const supabase = getSupabaseBrowserClient()

  const existing = await getFormFieldsForProject(projectId)
  const key = deriveFieldKey(
    input.label,
    existing.map((field) => field.key)
  )
  // Append at the end. `+ 10` rather than `+ 1` matches the gaps the seeder
  // leaves between built-ins (10, 20, 30, ...), so a field added here can
  // later be dragged between two adjacent defaults without a renumbering
  // pass -- see reorderFormFields, which renumbers everything anyway, but
  // there is no reason to force that on the very next add.
  const nextSortOrder = existing.reduce((max, field) => Math.max(max, field.sortOrder), 0) + 10

  const { data, error } = await supabase
    .from('form_fields')
    .insert({
      project_id: projectId,
      key,
      label: input.label.trim(),
      help_text: input.helpText ?? '',
      input_type: input.inputType,
      storage: 'custom',
      group_label: input.groupLabel ?? '',
      sort_order: nextSortOrder,
      is_required: input.isRequired ?? false,
      is_builtin: false,
    })
    .select(FORM_FIELD_SELECT)
    .single()

  if (error) fail(`Failed to create form field "${input.label}"`, error)

  return rowToFormField(data as unknown as FormFieldRow)
}

/**
 * Label, help text, grouping, required/hidden and order are legal on any
 * field. `inputType` is legal too, but only actually takes for a custom
 * field -- `ship.guard_form_field` throws for a built-in, and that error is
 * left to propagate through `fail()` unchanged rather than being pre-empted
 * here, because its message ("cannot change the input type of built-in
 * field...") is the one the user should see.
 */
export async function updateFormField(
  fieldId: string,
  updates: Partial<
    Pick<
      FormField,
      'label' | 'helpText' | 'groupLabel' | 'isRequired' | 'isHidden' | 'sortOrder' | 'inputType'
    >
  >
): Promise<FormField | null> {
  const supabase = getSupabaseBrowserClient()

  const { data, error } = await supabase
    .from('form_fields')
    .update(formFieldToRow(updates))
    .eq('id', fieldId)
    .select(FORM_FIELD_SELECT)
    .maybeSingle()

  if (error) fail(`Failed to update form field "${fieldId}"`, error)
  if (!data) return null

  return rowToFormField(data as unknown as FormFieldRow)
}

/**
 * `ship.guard_form_field` (0012) refuses this outright for a built-in, with
 * a 42501 whose message names the field and says "Hide it instead." That
 * message is worth showing to the user verbatim, so it is not caught or
 * replaced here -- `fail()` folds it into the thrown Error unchanged, same
 * as every other write in this file.
 */
export async function deleteFormField(fieldId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.from('form_fields').delete().eq('id', fieldId)

  if (error) fail(`Failed to delete form field "${fieldId}"`, error)
}

/** Persist a project-wide field order (index = new sort_order). */
export async function reorderFormFields(projectId: string, orderedFieldIds: string[]): Promise<void> {
  if (orderedFieldIds.length === 0) return

  const supabase = getSupabaseBrowserClient()

  // M-18: via `ship.reorder_form_fields` (migration 0017) -- one
  // UPDATE ... FROM unnest(ids) WITH ORDINALITY scoped to the project, so a
  // foreign id simply matches nothing. The upsert this replaces never
  // worked: PostgREST compiles it to INSERT ... ON CONFLICT, and Postgres
  // checks NOT NULL on the proposed insert tuple (no key/label/input_type)
  // before looking at the conflict, so every reorder failed with 23502.
  // SECURITY INVOKER, so form_fields RLS still decides who may reorder.
  const { error } = await supabase.rpc('reorder_form_fields', {
    p_project_id: projectId,
    p_ids: orderedFieldIds,
  })

  if (error) fail(`Failed to reorder form fields for "${projectId}"`, error)
}

/**
 * Append one option. Uses `upsert` on `(field_id, value)` the same way
 * `addTaxonomyValue` does, so re-adding an archived value restores it rather
 * than colliding with the unique constraint.
 */
export async function addFieldOption(fieldId: string, value: string): Promise<FormFieldOption> {
  const supabase = getSupabaseBrowserClient()
  const trimmed = value.trim()

  if (trimmed === '') throw new Error('An option value cannot be blank.')

  // Working out the next sort order client-side races another editor doing
  // the same thing, same tradeoff `addTaxonomyValue` accepts: the worst case
  // is two options sharing a position and sorting arbitrarily, which is
  // cosmetic and far cheaper than a round trip or a sequence per field.
  const { data: existingRows, error: existingError } = await supabase
    .from('form_field_options')
    .select('sort_order')
    .eq('field_id', fieldId)

  if (existingError) fail(`Failed to load options for field "${fieldId}"`, existingError)

  const nextSortOrder =
    ((existingRows ?? []) as Array<{ sort_order: number | string | null }>).reduce(
      (max, row) => Math.max(max, Number(row.sort_order ?? 0) || 0),
      -10
    ) + 10

  const { data, error } = await supabase
    .from('form_field_options')
    .upsert(
      {
        field_id: fieldId,
        value: trimmed,
        label: trimmed,
        sort_order: nextSortOrder,
        is_archived: false,
      },
      { onConflict: 'field_id,value' }
    )
    .select('*')
    .single()

  if (error) fail(`Failed to add option "${trimmed}"`, error)

  return rowToFormFieldOption(data as unknown as FormFieldOptionRow)
}

/**
 * Archive or restore an option. No delete, for the same reason
 * `setTaxonomyValueArchived` has none: a value already written onto a line
 * item cannot be removed from the vocabulary without that item failing
 * validation on its next edit.
 */
export async function setFieldOptionArchived(optionId: string, isArchived: boolean): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase
    .from('form_field_options')
    .update({ is_archived: isArchived })
    .eq('id', optionId)

  if (error) fail(`Failed to update option "${optionId}"`, error)
}

/** Persist a reordering, one RPC, matching `reorderFormFields` above. */
export async function reorderFieldOptions(
  fieldId: string,
  orderedOptionIds: string[]
): Promise<void> {
  if (orderedOptionIds.length === 0) return

  const supabase = getSupabaseBrowserClient()

  // Same reason and shape as reorderFormFields: the old upsert hit NOT NULL
  // on form_field_options.value. `ship.reorder_field_options`, migration 0017.
  const { error } = await supabase.rpc('reorder_field_options', {
    p_field_id: fieldId,
    p_ids: orderedOptionIds,
  })

  if (error) fail(`Failed to reorder options for field "${fieldId}"`, error)
}

/**
 * Calls `ship.seed_default_form()` -- the ADDITIVE operation described in
 * migration 0012's header. Adds every default field (and every default
 * option those fields don't already have) that this project is missing;
 * never updates or deletes anything a firm has customised. Safe to call
 * repeatedly, including from `createProject` above.
 */
export async function seedDefaultForm(projectId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient()

  const { error } = await supabase.rpc('seed_default_form', { p_project_id: projectId })

  if (error) fail(`Failed to seed default form for "${projectId}"`, error)
}
