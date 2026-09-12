'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ProjectsHome from '@/components/ProjectsHome'
import { useAuth } from '@/lib/auth-context'
import { useAsyncData } from '@/lib/useAsyncData'
import { getStoredProjects } from '@/lib/store'
import { Project } from '@/lib/types'

export default function ProjectsPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/')
    }
  }, [authLoading, user, router])

  const {
    data: allProjects,
    loading: projectsLoading,
    error,
    reload,
  } = useAsyncData<Project[]>(() => getStoredProjects(), [user?.email], [])

  useEffect(() => {
    const handleFocus = () => reload()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [reload])

  if (authLoading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  // No client-side filter here. `getStoredProjects()` already ran through
  // RLS (`projects_select`, which is driven by `my_project_ids()`) as this
  // user, so `allProjects` IS their access list — not a superset of it.
  //
  // That used to not be true. The old filter re-derived access from
  // `assignedUsers`, which is sourced from `project_members`
  // (`project_members_select` is restricted to contributors). But migration
  // 0009 lets someone hold a project role — viewer included — via
  // `project_roles` with no `project_members` row at all. For that person
  // `assignedUsers` is `[]`: the filter above zeroed their list even though
  // RLS had already handed them the project, so a viewer's only way into
  // their own project was a direct URL. RLS is strictly WIDER than any
  // client-side reconstruction of it now, so filtering here can only ever
  // subtract real access, never add safety.
  const projects = allProjects

  if (projectsLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Loading projects...</p>
      </main>
    )
  }

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-red-500">
          Could not load projects. Please try again.
        </p>
      </main>
    )
  }

  return <ProjectsHome user={user} projects={projects} />
}
