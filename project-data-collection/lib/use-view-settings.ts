'use client'

import { useCallback, useSyncExternalStore } from 'react'

import { getProjectViewSettings, saveProjectViewSettings } from '@/lib/store'
import { DEFAULT_VIEW_SETTINGS, ProjectViewSettings, normalizeViewSettings } from '@/lib/view-settings'

/**
 * The project's shared display settings (see lib/view-settings.ts), stored in
 * `ship.projects.view_settings` (migration 0021).
 *
 * `save` is project-admin only (the database refuses anyone else and `save`
 * rejects with that error); every other member just reads. It takes only the
 * view(s) being changed -- the database merges them into the stored object
 * (0021), so saving Master View can never overwrite Phasing or Timeline, even
 * if this client's copy is stale or still loading. After a successful
 * save, every mounted consumer of this hook for the same project sees the new
 * value: the settings live in a small module-level cache keyed by project id,
 * and each consumer subscribes to its project's entry.
 *
 * While the first load is in flight `settings` is DEFAULT_VIEW_SETTINGS and
 * `loading` is true. When a project is mounted again after every consumer
 * unmounted, the cached value shows immediately and is refreshed in the
 * background (another admin may have changed it meanwhile).
 */
export function useProjectViewSettings(projectId: string): {
  settings: ProjectViewSettings
  loading: boolean
  error: string | null
  save: (next: Partial<ProjectViewSettings>) => Promise<void>
  /** True once the stored value has loaded (not loading, not failed). */
  ready: boolean
  /** Re-fetch, e.g. a Retry after a failed load. */
  reload: () => void
} {
  const subscribe = useCallback((onChange: () => void) => subscribeTo(projectId, onChange), [projectId])
  const getSnapshot = useCallback(() => snapshotFor(projectId), [projectId])
  const entry = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const save = useCallback((next: Partial<ProjectViewSettings>) => saveFor(projectId, next), [projectId])
  const reload = useCallback(() => {
    if (projectId) load(projectId)
  }, [projectId])

  return {
    settings: entry.settings,
    loading: entry.status === 'loading',
    error: entry.error,
    save,
    ready: entry.status === 'ready',
    reload,
  }
}

/* ------------------------------------------------------------ the cache -- */

type Entry = {
  status: 'loading' | 'ready' | 'error'
  settings: ProjectViewSettings
  error: string | null
}

// Shared, frozen snapshots: useSyncExternalStore needs a stable reference
// for "nothing changed".
const LOADING: Entry = Object.freeze({ status: 'loading', settings: DEFAULT_VIEW_SETTINGS, error: null })
const IDLE: Entry = Object.freeze({ status: 'ready', settings: DEFAULT_VIEW_SETTINGS, error: null })

const cache = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
const inflight = new Set<string>()
/** Bumped by every successful save, so a load that started before the save
 *  cannot land after it and put the old value back. */
const generation = new Map<string, number>()

function getServerSnapshot(): Entry {
  return LOADING
}

function snapshotFor(projectId: string): Entry {
  if (!projectId) return IDLE
  return cache.get(projectId) ?? LOADING
}

function emit(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener()
}

function subscribeTo(projectId: string, onChange: () => void): () => void {
  if (!projectId) return () => {}

  let set = listeners.get(projectId)
  if (!set) {
    set = new Set()
    listeners.set(projectId, set)
  }
  const firstSubscriber = set.size === 0
  set.add(onChange)

  // First consumer for this project (or the previous load failed): fetch.
  // Later consumers share the cached entry / the in-flight request.
  if (firstSubscriber || cache.get(projectId)?.status === 'error') load(projectId)

  return () => {
    const current = listeners.get(projectId)
    if (!current) return
    current.delete(onChange)
    if (current.size === 0) listeners.delete(projectId)
  }
}

function load(projectId: string): void {
  if (inflight.has(projectId)) return
  inflight.add(projectId)
  const startedAt = generation.get(projectId) ?? 0

  getProjectViewSettings(projectId)
    .then((raw) => {
      if ((generation.get(projectId) ?? 0) !== startedAt) return
      cache.set(projectId, { status: 'ready', settings: normalizeViewSettings(raw), error: null })
    })
    .catch((cause: unknown) => {
      if ((generation.get(projectId) ?? 0) !== startedAt) return
      // Keep showing a previously loaded value if there is one; otherwise
      // render the defaults alongside the error.
      const previous = cache.get(projectId)
      cache.set(projectId, {
        status: 'error',
        settings: previous?.settings ?? DEFAULT_VIEW_SETTINGS,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    })
    .finally(() => {
      inflight.delete(projectId)
      emit(projectId)
    })
}

async function saveFor(projectId: string, next: Partial<ProjectViewSettings>): Promise<void> {
  if (!projectId) throw new Error('Cannot save display settings: no project selected')

  // Only the views being saved, each normalized; the server merges them.
  const normalized = normalizeViewSettings(next)
  const partial: Partial<ProjectViewSettings> = {}
  for (const key of Object.keys(next) as (keyof ProjectViewSettings)[]) {
    if (key in normalized) Object.assign(partial, { [key]: normalized[key] })
  }

  // Throws (with the database's message) for anyone who is not a project admin.
  // The returned value is the whole merged object, so the cache stays exact.
  const stored = await saveProjectViewSettings(projectId, partial)

  generation.set(projectId, (generation.get(projectId) ?? 0) + 1)
  cache.set(projectId, { status: 'ready', settings: normalizeViewSettings(stored), error: null })
  emit(projectId)
}
