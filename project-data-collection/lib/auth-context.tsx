'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { SafeUser } from '@/lib/types'

type AuthContextValue = {
  user: SafeUser | null
  loading: boolean
  noAccess: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [noAccess, setNoAccess] = useState(false)
  const supabase = getSupabaseBrowserClient()

  // Guards against a stale async profile lookup clobbering state when the
  // session changes again before the previous lookup resolves.
  const requestIdRef = useRef(0)

  const loadProfile = useCallback(
    async (session: Session | null) => {
      const requestId = ++requestIdRef.current

      if (!session) {
        if (requestId !== requestIdRef.current) return
        setUser(null)
        setNoAccess(false)
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('email, name, role, is_active')
        .eq('id', session.user.id)
        .maybeSingle()

      if (requestId !== requestIdRef.current) return

      if (error || !data || data.is_active === false) {
        setUser(null)
        setNoAccess(true)
        setLoading(false)
        return
      }

      setUser({
        email: data.email,
        role: data.role as SafeUser['role'],
        name: data.name,
      })
      setNoAccess(false)
      setLoading(false)
    },
    [supabase]
  )

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      void loadProfile(data.session)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void loadProfile(session)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [supabase, loadProfile])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setUser(null)
    setNoAccess(false)
  }, [supabase])

  return (
    <AuthContext.Provider value={{ user, loading, noAccess, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
