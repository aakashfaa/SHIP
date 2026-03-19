'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { logoutUser } from '@/lib/auth'
import { Project, SafeUser } from '@/lib/types'

type ProjectsHomeProps = {
  user: SafeUser
  projects: Project[]
}

function formatProjectDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default function ProjectsHome({ user, projects }: ProjectsHomeProps) {
  const router = useRouter()
  const isAdmin = user.role === 'admin'

  function handleLogout() {
    logoutUser()
    router.replace('/')
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-100 via-white to-zinc-100 px-4 py-6 md:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-gray-400">
              Project Data Collection
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-gray-900">
              {isAdmin ? 'Projects Home' : 'Assigned Projects'}
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              {isAdmin
                ? 'Create, access, and manage project dashboards.'
                : 'Open the projects assigned to you.'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {isAdmin ? (
              <Link
                href="/projects/new"
                className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:scale-[1.01]"
              >
                Create New Project
              </Link>
            ) : null}

            <button
              onClick={handleLogout}
              className="rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project, index) => (
            <motion.div
              key={project.id}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05, duration: 0.35 }}
            >
              <Link
                href={`/projects/${project.id}`}
                className="group block rounded-[2rem] border border-white/60 bg-white/85 p-6 shadow-xl backdrop-blur-xl transition hover:-translate-y-1"
              >
                <div className="mb-5 flex items-center justify-between">
                  <div className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                    {project.consultants.length} teams
                  </div>
                  <span className="text-xs text-gray-400">
                    {formatProjectDate(project.createdAt)}
                  </span>
                </div>

                <h2 className="text-xl font-semibold text-gray-900 transition group-hover:text-black">
                  {project.name}
                </h2>

                <p className="mt-3 text-sm text-gray-500">
                  {isAdmin
                    ? 'Full project access with consultant setup and management.'
                    : 'Assigned project dashboard for submissions and coordination.'}
                </p>

                <div className="mt-6 text-sm text-gray-400">
                  Created {formatProjectDate(project.createdAt)}
                </div>
              </Link>
            </motion.div>
          ))}
        </div>

        {projects.length === 0 ? (
          <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white/80 p-10 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900">
              No projects yet
            </h2>
            <p className="mt-2 text-sm text-gray-500">
              {isAdmin
                ? 'Create your first project to get started.'
                : 'No projects have been assigned to you yet.'}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  )
}