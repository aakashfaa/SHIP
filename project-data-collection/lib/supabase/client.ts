import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Browser-side Supabase client.
 *
 * The `db.schema` option is set here, once, so every `.from()` / `.rpc()` call
 * in `lib/store.ts` targets the dedicated `ship` schema without having to chain
 * `.schema('ship')` at ~30 call sites. PostgREST reads it from the
 * `Accept-Profile` (reads) / `Content-Profile` (writes, including RPC) headers,
 * which supabase-js derives from this option.
 */

/** A `SupabaseClient` whose default schema is `ship` rather than `public`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ShipSupabaseClient = SupabaseClient<any, 'ship'>

let browserClient: ShipSupabaseClient | null = null

function missingEnvError(): Error {
  return new Error(
    'Supabase browser client is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see .env.example), then restart ' +
      '`npm run dev` — Next.js only inlines NEXT_PUBLIC_* variables at build/dev start.'
  )
}

export function getSupabaseBrowserClient(): ShipSupabaseClient {
  if (browserClient) return browserClient

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Thrown at call time rather than module load so that importing this module
  // never breaks a build or a page that does not actually hit the database.
  if (!url || !anonKey) throw missingEnvError()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createBrowserClient<any, 'ship'>(url, anonKey, {
    db: { schema: 'ship' },
  })

  browserClient = client
  return client
}
