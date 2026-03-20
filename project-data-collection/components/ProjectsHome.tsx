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
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_24%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_26%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_45%,_#eef2f7_100%)] px-4 py-6 md:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 overflow-hidden rounded-[2rem] border border-white/70 bg-white/72 px-6 py-6 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
                Project Data Collection
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                {isAdmin ? 'Project Control Room' : 'Assigned Projects'}
              </h1>
              <p className="mt-3 text-base text-slate-600">
                {isAdmin
                  ? 'Launch new projects, move between workspaces, and manage consultant teams from one place.'
                  : 'Open the active projects assigned to you and continue work from the latest dashboard state.'}
              </p>
            </div>

            <div className="flex items-center gap-3">
              {isAdmin ? (
                <Link
                  href="/projects/new"
                  className="rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
                >
                  Create New Project
                </Link>
              ) : null}

              <button
                onClick={handleLogout}
                className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300"
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project, index) => (
            <motion.div
              key={project.id}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.06, duration: 0.38 }}
            >
              <Link
                href={`/projects/${project.id}`}
                className="group block overflow-hidden rounded-[2rem] border border-white/70 bg-white/76 p-6 shadow-[0_20px_70px_rgba(15,23,42,0.10)] backdrop-blur-2xl transition duration-300 hover:-translate-y-1 hover:shadow-[0_30px_80px_rgba(15,23,42,0.14)]"
              >
                <div className="mb-6 flex items-center justify-between">
                  <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900">
                    {project.consultants.length} teams
                  </div>
                  <span className="text-xs text-slate-400">
                    {formatProjectDate(project.createdAt)}
                  </span>
                </div>

                <h2 className="text-2xl font-semibold tracking-tight text-slate-950 transition group-hover:text-slate-800">
                  {project.name}
                </h2>

                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {isAdmin
                    ? 'Full project access with consultant setup, package creation, and submission management.'
                    : 'Assigned workspace for line items, review, chunking, and ongoing project coordination.'}
                </p>

                <div className="mt-6 flex items-center justify-between">
                  <div className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-900">
                    Open Workspace
                  </div>
                  <div className="text-xs text-slate-400">
                    Created {formatProjectDate(project.createdAt)}
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>

        {projects.length === 0 ? (
          <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/76 p-12 text-center shadow-sm backdrop-blur-xl">
            <h2 className="text-xl font-semibold text-slate-950">No projects yet</h2>
            <p className="mt-2 text-sm text-slate-500">
              {isAdmin
                ? 'Create your first project to start building packages and collecting line-item data.'
                : 'No projects have been assigned to you yet.'}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  )
}
