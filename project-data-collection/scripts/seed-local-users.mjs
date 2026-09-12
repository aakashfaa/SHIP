/**
 * Creates sign-in-able auth users against the LOCAL Supabase stack.
 *
 * `supabase db reset` re-applies migrations and `supabase/seeds/*.sql`, which
 * repopulate `ship.pending_invites` — but invites are only an *allowlist*.
 * Nobody can actually sign in until an `auth.users` row exists, and seeding
 * `auth.users` from SQL means hand-rolling bcrypt hashes and identity rows.
 * Going through GoTrue's admin API instead lets the auth service own its own
 * schema, which is the whole reason this is a script and not another seed file.
 *
 * The matching `ship.profiles` row is NOT created here. It is minted by
 * `ship.claim_invite()` on first sign-in, which is the real production path —
 * so running the app against this seed exercises the invite gate for real
 * rather than routing around it.
 *
 * REFUSES TO RUN against anything but localhost. These passwords are trivial
 * and the emails are seed fixtures; pointing this at a hosted project would
 * create real accounts with a known password.
 *
 *   node scripts/seed-local-users.mjs
 */

const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:55421'
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const PASSWORD = 'localdev123'

/**
 * Emails must exist in `ship.pending_invites` (see supabase/seeds/001_seed.sql)
 * or the user signs in successfully and then lands on /no-access.
 *
 * One account per PROJECT ROLE (migration 0009), because the four roles are
 * the thing most worth exercising by hand and they are indistinguishable
 * without signing in as each. The role each of these resolves to comes from
 * `ship.project_roles`, seeded in 001_seed.sql -- check there before assuming
 * the notes below are still accurate.
 */
const USERS = [
  { email: 'admin@gmail.com', note: 'PROJECT ADMIN + platform admin' },
  { email: 'planning@atlasmech.com', note: 'EDITOR on federal-campus-master-plan' },
  { email: 'consultant1@gmail.com', note: 'CONSULTANT on federal-campus-master-plan' },
  { email: 'electrical@voltworks.com', note: 'VIEWER on federal-campus-master-plan' },
]

function assertLocal(url) {
  const { hostname } = new URL(url)
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(
      `Refusing to run against "${url}". This script only targets the local ` +
        `Supabase stack; it creates accounts with a hardcoded password.`
    )
  }
}

async function createUser(email) {
  const res = await fetch(`${API}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })

  if (res.ok) return 'created'

  const body = await res.json().catch(() => ({}))
  // GoTrue returns 422 email_exists on re-run; that is success for our purposes.
  if (res.status === 422 || /already been registered|email_exists/i.test(JSON.stringify(body))) {
    return 'exists'
  }
  throw new Error(`${email}: HTTP ${res.status} ${JSON.stringify(body)}`)
}

assertLocal(API)

console.log(`Seeding local users against ${API}\n`)
for (const { email, note } of USERS) {
  const status = await createUser(email)
  console.log(`  ${status.padEnd(8)} ${email.padEnd(24)} ${note}`)
}
console.log(`\nPassword for all of the above: ${PASSWORD}`)
console.log(`Emails (invites, magic links) are captured by Mailpit, not sent.`)
