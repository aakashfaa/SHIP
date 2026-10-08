'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { useProjectViewSettings } from '@/lib/use-view-settings'
import {
  applyColumnsLayer,
  applyTimelineLayer,
  columnsLayerFor,
  isEmptyLayer,
  parseColumnsLayer,
  parseTimelineLayer,
  timelineLayerFor,
} from '@/lib/view-filter-layers'
import type { ProjectViewSettings } from '@/lib/view-settings'

/**
 * What one view (Master View, Phasing, Timeline) actually shows for the
 * current person: the project default (`ship.projects.view_settings`, set by
 * a project admin for everyone -- see lib/use-view-settings.ts) with this
 * person's own filter layered on top.
 *
 * The personal layer is a delta, combined by lib/view-filter-layers.ts:
 * non-admins can only hide MORE than the default (an admin-hidden column or
 * chart stays hidden), admins can also show what the default hides and then
 * "Save as default for everyone". Because it is a delta, later admin changes
 * still reach everyone. Kept in this browser's localStorage under
 * `ship:view-filter:v2:<project>:<view>`; "Reset to project default" deletes
 * it.
 *
 * localStorage can be missing or throw (private windows, blocked storage);
 * every access is wrapped, and without it the filter lasts for the tab.
 */

export type ViewKey = keyof ProjectViewSettings

export type EffectiveViewSettings<K extends ViewKey> = {
  /** What the view renders. */
  effective: ProjectViewSettings[K]
  /** The project-wide default. */
  projectDefault: ProjectViewSettings[K]
  /** Whether this person may see past the default (project admin). */
  isAdmin: boolean
  /** True when this person's own filter changes what they see. */
  isPersonal: boolean
  /** Ask for this view to look like `next`; anything the person's role does
   *  not allow (showing what the admin hid) is dropped. Browser-local. */
  setPersonal: (next: ProjectViewSettings[K]) => void
  /** Drop the personal filter; follow the project default again. */
  resetToDefault: () => void
  /** Project admin AND the project default has loaded. Saving before that
   *  would publish a view built on the app defaults, not the real ones. */
  canSaveDefault: boolean
  /** Project admins only (the database refuses anyone else): make this
   *  view's current effective value the default for everyone, and drop the
   *  personal layer since it now matches. Sends only this view; the server
   *  merges it, so other views' defaults are untouched. */
  saveAsDefault: () => Promise<void>
  loading: boolean
  error: string | null
}

export function useEffectiveViewSettings<K extends ViewKey>(
  projectId: string,
  view: K,
  isAdmin: boolean
): EffectiveViewSettings<K> {
  const { settings, loading, error, save, ready } = useProjectViewSettings(projectId)
  const storageKey = `ship:view-filter:v2:${projectId}:${view}`

  const subscribe = useCallback((onChange: () => void) => subscribeTo(storageKey, onChange), [storageKey])
  const getSnapshot = useCallback(() => readRaw(storageKey), [storageKey])
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const projectDefault = settings[view]
  const effective = useMemo(() => {
    let parsed: unknown = null
    try {
      parsed = raw === null ? null : JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (view === 'timeline') {
      return applyTimelineLayer(
        projectDefault as ProjectViewSettings['timeline'],
        parseTimelineLayer(parsed),
        isAdmin
      ) as ProjectViewSettings[K]
    }
    return applyColumnsLayer(
      projectDefault as { hiddenColumns: string[] },
      parseColumnsLayer(parsed),
      isAdmin
    ) as ProjectViewSettings[K]
  }, [isAdmin, projectDefault, raw, view])

  const isPersonal = !sameSlice(effective, projectDefault)

  const setPersonal = useCallback(
    (next: ProjectViewSettings[K]) => {
      const layer =
        view === 'timeline'
          ? timelineLayerFor(
              projectDefault as ProjectViewSettings['timeline'],
              next as ProjectViewSettings['timeline'],
              isAdmin
            )
          : columnsLayerFor(projectDefault as { hiddenColumns: string[] }, next as { hiddenColumns: string[] }, isAdmin)
      writeRaw(storageKey, isEmptyLayer(layer) ? null : JSON.stringify(layer))
    },
    [isAdmin, projectDefault, storageKey, view]
  )
  const resetToDefault = useCallback(() => writeRaw(storageKey, null), [storageKey])

  const canSaveDefault = isAdmin && ready
  const saveAsDefault = useCallback(async () => {
    if (!canSaveDefault) throw new Error('Display settings have not loaded yet.')
    await save({ [view]: effective } as Partial<ProjectViewSettings>)
    writeRaw(storageKey, null)
  }, [canSaveDefault, effective, save, storageKey, view])

  return {
    effective,
    projectDefault,
    isAdmin,
    isPersonal,
    canSaveDefault,
    setPersonal,
    resetToDefault,
    saveAsDefault,
    loading,
    error,
  }
}

/** Order-insensitive for column lists. */
function sameSlice(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (Array.isArray(v)) return [...v].map(String).sort()
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
    }
    return v
  })
}

/* ------------------------------------------- localStorage, shared in-tab -- */

const listeners = new Map<string, Set<() => void>>()
/** Mirrors storage so a broken localStorage still works for this tab's life. */
const memory = new Map<string, string | null>()

function getServerSnapshot(): string | null {
  return null
}

function readRaw(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null
  let value: string | null = null
  try {
    value = window.localStorage.getItem(key)
  } catch {
    value = null
  }
  memory.set(key, value)
  return value
}

function writeRaw(key: string, value: string | null): void {
  memory.set(key, value)
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Not persisted; still applies for this tab via `memory`.
  }
  for (const listener of listeners.get(key) ?? []) listener()
}

let storageListenerAttached = false

function subscribeTo(key: string, onChange: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  const firstSubscriber = set.size === 0
  set.add(onChange)

  // A view mounting picks up whatever another tab wrote while nothing here
  // was listening (the storage event below only reaches live listeners).
  if (firstSubscriber) {
    try {
      const stored = window.localStorage.getItem(key)
      if (!memory.has(key) || memory.get(key) !== stored) {
        memory.set(key, stored)
        queueMicrotask(() => {
          for (const listener of listeners.get(key) ?? []) listener()
        })
      }
    } catch {
      // Storage unavailable: keep the in-tab value.
    }
  }

  // Another tab changed it: drop our mirror and re-read.
  if (!storageListenerAttached && typeof window !== 'undefined') {
    storageListenerAttached = true
    window.addEventListener('storage', (event) => {
      if (event.key === null) {
        memory.clear()
        for (const group of listeners.values()) for (const listener of group) listener()
        return
      }
      if (!listeners.has(event.key)) return
      memory.delete(event.key)
      for (const listener of listeners.get(event.key) ?? []) listener()
    })
  }

  return () => {
    const current = listeners.get(key)
    if (!current) return
    current.delete(onChange)
    if (current.size === 0) listeners.delete(key)
  }
}
