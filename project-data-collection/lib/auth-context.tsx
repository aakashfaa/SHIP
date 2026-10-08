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
  /**
   * The user HAS a ship.profiles row, but an admin turned it off
   * (`is_active = false`). Always paired with `noAccess = true`; /no-access
   * uses it to say "your access was turned off" instead of "ask to be added",
   * and to hide "Check again", which can never help them (UX-13 / M-31).
   */
  deactivated: boolean
  /**
   * Signed in, but the email address isn't confirmed yet, so claim_invite
   * (0013) refuses with hint `email_not_confirmed`. /no-access shows "confirm
   * your email first" with a resend button instead of "ask to be added".
   */
  unconfirmed: boolean
  /** Signs out and always ends on the sign-in page (full navigation). */
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [noAccess, setNoAccess] = useState(false)
  const [deactivated, setDeactivated] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
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
        setDeactivated(false)
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('email, name, role, is_active')
        .eq('id', session.user.id)
        .maybeSingle()

      if (requestId !== requestIdRef.current) return
      setDeactivated(false)

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
          setDeactivated(true)
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
        setUnconfirmed(
          claimError.hint === 'email_not_confirmed' || !session.user.email_confirmed_at
        )
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
        setDeactivated(claimedProfile?.is_active === false)
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

  // Always ends on `/` with a full navigation. Callers used to be responsible
  // for navigating afterwards, and /no-access forgot to, so its "Sign out"
  // button cleared the session but left the page exactly as it was (UX-3 /
  // M-31). A full navigation (not router.replace) also drops every piece of
  // in-memory state from the previous user. A failed network sign-out still
  // clears the local session (`scope: 'local'` fallback) so the user is never
  // stuck signed in.
  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) await supabase.auth.signOut({ scope: 'local' })
    setUser(null)
    setNoAccess(false)
    setDeactivated(false)
    setUnconfirmed(false)
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload is deliberate: it drops every bit of the previous user's in-memory state
    window.location.assign('/')
  }, [supabase])

  return (
    <AuthContext.Provider value={{ user, loading, noAccess, deactivated, unconfirmed, signOut }}>
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
