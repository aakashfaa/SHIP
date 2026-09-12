'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { useAuth } from '@/lib/auth-context'
import { Project, SafeUser } from '@/lib/types'
import SettingsTab from './SettingsTab'
import AddDataTab from './AddDataTab'
import MasterViewTab from './MasterViewTab'
import ChunkingTab from './ChunkingTab'
import TimelineTab from './TimelineTab'
import CostModelTab from './CostModelTab'

type ProjectDashboardShellProps = {
  user: SafeUser
  project: Project
}

type TabKey =
  | 'settings'
  | 'add-data'
  | 'master-view'
  | 'chunking'
  | 'timeline'
  | 'cost-model'

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
  const { signOut } = useAuth()
  const isAdmin = user.role === 'admin'
  const [project, setProject] = useState(initialProject)

  const tabs: Tab[] = isAdmin
    ? [
        { key: 'settings', label: 'Settings', icon: 'S' },
        { key: 'add-data', label: 'Add Data' },
        { key: 'master-view', label: 'Master View' },
        { key: 'chunking', label: 'Chunking' },
        { key: 'timeline', label: 'Timeline' },
        { key: 'cost-model', label: 'Cost Model' },
      ]
    : [
        { key: 'add-data', label: 'Add Data' },
        { key: 'master-view', label: 'Master View' },
        { key: 'chunking', label: 'Chunking' },
        { key: 'timeline', label: 'Timeline' },
      ]

  /**
   * The active tab lives in the URL.
   *
   * It used to be local state, which meant a refresh silently dropped you back
   * to Add Data. That is a small annoyance in normal use and a real one in the
   * situation this tool is built for — presenting a plan to a client, where
   * the Timeline is the whole point and an accidental reload takes it away.
   *
   * Putting it in the query string also makes a tab linkable, so "here's the
   * phasing schedule" can be a URL rather than a set of instructions.
   *
   * An unknown or absent `?tab=` falls back to Add Data, and a tab the user's
   * role cannot see falls back too — otherwise a link shared with a consultant
   * would render a blank panel.
   */
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab') as TabKey | null
  const isKnownTab = tabs.some((tab) => tab.key === requestedTab)
  const activeTab: TabKey = isKnownTab ? (requestedTab as TabKey) : 'add-data'

  const setActiveTab = useCallback(
    (key: TabKey) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('tab', key)
      // `replace`, not `push`: tab switching is navigation within one view, and
      // filling the back stack with it would make Back mean "previous tab"
      // rather than "previous page", which is not what anyone expects.
      router.replace(`?${params.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  // Normalise a stale or unauthorised ?tab= back into the URL, so the address
  // bar never disagrees with what is on screen.
  useEffect(() => {
    if (requestedTab && !isKnownTab) setActiveTab('add-data')
  }, [requestedTab, isKnownTab, setActiveTab])

  async function handleLogout() {
    await signOut()
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
      case 'timeline':
        return <TimelineTab project={project} />
      // Admin-only for now, matching migration 0006's write policy. A
      // consultant would otherwise get a form whose every save is silently
      // filtered to zero rows, which reads as the app being broken. 0009
      // widens the policy and this gate together.
      case 'cost-model':
        return isAdmin ? <CostModelTab project={project} /> : null
      default:
        return null
    }
  }

  const currentTab = tabs.find((tab) => tab.key === activeTab)
  const widthClass =
    activeTab === 'master-view' || activeTab === 'timeline'
      ? 'max-w-full'
      : activeTab === 'chunking'
        ? 'max-w-[88rem]'
        : 'max-w-7xl'

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_24%),radial-gradient(circle_at_top_right,_rgba(56,189,248,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f7f8fc_50%,_#edf2f7_100%)]">
      <div className={`mx-auto px-4 pb-32 pt-6 md:px-6 ${widthClass}`}>
        <div className="mb-6 overflow-hidden rounded-[2rem] border border-white/70 bg-white/72 px-5 py-5 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl md:px-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
                {isAdmin ? 'Admin Workspace' : 'Consultant Workspace'}
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                {project.name}
              </h1>
              <div className="mt-4">
                <div className="text-lg font-medium text-slate-700">{currentTab?.label}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
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
            activeTab === 'master-view' || activeTab === 'timeline' ? 'p-4 md:p-5' : 'p-6'
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
