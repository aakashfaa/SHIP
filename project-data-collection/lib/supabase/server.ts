import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { ShipSupabaseClient } from './client'

/**
 * Server-side Supabase client, bound to the current request's cookies so that
 * RLS sees the signed-in user. Create a fresh one per request — never cache it
 * or share it across requests.
 *
 * As with the browser client, `db.schema` pins every query and RPC to the
 * `ship` schema.
 */
export async function createSupabaseServerClient(): Promise<ShipSupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error(
      'Supabase server client is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY in the environment (see .env.example).'
    )
  }

  // Next.js 16: `cookies()` is async. Synchronous access was removed entirely,
  // so `const cookieStore = cookies()` (as seen in most older guides) is wrong.
  const cookieStore = await cookies()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createServerClient<any, 'ship'>(url, anonKey, {
    db: { schema: 'ship' },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // `cookieStore.set()` throws when this client is constructed during a
          // Server Component render — writing cookies is only legal in Route
          // Handlers and Server Functions. Swallowing it is the documented
          // workaround; middleware refreshes the session instead.
        }
      },
    },
  })
}
