# SHIP database — `ship` schema

Everything SHIP needs lives in one Postgres schema, `ship`, on Supabase
project ref `gfopaidnirrtyvfmgqwi`.

> **This project ref is SHARED with an unrelated production project.**
> Read the ground rules below before touching anything in here.

---

## Ground rules for this database

These are not style preferences. Breaking any one of them can take down
the other project that shares this database.

| Rule | Why |
| --- | --- |
| Everything goes in schema `ship`. Nothing in `public`, `auth`, `storage`, `realtime`, `extensions`. | `public` is the other project's namespace. A name collision there is their outage. |
| **No `create extension`, ever.** | Extensions are database-wide, not schema-scoped. This is why emails are lowercase `text` + a `CHECK`, not `citext`. `gen_random_uuid()` is core in PG13+, so no `pgcrypto` is needed. |
| **Never create a trigger on `auth.users`.** | Such a trigger fires *inside the other project's signup transaction*. A bug in it — a typo, a missing row, a null — breaks their signups, not ours. SHIP isolation comes entirely from `ship.profiles` membership + RLS + `ship.claim_invite()`. |
| No `GRANT` outside `ship`. Grant to `authenticated` only; `anon` gets nothing. | SHIP has no anonymous surface, and `anon` is shared. |
| Never add a table to the `supabase_realtime` publication. | The publication is shared; adding to it changes the other project's replication stream. |
| Every file is wrapped in `begin; … commit;`. | A partially applied migration on a shared database is the worst possible state. |
| Never `alter table … force row level security` on a `ship` table. | The RLS helper functions are `SECURITY DEFINER` and depend on the owner bypassing RLS. `FORCE` reintroduces `42P17 infinite recursion detected in policy`. |

---

## Apply order

Strictly in order. Each file assumes the previous one has been applied.

| # | File | What it creates |
| --- | --- | --- |
| 1 | `migrations/0001_ship_schema.sql` | Schema `ship` + 11 tables + indexes. No grants, no policies — the schema is inert after this. |
| 2 | `migrations/0002_ship_rls.sql` | `grant usage on schema ship`, table/column grants, 7 `SECURITY DEFINER` RLS helpers, `enable row level security` on all 11 tables, all policies. |
| 3 | `migrations/0003_ship_numbering.sql` | `ship.discipline_prefix()`, the `normalize_line_item` / `fill_item_number` / `fill_chunk_number` trigger functions, and their triggers. |
| 4 | `migrations/0004_ship_rpcs.sql` | `ship.slugify()`, `ensure_invites()`, `create_project()`, `update_project()`, `claim_invite()`. |
| 5 | `seeds/001_seed.sql` | The `lib/mock-*.ts` fixtures + **the counter backfill**. |

### How to apply

**Supabase SQL editor** (simplest for a one-off): open each file, paste
the whole thing, run. Each is a single transaction, so a failure rolls
itself back and you can fix and re-run.

**Supabase CLI**, if the project is linked:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0001_ship_schema.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0002_ship_rls.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0003_ship_numbering.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0004_ship_rpcs.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/001_seed.sql
```

These files are intentionally **not** in `supabase/migrations/` in the
CLI's timestamped `<YYYYMMDDHHMMSS>_name.sql` format, because
`supabase db push` / `db reset` operate on the whole database and this
database is shared. Apply them deliberately, by hand.

All five must be run as the **owner / superuser** connection (the SQL
editor's `postgres` role, or the service-role connection string). RLS is
on and the seed writes to tables that `authenticated` cannot write.

### Re-runnability

Every file is safe to re-run:

- `create schema/table/index if not exists`
- `create or replace function`
- `drop policy if exists` + `create policy` (Postgres has no
  `create policy if not exists`)
- `drop trigger if exists` + `create trigger`
- `on conflict do nothing` / idempotent upserts in the seed

**One caveat:** because the tables use `create table if not exists`,
editing a column or a `CHECK` in `0001` will *not* take effect on a
database where `0001` already ran. Write a new `0005_*.sql` with the
`alter table` instead.

---

## Rollback

### Full rollback — remove SHIP entirely

Because every object is inside the `ship` schema, one statement undoes
all four migrations and the seed:

```sql
begin;
drop schema ship cascade;
commit;
```

This is safe on the shared database:

- It drops only `ship.*` — tables, functions, triggers, policies, and the
  grants attached to them.
- The only object pointing outside `ship` is the FK
  `ship.profiles.id → auth.users(id)`. That constraint lives *on
  `ship.profiles`*, so dropping the schema drops the constraint.
  **No `auth.users` row is touched** — dropping a referencing table never
  deletes referenced rows.
- Nothing was ever created in `public`, `storage` or the
  `supabase_realtime` publication, so there is nothing to clean up there.
- `grant usage on schema ship to authenticated` disappears with the
  schema. `authenticated` keeps no residual privilege.

Verify afterwards:

```sql
select nspname from pg_namespace where nspname = 'ship';          -- 0 rows
select count(*) from auth.users;                                  -- unchanged
```

### Partial rollback — undo one file at a time

Reverse order. Each block is a single transaction.

**Undo `seeds/001_seed.sql`** (leaves the schema in place, empties it):

```sql
begin;
delete from ship.chunk_project_items;
delete from ship.chunk_projects;
delete from ship.line_items;
delete from ship.project_timeline_settings;
delete from ship.item_number_counters;
delete from ship.chunk_number_counters;
delete from ship.project_members;
delete from ship.project_consultants;
delete from ship.projects;
delete from ship.pending_invites;
commit;
```

(`ship.profiles` is deliberately not in that list — it holds real signed-up
users, not seed data.)

**Undo `0004_ship_rpcs.sql`:**

```sql
begin;
drop function if exists ship.claim_invite();
drop function if exists ship.update_project(text, text, jsonb);
drop function if exists ship.create_project(text, jsonb);
drop function if exists ship.ensure_invites(text[], text);
drop function if exists ship.slugify(text);
commit;
```

**Undo `0003_ship_numbering.sql`:**

```sql
begin;
drop trigger  if exists chunk_projects_aa_fill_chunk_number on ship.chunk_projects;
drop trigger  if exists line_items_bb_fill_item_number      on ship.line_items;
drop trigger  if exists line_items_aa_normalize             on ship.line_items;
drop function if exists ship.fill_chunk_number();
drop function if exists ship.fill_item_number();
drop function if exists ship.normalize_line_item();
drop function if exists ship.discipline_prefix(text);
commit;
```

After this, `line_items.item_number` and `chunk_projects.chunk_number` are
no longer auto-assigned — the client must supply them or every insert
collides on `''` via the `unique (project_id, item_number)` constraint.

**Undo `0002_ship_rls.sql`:**

```sql
begin;

drop policy if exists profiles_select                    on ship.profiles;
drop policy if exists profiles_update_self               on ship.profiles;
drop policy if exists profiles_admin_all                 on ship.profiles;
drop policy if exists projects_select                    on ship.projects;
drop policy if exists projects_admin_all                 on ship.projects;
drop policy if exists project_consultants_select         on ship.project_consultants;
drop policy if exists project_consultants_admin_all      on ship.project_consultants;
drop policy if exists project_members_select             on ship.project_members;
drop policy if exists project_members_admin_all          on ship.project_members;
drop policy if exists line_items_select                  on ship.line_items;
drop policy if exists line_items_insert                  on ship.line_items;
drop policy if exists line_items_update                  on ship.line_items;
drop policy if exists line_items_delete                  on ship.line_items;
drop policy if exists chunk_projects_select              on ship.chunk_projects;
drop policy if exists chunk_projects_write               on ship.chunk_projects;
drop policy if exists chunk_project_items_select         on ship.chunk_project_items;
drop policy if exists chunk_project_items_write          on ship.chunk_project_items;
drop policy if exists project_timeline_settings_select   on ship.project_timeline_settings;
drop policy if exists project_timeline_settings_write    on ship.project_timeline_settings;

revoke all on all tables in schema ship from authenticated;
revoke usage on schema ship from authenticated;

drop function if exists ship.can_access_chunk(uuid);
drop function if exists ship.can_read_project(text);
drop function if exists ship.is_member(text);
drop function if exists ship.is_admin();
drop function if exists ship.is_active_user();
drop function if exists ship.current_email();
drop function if exists ship.current_uid();

commit;
```

> Do **not** drop the helper functions while the policies still reference
> them — Postgres will refuse, which is the correct order-of-operations
> guard. Drop policies first, as above.

**Undo `0001_ship_schema.sql`:** that is the full `drop schema ship cascade`
above.

---

## What lives where

### Tables (11, all in `ship`)

| Table | Purpose |
| --- | --- |
| `profiles` | SHIP membership. A row here is what makes an `auth.users` row a SHIP user. Created only by `claim_invite()`. |
| `projects` | `id` is the slug (`federal-campus-master-plan`). |
| `project_consultants` | One row per discipline per project, with `org_name`. |
| `project_members` | `(project_id, email, consultant_type)`. Replaces **both** `consultants[].emails` and the derived `assignedUsers`. Every RLS read passes through it. |
| `line_items` | The 29 `LineItem` fields + `updated_at`. |
| `chunk_projects` | Chunk / package projects. `timeline_segments` is jsonb. |
| `chunk_project_items` | Real child table (was the `itemLinks` array). Its `on delete cascade` fixes the orphaned-link bug in `deleteLineItem()`. |
| `project_timeline_settings` | Per-project timeline config. Column is **`interval_unit`**, not `interval` (reserved type name); the TS field stays `interval` and the mapper renames it. |
| `item_number_counters` | Race-safe `(project_id, discipline) → next A1/M2/HP3`. No client grants. |
| `chunk_number_counters` | Race-safe `project_id → next PP10`. No client grants. |
| `pending_invites` | The allowlist gating who may become a SHIP user. No client grants. |

### RPCs

| Function | Gate | Replaces |
| --- | --- | --- |
| `ship.ensure_invites(text[], text)` | admin | `ensureConsultantUsers()` |
| `ship.create_project(text, jsonb)` | admin | `createProject()` |
| `ship.update_project(text, text, jsonb)` | admin | `updateProject()` / SettingsTab save |
| `ship.claim_invite()` | any signed-in user | *(new)* the signup gate |

---

## How a user becomes a SHIP user

There is no `auth.users` trigger, so signing up is not enough:

1. An admin lists an email on a project (`create_project` / `update_project`),
   which calls `ensure_invites()` and adds it to `ship.pending_invites`.
2. The person signs up through normal Supabase auth. At this point they
   have an `auth.users` row and **nothing else** — every RLS helper
   returns false and they see zero rows.
3. The client calls `supabase.rpc('claim_invite')` once after sign-in.
   - Email is on the allowlist → a `ship.profiles` row is created with the
     invited role and `accepted_at` is stamped. They are now a SHIP user.
   - Email is not on the allowlist → `42501`. Sign them out and show
     "you have not been invited".

A user of the **other** project on this database who signs in falls into
that second case and gets nothing. That is the entire isolation
mechanism, and it needs no code in their signup path.

### The isolation is one-way — read `PREFLIGHT.md`

Everything above protects **SHIP data from their users**. It does *not*
protect **their data from SHIP users**, and nothing in these migrations
can, because the exposure is on their side of the database:

- Their project has an `AFTER INSERT` trigger `on_auth_user_created` on
  `auth.users`. Every SHIP signup therefore also materialises a row in
  *their* `public.profiles`.
- Most of their `public` tables carry `USING (true)` policies for
  `authenticated`, so any authenticated user of this database can read
  them over PostgREST.

Consequence: **do not invite real SHIP users onto this project ref until
that is resolved** with the other project's owner (scope their trigger,
tighten their policies, or give SHIP its own Supabase project). Applying
migrations `0001`–`0004` is safe and additive today; onboarding users is
a separate decision. See `PREFLIGHT.md` in this directory for the full
audit and evidence.

---

## Verifying RLS

The SQL editor runs as a superuser and bypasses RLS entirely, so a query
that "works" there proves nothing. `0002_ship_rls.sql` ends with a
commented-out impersonation block — copy it out, uncomment, and run.
The shape is:

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims =
    '{"sub":"<auth.users id>","email":"<their email>","role":"authenticated"}';
  -- ... queries under that identity ...
rollback;
```

Always inside `begin; … rollback;` with `set local`, so the impersonation
cannot leak into the next statement you run.

---

## Gotchas worth knowing before you edit

- **Trigger names `line_items_aa_normalize` / `line_items_bb_fill_item_number`
  are ugly on purpose.** Postgres fires BEFORE-row triggers in *alphabetical
  name order*. Numbering reads `discipline`; normalisation is what fills
  `discipline` in. Rename either and every item inserted without an explicit
  discipline gets numbered `AD<n>`.
- **Counter semantics:** `next_value` is the *next* number to hand out
  (hence the defaults of 1 and 10). Any backfill must be
  `max(existing) + 1`, not `max(existing)`.
- **If you seed line items or chunks by hand with explicit numbers, you
  must re-run section 9 of `seeds/001_seed.sql`.** Explicit numbers
  short-circuit the triggers, so the counters do not advance, and the next
  real insert dies on `23505 duplicate key … line_items_project_id_item_number_key`.
  Section 9 uses `greatest(...)`, so it is always safe to re-run.
- **Admins cannot change roles over PostgREST.** `authenticated` holds only
  `update (name)` on `ship.profiles`, which is what stops self-escalation.
  Role changes are a service-role / SQL-editor operation. To change that,
  widen the grant in `0002` — the `profiles_admin_all` policy already
  permits it.
- **Chunking is writable by any project member, not just admins.**
  Consultants are routed to the Chunking and Timeline tabs, so an
  admin-only write policy would give them a UI that silently fails.
  `0002` marks the three policies to flip if that should change.
