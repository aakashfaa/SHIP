'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getStoredProjects } from '@/lib/store'
import { Project, SafeUser } from '@/lib/types'
import ProjectDashboardShell from '@/components/project-workspace/ProjectDashboardShell'

export default function ProjectDashboardPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [user] = useState<SafeUser | null>(() => getCurrentUser())

  useEffect(() => {
    if (!user) {
      router.replace('/')
    }
  }, [user, router])

  const project = useMemo(() => {
    return getStoredProjects().find((item) => item.id === params.id) as
      | Project
      | undefined
  }, [params.id])

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  if (!project) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Project not found.</p>
      </main>
    )
  }

  const isAllowed =
    user.role === 'admin' || project.assignedUsers.includes(user.email)

  if (!isAllowed) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">
          You do not have access to this project.
        </p>
      </main>
    )
  }

  return <ProjectDashboardShell user={user} project={project} />
}