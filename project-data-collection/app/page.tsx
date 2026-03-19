'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import LoginForm from '@/components/LoginForm'
import { getCurrentUser } from '@/lib/auth'
import { SafeUser } from '@/lib/types'

export default function HomePage() {
  const router = useRouter()
  const [user] = useState<SafeUser | null>(() => getCurrentUser())

  useEffect(() => {
    if (user) {
      router.replace('/projects')
    }
  }, [user, router])

  if (user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_#f3f4f6,_#e5e7eb_45%,_#d1d5db)] px-4">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_#f3f4f6,_#e5e7eb_45%,_#d1d5db)] px-4">
      <LoginForm />
    </main>
  )
}