import 'server-only'

import { createClient } from '@supabase/supabase-js'
import type { ShipSupabaseClient } from './client'

/**
 * Service-role Supabase client. This BYPASSES Row Level Security entirely.
 *
 * SECURITY:
 * - `SUPABASE_SERVICE_ROLE_KEY` must NEVER be prefixed `NEXT_PUBLIC_`. Anything
 *   with that prefix is inlined into the client bundle and is public forever.
 * - This module must only ever be imported from a route handler under
 *   `app/api/` (an `app/api/<name>/route.ts` file). It is never safe in a
 *   Client Component, and pointless in a Server Component that should run as
 *   the signed-in user — use `lib/supabase/server.ts` for that. The
 *   `server-only` import above turns an accidental client import into a build
 *   error rather than a leaked key.
 * - Every route handler using this client is responsible for its own authz
 *   check; RLS will not do it for you here.
 */
export function getSupabaseAdminClient(): ShipSupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase admin client is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY in the server environment (see .env.example). ' +
        'SUPABASE_SERVICE_ROLE_KEY must not be exposed with a NEXT_PUBLIC_ prefix.'
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createClient<any, 'ship'>(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: { schema: 'ship' },
  })
}
