'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import ProjectsHome from '@/components/ProjectsHome'
import { getCurrentUser } from '@/lib/auth'
import { getStoredProjects } from '@/lib/store'
import { Project, SafeUser } from '@/lib/types'

export default function ProjectsPage() {
  const router = useRouter()
  const [user] = useState<SafeUser | null>(() => getCurrentUser())
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!user) {
      router.replace('/')
    }
  }, [user, router])

  useEffect(() => {
    const handleFocus = () => setRefreshKey((v) => v + 1)
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  const projects = useMemo(() => {
    const allProjects = getStoredProjects()

    if (!user) return []

    return user.role === 'admin'
      ? allProjects
      : allProjects.filter((project) => project.assignedUsers.includes(user.email))
  }, [user, refreshKey])

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  return <ProjectsHome user={user} projects={projects as Project[]} />
}