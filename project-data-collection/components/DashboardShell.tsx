'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { logoutUser } from '@/lib/auth'

type DashboardShellProps = {
  user: {
    name: string
    email: string
    role: string
  }
}

export default function DashboardShell({ user }: DashboardShellProps) {
  const router = useRouter()

  const isAdmin = user.role === 'admin'

  const tabs = isAdmin
    ? ['Overview', 'Projects', 'Collaborators', 'Settings']
    : ['My Projects', 'Submissions', 'Profile']

  const [activeTab, setActiveTab] = useState(tabs[0])

  function handleLogout() {
    logoutUser()
    router.replace('/')
  }

  const content = useMemo(() => {
    return `Empty ${activeTab} area`
  }, [activeTab])

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-gray-50 to-white">
      
      {/* Top header (minimal, app-like) */}
      <div className="flex items-center justify-between px-6 pt-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-gray-400">
            Project Data Collection
          </p>
          <h1 className="text-xl font-semibold text-gray-900">
            {activeTab}
          </h1>
        </div>

        <button
          onClick={handleLogout}
          className="rounded-full bg-black px-4 py-2 text-xs text-white"
        >
          Logout
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 px-6 pb-28 pt-6">
        <div className="h-full rounded-3xl border border-gray-200 bg-white p-6 shadow-sm transition-all duration-300">
          <p className="text-gray-500">{content}</p>
        </div>
      </div>

      {/* Floating Bottom Nav */}
      <div className="fixed bottom-6 left-1/2 z-50 w-[90%] max-w-md -translate-x-1/2">
        <div className="relative flex items-center justify-between rounded-2xl bg-white/90 px-3 py-2 shadow-xl backdrop-blur-md border border-gray-200">
          
          {tabs.map((tab) => {
            const isActive = activeTab === tab

            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="relative flex flex-1 flex-col items-center justify-center py-2 text-xs font-medium"
              >
                {/* Animated background */}
                {isActive && (
                  <div className="absolute inset-0 rounded-xl bg-black/5 transition-all duration-300" />
                )}

                {/* Label */}
                <span
                  className={`relative z-10 transition-all duration-200 ${
                    isActive
                      ? 'text-black scale-105'
                      : 'text-gray-400'
                  }`}
                >
                  {tab}
                </span>

                {/* Active indicator */}
                <div
                  className={`mt-1 h-1 w-5 rounded-full transition-all duration-300 ${
                    isActive ? 'bg-black opacity-100' : 'opacity-0'
                  }`}
                />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}