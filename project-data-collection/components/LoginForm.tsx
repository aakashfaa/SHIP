'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { loginUser } from '@/lib/auth'
import { getDefaultConsultantPassword } from '@/lib/store'

export default function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function handleDemoFill(type: 'admin' | 'consultant1' | 'consultant2') {
    if (type === 'admin') {
      setEmail('admin@gmail.com')
      setPassword('admin123')
    }
    if (type === 'consultant1') {
      setEmail('consultant1@gmail.com')
      setPassword('consultant123')
    }
    if (type === 'consultant2') {
      setEmail('consultant2@gmail.com')
      setPassword('consultant123')
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const user = loginUser(email, password)

    if (!user) {
      setError('Invalid email or password')
      setLoading(false)
      return
    }

    router.replace('/projects')
  }

  return (
    <div className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
      <div className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
          Project Data Collection
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
          Welcome back
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Sign in to access your project workspaces, line-item data, and package views.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your email"
            className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            className="w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
          />
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-900">
        Newly created consultant users can sign in with their consultant email and
        default password <span className="font-semibold">{getDefaultConsultantPassword()}</span>.
      </div>

      <div className="mt-6">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Demo users
        </p>

        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => handleDemoFill('admin')}
            className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-left text-sm text-slate-700 transition hover:-translate-y-[1px] hover:border-slate-300"
          >
            Admin
          </button>
          <button
            type="button"
            onClick={() => handleDemoFill('consultant1')}
            className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-left text-sm text-slate-700 transition hover:-translate-y-[1px] hover:border-slate-300"
          >
            Consultant 1
          </button>
          <button
            type="button"
            onClick={() => handleDemoFill('consultant2')}
            className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-left text-sm text-slate-700 transition hover:-translate-y-[1px] hover:border-slate-300"
          >
            Consultant 2
          </button>
        </div>
      </div>
    </div>
  )
}
