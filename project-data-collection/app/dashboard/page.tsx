'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import DashboardShell from '@/components/DashboardShell'
import { getCurrentUser } from '@/lib/auth'

type User = {
  name: string
  email: string
  role: string
}

export default function DashboardPage() {
  const router = useRouter()

  const [user] = useState<User | null>(() => getCurrentUser())

  useEffect(() => {
    if (!user) {
      router.replace('/')
    }
  }, [user, router])

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">Redirecting...</p>
      </main>
    )
  }

  return <DashboardShell user={user} />
}