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
  ChunkProjectRow,
  LineItemRow,
  ProjectRow,
  TimelineSettingsRow,
  lineItemToRow,
  normalizeTimelineSegments,
  rowToChunkProject,
  rowToLineItem,
  rowToProject,
  rowToTimelineSettings,
  timelineSettingsToRow,
} from './mappers'
import {
  ChunkProject,
  ConsultantType,
  LineItem,
  Project,
  ProjectConsultant,
  ProjectTimelineSettings,
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
  input: Omit<LineItem, 'id' | 'createdAt' | 'companyName' | 'discipline' | 'itemNumber'>
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
