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

  // The client-side filter below keeps the UI honest, but RLS is the real
  // security boundary now — a consultant's fetch never returns projects they
  // are not assigned to.
  const projects =
    user.role === 'admin'
      ? allProjects
      : allProjects.filter((project) => project.assignedUsers.includes(user.email))

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
