'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { useAsyncData } from '@/lib/useAsyncData'
import { getProjectById } from '@/lib/store'
import { Project } from '@/lib/types'
import ProjectDashboardShell from '@/components/project-workspace/ProjectDashboardShell'

export default function ProjectDashboardPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/')
    }
  }, [authLoading, user, router])

  const {
    data: project,
    loading: projectLoading,
    error,
  } = useAsyncData<Project | null>(
    () => getProjectById(params.id),
    [params.id],
    null
  )

  if (authLoading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  if (projectLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Loading project...</p>
      </main>
    )
  }

  // With RLS enforced server-side, a project this user cannot access simply
  // comes back null, so "not found" and "no access" collapse into one state.
  if (error || !project) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">
          This project was not found, or you do not have access to it.
        </p>
      </main>
    )
  }

  return <ProjectDashboardShell user={user} project={project} />
}
