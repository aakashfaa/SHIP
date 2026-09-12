'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from './supabase/client'

/**
 * The caller's role on one project.
 *
 * Authority moved from a global `profiles.role` boolean to a per-project role
 * in migration 0009. This is the client's view of that.
 *
 * IT IS NOT THE SECURITY BOUNDARY. RLS is. Everything here decides what to
 * *render* — whether to show a tab, whether to put a drag handle on a bar —
 * and every one of those decisions is re-made in the database on the way to
 * the data. The reason to do it in the UI at all is that a form whose every
 * save is silently filtered to zero rows reads as the app being broken, which
 * is a worse experience than not being offered the form.
 *
 * The role is read from `ship.project_role()` rather than reconstructed from
 * the `project_roles` table, so the client and the policies agree by
 * construction. That function encodes the whole resolution order — platform
 * admin, then an explicit role row, then a `project_members` row falling back
 * to consultant — and duplicating it here would guarantee the two drift.
 */

export type ProjectRole = 'admin' | 'editor' | 'consultant' | 'viewer'

export type ProjectPermissions = {
  role: ProjectRole | null
  loading: boolean
  /** Full control, including who else gets in. */
  isAdmin: boolean
  /** May change the plan: packages, phases, the schedule, cost settings. */
  canEdit: boolean
  /** May create and edit their OWN line items, and file suggestions against
   *  other people's. Everyone except a viewer. */
  canContribute: boolean
  /** Read-only. Their sandbox is ephemeral and nothing they do persists. */
  isViewer: boolean
}

const EDITOR_ROLES: ProjectRole[] = ['admin', 'editor']
const CONTRIBUTOR_ROLES: ProjectRole[] = ['admin', 'editor', 'consultant']

export function permissionsForRole(
  role: ProjectRole | null,
  loading = false
): ProjectPermissions {
  return {
    role,
    loading,
    isAdmin: role === 'admin',
    canEdit: role !== null && EDITOR_ROLES.includes(role),
    canContribute: role !== null && CONTRIBUTOR_ROLES.includes(role),
    isViewer: role === 'viewer',
  }
}

export function useProjectRole(projectId: string): ProjectPermissions {
  const [role, setRole] = useState<ProjectRole | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    getSupabaseBrowserClient()
      .rpc('project_role', { p_project_id: projectId })
      .then(({ data, error }) => {
        if (cancelled) return
        // A failure here must not be treated as "admin". Falling back to the
        // most permissive state on an error is how a read-only user gets shown
        // controls that then fail; null renders the narrowest UI, which is the
        // safe direction to be wrong in.
        setRole(error || typeof data !== 'string' ? null : (data as ProjectRole))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  return permissionsForRole(role, loading)
}
