'use client'

import { useEffect } from 'react'
import Link from 'next/link'
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

  // Signed out (or the session ended): go to sign-in, but remember where they
  // were going. A link emailed to a client ("here's the phasing schedule")
  // used to drop them on the project list after sign-in (UX-8); `/` honours
  // `?next=` once the profile has loaded.
  useEffect(() => {
    if (!authLoading && !user) {
      const here = `${window.location.pathname}${window.location.search}`
      router.replace(`/?next=${encodeURIComponent(here)}`)
    }
  }, [authLoading, user, router])

  const {
    data: project,
    loading: projectLoading,
    error,
    reload,
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
  // A failed fetch is different (network blip, server error): it gets
  // "couldn't load" and a Retry, not "you don't have access".
  if (error || !project) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4">
        <div className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 text-center shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            {error ? "Couldn't load this project" : 'Project not available'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {error
              ? 'Something went wrong while loading it. Check your connection and try again.'
              : `This project doesn't exist, or ${user.email} doesn't have access to it. If you were just added, ask your project admin to check the email they used.`}
          </p>
          <div className="mt-6 space-y-3">
            {error ? (
              <button
                type="button"
                onClick={() => reload()}
                className="w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg"
              >
                Try again
              </button>
            ) : null}
            <Link
              href="/projects"
              className="block w-full rounded-2xl border border-slate-200 bg-white/60 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-white/90"
            >
              Back to projects
            </Link>
          </div>
        </div>
      </main>
    )
  }

  return <ProjectDashboardShell user={user} project={project} />
}
