'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { useAuth } from '@/lib/auth-context'
import { useProjectRole } from '@/lib/project-role'
import { Project, SafeUser } from '@/lib/types'
import SettingsTab from './SettingsTab'
import AddDataTab from './AddDataTab'
import MasterViewTab from './MasterViewTab'
import ChunkingTab from './ChunkingTab'
import TimelineTab from './TimelineTab'
import WorkspaceTopBar from './shell/WorkspaceTopBar'
import WorkspaceNav, { WorkspaceNavTab } from './shell/WorkspaceNav'

type ProjectDashboardShellProps = {
  user: SafeUser
  project: Project
}

type TabKey = 'settings' | 'add-data' | 'master-view' | 'packaging' | 'timeline'

/**
 * Tabs that have since been folded into another one, mapped to where they
 * live now. Cost Model became a popup on the Timeline, and a link someone
 * saved or emailed before that should still land somewhere sensible.
 */
const RETIRED_TABS: Record<string, TabKey> = {
  'cost-model': 'timeline',
  // Chunking was renamed Phasing, then Packaging; old links keep working.
  chunking: 'packaging',
  phasing: 'packaging',
}

/** Views that want every pixel (wide matrices, the Gantt) vs. forms that read
 *  better in a centred column. */
const FULL_WIDTH_TABS: TabKey[] = ['settings', 'master-view', 'packaging', 'timeline']

export default function ProjectDashboardShell({
  user,
  project: initialProject,
}: ProjectDashboardShellProps) {
  const router = useRouter()
  const { signOut } = useAuth()
  const [project, setProject] = useState(initialProject)

  /**
   * Authority is PER PROJECT (migration 0009), not the global
   * `profiles.role` boolean this used to read. The same person can be an
   * editor on one project and a viewer on another, which a single
   * `user.role === 'admin'` check cannot express.
   *
   * This decides what to RENDER. RLS decides what is allowed. Every gate
   * below is re-made in the database on the way to the data, so being
   * wrong here is a presentation bug, not a security one — but it is
   * still worth getting right, because a button whose every save is
   * silently filtered to zero rows reads as the app being broken.
   */
  const permissions = useProjectRole(project.id)
  const { isAdmin, canContribute } = permissions

  const tabs: WorkspaceNavTab<TabKey>[] = [
    // Members and roles. Project admins only. A gear, not a labelled pill:
    // it is set-up, not one of the views people move between all day.
    ...(isAdmin ? [{ key: 'settings' as const, label: 'Settings', iconOnly: true }] : []),
    // Creating and editing your own line items. A viewer has no write path
    // at all, so the form would only ever fail for them.
    ...(canContribute ? [{ key: 'add-data' as const, label: 'Add Data' }] : []),
    // Read-only surfaces: everyone who can open the project at all.
    { key: 'master-view', label: 'Master View' },
    { key: 'packaging', label: 'Packaging' },
    // Cost parameters now open from here as a popup rather than a tab.
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
   * packaging schedule" can be a URL rather than a set of instructions.
   *
   * An unknown or absent `?tab=` falls back to Add Data, and a tab the user's
   * role cannot see falls back too — otherwise a link shared with a consultant
   * would render a blank panel. A retired tab maps to its new home first.
   */
  const searchParams = useSearchParams()
  const rawTab = searchParams.get('tab')
  const requestedTab = (rawTab ? (RETIRED_TABS[rawTab] ?? rawTab) : null) as TabKey | null
  const isKnownTab = tabs.some((tab) => tab.key === requestedTab)

  // Add Data for anyone who has it (not tabs[0], which is Settings for an
  // admin), otherwise Master View: a viewer has no Add Data tab, and falling
  // back to a tab that is not in their list would render an empty panel.
  const fallbackTab: TabKey = canContribute ? 'add-data' : 'master-view'
  const activeTab: TabKey = isKnownTab ? (requestedTab as TabKey) : fallbackTab

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
    // Wait for the role to resolve. Normalising while `permissions.loading`
    // is true would rewrite a perfectly good ?tab=settings link into the
    // fallback on every page load, because the tab list is still narrow.
    if (permissions.loading) return
    if (requestedTab && !isKnownTab) setActiveTab(fallbackTab)
    else if (rawTab && rawTab !== requestedTab) setActiveTab(activeTab)
  }, [rawTab, requestedTab, isKnownTab, setActiveTab, fallbackTab, activeTab, permissions.loading])

  // The view scrolls inside the box, and the box outlives every tab switch,
  // so without this a new view would open at the previous one's offset --
  // half-way down a page the user never scrolled.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 })
  }, [activeTab])

  async function handleLogout() {
    await signOut()
    router.replace('/')
  }

  function renderTabContent() {
    /**
     * Wait for the role before mounting ANY tab panel.
     *
     * `tabs` above widens the instant `permissions.loading` flips to false --
     * Settings and/or Add Data can appear ahead of Master View in that same
     * render, which moves `fallbackTab` out from under `activeTab`. Computing
     * `activeTab` first and rendering it while still loading means mounting
     * whatever panel the NARROW list picked (typically Master View), firing
     * its data fetch, and then unmounting it a moment later for the panel the
     * resolved role actually lands on -- a real network request nobody asked
     * for, and an admin watching Master View appear before being replaced by
     * Settings. Because `activeTab` is derived fresh from `tabs` on every
     * render, the render where `loading` becomes false already reflects the
     * final tab list, so holding off until then means the first panel ever
     * mounted is the right one -- never a two-panel sequence.
     */
    if (permissions.loading) {
      return (
        <div className="py-16 text-center text-sm font-medium text-slate-400">Loading…</div>
      )
    }

    switch (activeTab) {
      case 'settings':
        return isAdmin ? (
          <SettingsTab project={project} onProjectUpdated={setProject} />
        ) : null
      case 'add-data':
        return canContribute ? (
          <AddDataTab project={project} user={user} permissions={permissions} />
        ) : null
      case 'master-view':
        return <MasterViewTab project={project} permissions={permissions} />
      case 'packaging':
        return <ChunkingTab project={project} permissions={permissions} />
      case 'timeline':
        return (
          <TimelineTab
            project={project}
            permissions={permissions}
            onOpenMasterView={() => setActiveTab('master-view')}
          />
        )
      default:
        return null
    }
  }

  const currentTab = tabs.find((tab) => tab.key === activeTab)
  const isFullWidth = FULL_WIDTH_TABS.includes(activeTab)

  /*
   * Layout: the page itself never scrolls. A 100dvh column holds the top bar,
   * then one rounded box that fills the rest of the viewport down to just
   * above the floating nav, and the active view scrolls INSIDE that box
   * (`data-workspace-scroll`). The frame stays put while a long Master View
   * or Timeline moves under it, and the nav never covers the last row,
   * because the box ends above it rather than running underneath.
   *
   * `min-h-0` on every flex child between the column and the scroller is
   * load-bearing: a flex item's default min-height is its content height,
   * which would let the box grow past the viewport and hand the scrolling
   * back to the window.
   *
   * Print undoes all of this (app/globals.css, the `data-workspace-*`
   * selectors): a fixed-height box with an inner scroller would print one
   * viewport's worth of Timeline and clip the rest.
   */
  return (
    <div data-workspace-root className="flex h-[100dvh] flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_24%),radial-gradient(circle_at_top_right,_rgba(56,189,248,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f7f8fc_50%,_#edf2f7_100%)]">
      <WorkspaceTopBar
        project={project}
        user={user}
        permissions={permissions}
        viewLabel={currentTab?.label}
        onProjectUpdated={setProject}
        onLogout={handleLogout}
      />

      <main data-workspace-main className="flex min-h-0 flex-1 flex-col px-3 pb-[6.5rem] pt-3 md:px-5 md:pt-4">
        <div
          data-workspace-box
          className={`mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[2rem] border border-white/70 bg-white/78 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl ${
            isFullWidth ? 'max-w-full' : 'max-w-5xl'
          }`}
        >
          <div
            ref={scrollRef}
            data-workspace-scroll
            className={`min-h-0 flex-1 overflow-auto ${isFullWidth ? 'p-4 md:p-5' : 'p-6'}`}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 18, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.992 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="h-full"
              >
                {renderTabContent()}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </main>

      <WorkspaceNav tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} />
    </div>
  )
}
