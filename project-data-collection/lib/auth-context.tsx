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

  // Tracks which user id we've already attempted claim_invite() for, so a
  // repeat onAuthStateChange firing (token refresh, tab focus) for the same
  // session never triggers a second RPC call or loops. Reset to null
  // whenever the session goes away, so the next sign-in gets a fresh
  // attempt.
  const claimAttemptedForUserRef = useRef<string | null>(null)

  const loadProfile = useCallback(
    async (session: Session | null) => {
      const requestId = ++requestIdRef.current

      if (!session) {
        claimAttemptedForUserRef.current = null
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

      if (error) {
        // Unexpected failure on the select itself (network, RLS misconfig,
        // etc). Fail closed rather than leaving loading stuck forever.
        setUser(null)
        setNoAccess(true)
        setLoading(false)
        return
      }

      if (data) {
        if (data.is_active === false) {
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
        return
      }

      // No profiles row. This is the shared-auth.users dead end: the user
      // may already exist in auth.users (created by the other app sharing
      // this Supabase project) and just never had a chance to call
      // claim_invite(), which normally only runs after sign-up or through
      // the email-confirmation callback. Try it once per session before
      // giving up.
      if (claimAttemptedForUserRef.current === session.user.id) {
        setUser(null)
        setNoAccess(true)
        setLoading(false)
        return
      }
      claimAttemptedForUserRef.current = session.user.id

      const { error: claimError } = await supabase.rpc('claim_invite')

      if (requestId !== requestIdRef.current) return

      if (claimError) {
        // 42501 is Postgres's "insufficient privilege" code, which
        // claim_invite raises deliberately when there's no matching
        // pending_invites row for this email. That's the allowlist
        // working as intended for a genuinely uninvited user, not a bug.
        // Any other error (network, RPC missing, etc.) is unexpected, but
        // either way we fail closed to noAccess rather than granting
        // access or leaving loading stuck forever.
        if (claimError.code !== '42501') {
          console.error('claim_invite failed in auth provider:', claimError)
        }
        setUser(null)
        setNoAccess(true)
        setLoading(false)
        return
      }

      const { data: claimedProfile, error: reloadError } = await supabase
        .from('profiles')
        .select('email, name, role, is_active')
        .eq('id', session.user.id)
        .maybeSingle()

      if (requestId !== requestIdRef.current) return

      if (reloadError || !claimedProfile || claimedProfile.is_active === false) {
        setUser(null)
        setNoAccess(true)
        setLoading(false)
        return
      }

      setUser({
        email: claimedProfile.email,
        role: claimedProfile.role as SafeUser['role'],
        name: claimedProfile.name,
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
