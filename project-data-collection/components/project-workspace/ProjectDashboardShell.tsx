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
        { key: 'settings', label: 'Settings', icon: '⚙' },
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
        return <ChunkingTab />
      case 'visuals':
        return <VisualsTab />
      default:
        return null
    }
  }

  const currentTab = tabs.find((tab) => tab.key === activeTab)

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-100 via-white to-zinc-100">
      <div className="mx-auto max-w-6xl px-4 pb-32 pt-6 md:px-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-gray-400">
              {isAdmin ? 'Admin Workspace' : 'Consultant Workspace'}
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-gray-900">
              {project.name}
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              {currentTab?.label} · {user.name}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/projects"
              className="rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700"
            >
              Back
            </Link>
            <button
              onClick={handleLogout}
              className="rounded-2xl bg-black px-4 py-3 text-sm font-medium text-white"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/60 bg-white/85 p-6 shadow-2xl backdrop-blur-xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 14, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.99 }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
            >
              {renderTabContent()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="fixed bottom-6 left-1/2 z-50 w-[94%] max-w-2xl -translate-x-1/2">
        <div className="flex items-center justify-between rounded-[2rem] border border-white/60 bg-white/80 p-2 shadow-2xl backdrop-blur-2xl">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key
            const isSettings = tab.key === 'settings'

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
                    className="absolute inset-0 rounded-[1.4rem] bg-black"
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  />
                ) : null}

                <motion.span
                  animate={{
                    scale: isActive ? 1.03 : 1,
                    opacity: isActive ? 1 : 0.68,
                  }}
                  transition={{ duration: 0.18 }}
                  className={`relative z-10 flex items-center justify-center text-xs font-medium md:text-sm ${
                    isActive ? 'text-white' : 'text-gray-700'
                  }`}
                >
                  {isSettings ? (
                    <span className="text-base md:text-lg">{tab.icon}</span>
                  ) : (
                    tab.label
                  )}
                </motion.span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}