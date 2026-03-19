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
    <div className="w-full max-w-md rounded-[2rem] border border-white/50 bg-white/85 p-8 shadow-2xl backdrop-blur-xl">
      <div className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-gray-400">
          Project Data Collection
        </p>
        <h1 className="text-3xl font-semibold text-gray-900">Welcome back</h1>
        <p className="mt-2 text-sm text-gray-500">
          Sign in to access your projects and dashboards
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your email"
            className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
          />
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-2xl bg-black px-4 py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <div className="mt-4 rounded-2xl bg-gray-50 px-4 py-3 text-xs text-gray-500">
        Newly created consultant users can sign in with their consultant email and
        default password <span className="font-semibold">{getDefaultConsultantPassword()}</span>.
      </div>

      <div className="mt-6">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Demo users
        </p>

        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => handleDemoFill('admin')}
            className="rounded-2xl border border-gray-200 px-4 py-3 text-left text-sm hover:bg-gray-50"
          >
            Admin
          </button>
          <button
            type="button"
            onClick={() => handleDemoFill('consultant1')}
            className="rounded-2xl border border-gray-200 px-4 py-3 text-left text-sm hover:bg-gray-50"
          >
            Consultant 1
          </button>
          <button
            type="button"
            onClick={() => handleDemoFill('consultant2')}
            className="rounded-2xl border border-gray-200 px-4 py-3 text-left text-sm hover:bg-gray-50"
          >
            Consultant 2
          </button>
        </div>
      </div>
    </div>
  )
}