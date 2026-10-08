'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/lib/auth-context'
import { fetchAccessNotices, markAccessNoticesSeen } from '@/lib/store'

// "You've been added to <Project>" toasts (D-7).
//
// When an admin adds someone who ALREADY has an account, the invite route
// sends them a plain sign-in email (no login token) and writes a row to
// ship.project_access_notices. This component, mounted once in the root
// layout, shows each unseen row as a toast the next time that person is
// signed in, then marks it seen so it appears exactly once.
//
// Uses lib/store.ts `fetchAccessNotices` / `markAccessNoticesSeen`; RLS (0013)
// limits both to rows addressed to the caller's own email.
//
// Fails silent: if the request errors, nobody should see an error about a
// nice-to-have toast.

type Notice = { id: string; projectId: string; projectName: string; owner: string }

const AUTO_DISMISS_MS = 15_000

export default function AccessNotices() {
  const { user } = useAuth()
  const [notices, setNotices] = useState<Notice[]>([])
  const loadedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!user) {
      loadedForRef.current = null
      return
    }
    if (loadedForRef.current === user.email) return
    loadedForRef.current = user.email

    let cancelled = false
    void (async () => {
      let rows
      try {
        rows = await fetchAccessNotices()
      } catch (err) {
        console.error('AccessNotices: could not load notices', err)
        return
      }
      if (cancelled || rows.length === 0) return

      // A notice for a project they can no longer read (access removed again
      // since) comes back with the id as its name: mark it seen, no toast.
      setNotices(
        rows
          .filter((r) => r.projectName && r.projectName !== r.projectId)
          .slice(0, 5)
          .map((r) => ({
            id: r.id,
            projectId: r.projectId,
            projectName: r.projectName,
            owner: user.email,
          }))
      )

      try {
        await markAccessNoticesSeen(rows.map((r) => r.id))
      } catch (err) {
        console.error('AccessNotices: could not mark notices seen', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [user])

  useEffect(() => {
    if (notices.length === 0) return
    const timer = window.setTimeout(() => setNotices([]), AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [notices])

  // Only the signed-in user's own notices (after a sign-out, stale state from
  // the previous user is simply never rendered).
  const visible = notices.filter((n) => n.owner === user?.email)
  if (visible.length === 0) return null

  const dismiss = (id: string) => setNotices((prev) => prev.filter((n) => n.id !== id))

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 top-4 z-[60] flex flex-col items-end gap-3 sm:left-auto sm:right-6 sm:w-[380px]"
    >
      {visible.map((notice) => (
        <div
          key={notice.id}
          role="status"
          data-testid="access-notice"
          className="pointer-events-auto w-full rounded-2xl border border-teal-200 bg-white/95 p-4 shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 h-2.5 w-2.5 flex-none rounded-full bg-teal-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">
                You&apos;ve been added to {notice.projectName}
              </p>
              <p className="mt-1 text-sm text-slate-600">It&apos;s now in your project list.</p>
              <Link
                href={`/projects/${encodeURIComponent(notice.projectId)}`}
                onClick={() => dismiss(notice.id)}
                className="mt-2 inline-block text-sm font-medium text-teal-700 hover:text-teal-800"
              >
                Open project
              </Link>
            </div>
            <button
              type="button"
              onClick={() => dismiss(notice.id)}
              aria-label="Dismiss"
              className="flex-none rounded-full px-2 text-lg leading-none text-slate-400 hover:text-slate-700"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
