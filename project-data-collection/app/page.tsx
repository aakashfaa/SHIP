'use client'

import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { useRouter } from 'next/navigation'
import LoginForm from '@/components/LoginForm'
import { useAuth } from '@/lib/auth-context'

export default function HomePage() {
  const router = useRouter()
  const { user, loading, noAccess } = useAuth()

  useEffect(() => {
    if (user) {
      router.replace('/projects')
      return
    }

    if (noAccess) {
      router.replace('/no-access')
    }
  }, [user, noAccess, router])

  if (loading || user || noAccess) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4">
        <p className="text-sm text-slate-500">Redirecting...</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4 py-8 md:px-6">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="rounded-[2.5rem] border border-white/60 bg-[linear-gradient(160deg,rgba(15,23,42,0.96)_0%,rgba(30,41,59,0.94)_52%,rgba(15,118,110,0.90)_100%)] p-8 text-white shadow-[0_32px_120px_rgba(15,23,42,0.28)] md:p-12"
        >
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-300/80">
              Finegold Alexander Architects
            </p>
            <h1 className="mt-5 text-5xl font-semibold tracking-tight md:text-6xl">
              Master Plan Dashboard
            </h1>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <div className="rounded-[1.5rem] border border-white/10 bg-white/8 p-4 backdrop-blur-xl">
                <div className="text-2xl font-semibold">01</div>
                <div className="mt-2 text-sm text-slate-200">Collect consultant data</div>
              </div>
              <div className="rounded-[1.5rem] border border-white/10 bg-white/8 p-4 backdrop-blur-xl">
                <div className="text-2xl font-semibold">02</div>
                <div className="mt-2 text-sm text-slate-200">Build project packages</div>
              </div>
              <div className="rounded-[1.5rem] border border-white/10 bg-white/8 p-4 backdrop-blur-xl">
                <div className="text-2xl font-semibold">03</div>
                <div className="mt-2 text-sm text-slate-200">Create Visuals</div>
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: 'easeOut' }}
          className="flex justify-center lg:justify-end"
        >
          <LoginForm />
        </motion.div>
      </div>
    </main>
  )
}
