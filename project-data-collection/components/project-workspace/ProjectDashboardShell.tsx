'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { logoutUser } from '@/lib/auth'
import { Project, SafeUser } from '@/lib/types'
import SettingsTab from './SettingsTab'
import AddDataTab from './AddDataTab'
import MasterViewTab from './MasterViewTab'
import ChunkingTab from './ChunkingTab'
import VisualsTab from './VisualsTab'

type ProjectDashboardShellProps = {
  user: SafeUser
  project: Project
}

type TabKey =
  | 'settings'
  | 'add-data'
  | 'master-view'
  | 'chunking'
  | 'visuals'

type Tab = {
  key: TabKey
  label: string
  icon?: string
}

export default function ProjectDashboardShell({
  user,
  project: initialProject,
}: ProjectDashboardShellProps) {
  const router = useRouter()
  const isAdmin = user.role === 'admin'
  const [project, setProject] = useState(initialProject)

  const tabs: Tab[] = isAdmin
    ? [
        { key: 'settings', label: 'Settings', icon: 'S' },
        { key: 'add-data', label: 'Add Data' },
        { key: 'master-view', label: 'Master View' },
        { key: 'chunking', label: 'Chunking' },
        { key: 'visuals', label: 'Visuals' },
      ]
    : [
        { key: 'add-data', label: 'Add Data' },
        { key: 'master-view', label: 'Master View' },
        { key: 'chunking', label: 'Chunking' },
        { key: 'visuals', label: 'Visuals' },
      ]

  const [activeTab, setActiveTab] = useState<TabKey>('add-data')

  function handleLogout() {
    logoutUser()
    router.replace('/')
  }

  function renderTabContent() {
    switch (activeTab) {
      case 'settings':
        return isAdmin ? (
          <SettingsTab project={project} onProjectUpdated={setProject} />
        ) : null
      case 'add-data':
        return <AddDataTab project={project} user={user} />
      case 'master-view':
        return <MasterViewTab project={project} />
      case 'chunking':
        return <ChunkingTab project={project} />
      case 'visuals':
        return <VisualsTab />
      default:
        return null
    }
  }

  const currentTab = tabs.find((tab) => tab.key === activeTab)
  const isWideTab = activeTab === 'master-view' || activeTab === 'chunking'

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_24%),radial-gradient(circle_at_top_right,_rgba(56,189,248,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f7f8fc_50%,_#edf2f7_100%)]">
      <div
        className={`mx-auto px-4 pb-32 pt-6 md:px-6 ${
          isWideTab ? 'max-w-full' : 'max-w-7xl'
        }`}
      >
        <div className="mb-6 overflow-hidden rounded-[2rem] border border-white/70 bg-white/72 px-5 py-5 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl md:px-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
                {isAdmin ? 'Admin Workspace' : 'Consultant Workspace'}
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                {project.name}
              </h1>
              <div className="mt-4 flex flex-wrap gap-2">
                <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900">
                  {currentTab?.label}
                </div>
                <div className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-900">
                  {user.name}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Link
                href="/projects"
                className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300"
              >
                Back
              </Link>
              <button
                onClick={handleLogout}
                className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        <div
          className={`rounded-[2rem] border border-white/70 bg-white/78 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl ${
            isWideTab ? 'p-4 md:p-5' : 'p-6'
          }`}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 18, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.992 }}
              transition={{ duration: 0.28, ease: 'easeOut' }}
            >
              {renderTabContent()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="fixed bottom-6 left-1/2 z-50 w-[94%] max-w-3xl -translate-x-1/2">
        <div className="flex items-center justify-between rounded-[2rem] border border-white/70 bg-white/74 p-2 shadow-[0_24px_70px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key

            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className="relative flex flex-1 items-center justify-center px-2 py-3"
                aria-label={tab.label}
                title={tab.label}
              >
                {isActive ? (
                  <motion.div
                    layoutId="active-tab-pill"
                    className="absolute inset-0 rounded-[1.4rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)]"
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  />
                ) : null}

                <motion.span
                  animate={{
                    scale: isActive ? 1.03 : 1,
                    opacity: isActive ? 1 : 0.74,
                  }}
                  transition={{ duration: 0.18 }}
                  className={`relative z-10 flex items-center justify-center text-xs font-medium md:text-sm ${
                    isActive ? 'text-white' : 'text-slate-700'
                  }`}
                >
                  {tab.icon || tab.label}
                </motion.span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
