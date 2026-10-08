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
| 5 | `migrations/0005_ship_function_grants.sql` | Tidy-up only: revokes the stray `PUBLIC`/`anon`/`authenticated` EXECUTE grant Postgres defaults onto `fill_item_number()` / `fill_chunk_number()` / `normalize_line_item()`. No new object, no behaviour change (see the Gotchas note below on why it's inert). |
| 6 | `migrations/0006_ship_cost_and_energy.sql` | `project_cost_settings`, `escalation_rate_overrides`, `project_energy_settings`; `line_items.ecc_amount`/`annual_energy_savings`/`annual_cost_savings`/`energy_notes`; `ship.parse_cost_input()` + the `line_items_cc_sync_ecc` trigger; `project_timeline_settings` calendar-anchor columns. |
| 7 | `migrations/0007_ship_phases.sql` | `phase_templates`, `phase_template_steps`, `chunk_phases`, `phase_dependencies` — the sub-task level under a package — plus 3 built-in templates, cycle-detection and cross-project-link triggers, and `project_cost_settings.default_phase_template_id`. |
| 8 | `migrations/0008_ship_taxonomies.sql` | `project_taxonomy_values`; `default_taxonomy_rows()` / `seed_default_taxonomy()` / `taxonomy_value_allowed()`; the `check_line_item_taxonomy` trigger; **drops** the 4 hardcoded CHECK constraints on `line_items`. |
| 9 | `migrations/0009_ship_roles_and_suggestions.sql` | `project_roles`, `suggestions`; `project_role()` and the whole authority-helper family; **rewrites the entire policy surface** created by 0002/0006/0007/0008 from `FOR ALL` to one policy per command. The biggest, most security-sensitive file in the set — read its header before touching anything downstream of it. |
| 10 | `migrations/0010_ship_scenarios.sql` | `scenarios`; `baseline_fingerprint()` / `create_scenario()` / `publish_scenario()` / `rebase_scenario()` — the what-if sandbox. |
| 11 | `migrations/0011_ship_scenario_authority.sql` | Closes a privilege-escalation bug: tightens `create_scenario()` to `can_contribute_project()` and `publish_scenario()` to `can_edit_project()` (0010 shipped both checking only `can_read_project()`, which a `viewer` also satisfies). |
| 12 | `migrations/0012_ship_form_builder.sql` | `form_fields`, `form_field_options`; the line-item form becomes per-project data. |
| 13 | `migrations/0013_access_hardening.sql` | Roster removal revokes `project_roles`; `update_project()` lets a project admin manage their own project and refuses stale saves (40001); `claim_invite()` needs a confirmed email and is idempotent; `pending_invites.project_id` + a guard so only a platform admin can mint a platform-admin invite; `project_access_notices`; `grant usage on schema ship to service_role` (the invite route's writes could never have worked without it). |
| 14 | `migrations/0014_line_item_integrity.sql` | System columns immutable for non-platform-admins (`42501 "<column> can't be changed"`), `project_id` for everyone; `chunk_project_items` same-project trigger (**deletes existing cross-project links**); numbering skips taken numbers; `annual_energy_savings` / `annual_cost_savings` and built-in dropdowns nullable, default NULL. |
| 15 | `migrations/0015_scenario_hardening.sql` | `scenarios.base_payload`; three-way `rebase_scenario()`; `save_scenario_payload()`; owner may update only `name`/`description`/`visibility`; `publish_scenario()` needs the owner or a shared what-if and writes only changed rows. |
| 16 | `migrations/0016_form_builder_hardening.sql` | Only the seeder creates built-in / column-backed fields; column keys allow-listed (**deletes forged rows**); `guard_form_field` lets a whole-project delete cascade. |
| 17 | `migrations/0017_bulk_write_rpcs.sql` | `reorder_form_fields()` / `reorder_field_options()`. |
| 18 | `migrations/0018_project_lifecycle.sql` | `create_project()` also creates cost and energy settings rows and fixes the start year; backfills existing projects from `created_at`; then `NOT NULL`. |
| 19 | `migrations/0019_cost_parser.sql` | Strict `parse_cost_input()` (matches `lib/costs.ts`, 76 parity cases) and **recomputes every `ecc_amount`**: legacy text it cannot read becomes NULL and is flagged. |
| 20 | `migrations/0020_canonical_time_unit.sql` | **Converts every stored schedule position to months, in place.** `ship.schema_conversions` (run-once marker), `ship.time_unit_conversion_log` (the factor per project). See the warning below. |
| 21 | `seeds/001_seed.sql` | The `lib/mock-*.ts` fixtures + **the counter backfill**. |
| 22 | `seeds/002_v2_phases.sql` | Fixture cost/energy settings, phases (in months) and phase dependencies for the v2 Timeline demo. Exists because the CLI applies migrations before seeds, so 0007's own backfill is a no-op on a fresh database — see Gotchas. |
| 23 | `seeds/003_v2_taxonomy.sql` | Fixture taxonomy rows for all seeded projects, for the same reason 002 exists: 0008's backfill has nothing to join against on a fresh database. |
| 24 | `seeds/004_v2_form.sql` | Fixture line-item forms, for the same reason: 0012's backfill has no projects on a fresh database. |
| 25 | `seeds/005_project_settings.sql` | Cost and energy settings rows for every seeded project, for the same reason: 0018's backfill has no projects on a fresh database. |

> **Take a snapshot of the hosted database before applying 0020.** It
> rewrites `chunk_phases.start_slot` / `duration_slots`,
> `phase_dependencies.lag_slots`, `phase_template_steps.default_duration_slots`
> and the phases inside `scenarios.payload` / `base_payload` in place,
> multiplying each project's values by the months-per-slot of the zoom it was
> being priced at (5-year 60, 3-year 36, Year 12, Quarter 3, Month 1; built-in
> templates 12). The column names keep the word "slots" but hold months
> afterwards. It runs once (a `schema_conversions` row guards it), so
> re-running it is a no-op — but a half-understood restore is not, which is
> why the snapshot is the real rollback. The app code from the same commit
> reads months; do not deploy that code before 0020, or 0020 without that
> code.

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
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0005_ship_function_grants.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0006_ship_cost_and_energy.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0007_ship_phases.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0008_ship_taxonomies.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0009_ship_roles_and_suggestions.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0010_ship_scenarios.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0011_ship_scenario_authority.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0012_ship_form_builder.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0013_access_hardening.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0014_line_item_integrity.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0015_scenario_hardening.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0016_form_builder_hardening.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0017_bulk_write_rpcs.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0018_project_lifecycle.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0019_cost_parser.sql
# Snapshot first (see the warning above).
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0020_canonical_time_unit.sql
# Seeds are fixtures: local/dev databases only, never the hosted project.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/001_seed.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/002_v2_phases.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/003_v2_taxonomy.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/004_v2_form.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/005_project_settings.sql
```

After 0013 (and after any migration that adds a function or column the app
calls), reload PostgREST's schema cache — `notify pgrst, 'reload schema';` —
or the new RPCs answer 404. `PREFLIGHT.md` §7 lists the hosted auth settings
0013 and the email work depend on.

These files are intentionally **not** in `supabase/migrations/` in the
CLI's timestamped `<YYYYMMDDHHMMSS>_name.sql` format, because
`supabase db push` / `db reset` operate on the whole database and this
database is shared. Apply them deliberately, by hand.

> `0006` through `0020` are developed and applied against the **local**
> Docker stack only (`supabase/LOCAL-DEV.md`). Each says so in its own
> header. They have not been applied to the remote project
> (`gfopaidnirrtyvfmgqwi`) and must not be until that is a separate,
> deliberate call — same shared-database caution as everything else here.

All of these must be run as the **owner / superuser** connection (the SQL
editor's `postgres` role, or the service-role connection string). RLS is
on and the seeds write to tables that `authenticated` cannot write.

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
database where `0001` already ran. Write a new `0012_*.sql` with the
`alter table` instead — exactly what `0006`/`0007`/`0008` did to
`line_items` and `project_timeline_settings`.

---

## Rollback

### Full rollback — remove SHIP entirely

Because every object is inside the `ship` schema, one statement undoes
all eleven migrations and all three seeds:

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

**0013–0020 are forward-only fixes.** Most of them `create or replace` a
function that an earlier file defined, and the "undo" for those is to re-run
the earlier file — which puts back the hole the audit found (a removed
consultant keeping access, a viewer's rebase reading the live plan, the
lenient cost parser). Several also change data in ways no script can
reverse. Restore from the pre-0020 snapshot rather than unpicking them. What
each one leaves behind if you do need to know:

| File | Not reversible by SQL | Objects it adds |
| --- | --- | --- |
| 0020 | Every schedule value was multiplied by a factor. Reverse by hand, per project, by dividing by `time_unit_conversion_log.months_per_slot` (built-in templates: 12) — tables *and* scenario payloads — then delete the `schema_conversions` row. Only do this together with the pre-0020 app code. | `schema_conversions`, `time_unit_conversion_log` |
| 0019 | Every `ecc_amount` was recomputed; unreadable text is now NULL. Re-running 0006's parser recomputes them the old (wrong) way. | — |
| 0018 | Backfilled settings rows and start years; `NOT NULL` on the start year. | — |
| 0017 | — | `reorder_form_fields`, `reorder_field_options` (drop to undo; the up/down arrows then fail again) |
| 0016 | Deleted forged built-in / column-backed `form_fields` rows. | `check_form_field_column_key` + trigger |
| 0015 | — (`base_payload` is a new column, default `'{}'`) | `save_scenario_payload`, `schedule_snapshot`, `schedule_fingerprint`, `touch_scenario_updated_at` + trigger |
| 0014 | Deleted cross-project `chunk_project_items` links; savings that were 0 stay 0, new blanks are NULL. | `guard_line_item_system_columns`, `check_chunk_item_same_project` + triggers |
| 0013 | Revoked `project_roles` rows for people already off a roster. | `project_access_notices`, `pending_invites.project_id`, `guard_pending_invite_role` + trigger, `uid_is_platform_admin`, service-role grants |

**Undo `seeds/003_v2_taxonomy.sql`:**

```sql
begin;
delete from ship.project_taxonomy_values;
commit;
```

**Undo `seeds/002_v2_phases.sql`:**

```sql
begin;
delete from ship.phase_dependencies;
delete from ship.chunk_phases;
delete from ship.escalation_rate_overrides;
delete from ship.project_energy_settings;
delete from ship.project_cost_settings;
-- This seed also inserts fixture ship.project_roles rows and UPDATEs
-- project_timeline_settings / line_items columns in place. The role rows
-- are covered by the seeds/001 delete below (project_roles has no
-- dedicated seed of its own); the UPDATEs have no "undo" short of
-- restoring from the seeds/001 baseline, since they modify existing rows
-- rather than adding new ones.
commit;
```

**Undo `seeds/001_seed.sql`** (leaves the schema in place, empties it):

```sql
begin;
delete from ship.suggestions;
delete from ship.scenarios;
delete from ship.project_roles;
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
users, not seed data. `project_taxonomy_values` and the 0006/0007 settings
tables are already empty at this point if you undid `002`/`003` first;
`delete from ship.projects` would cascade them anyway via `on delete
cascade`.)

**Undo `0011_ship_scenario_authority.sql`:**

There is nothing to run. This migration only replaces the *bodies* of
`create_scenario()`/`publish_scenario()` in place (`create or replace
function`); it added no object. Reverting to 0010's versions is possible
but not offered here, because 0010's versions are the privilege-escalation
bug this file exists to close — see its header. Undo `0010` instead, which
removes both functions entirely.

**Undo `0010_ship_scenarios.sql`:**

```sql
begin;
drop function if exists ship.rebase_scenario(uuid);
drop function if exists ship.publish_scenario(uuid);
drop function if exists ship.create_scenario(text, text, text);
drop function if exists ship.baseline_fingerprint(text);
drop table    if exists ship.scenarios;
commit;
```

Nothing outside `ship.scenarios` is touched by `0010`/`0011`, so this
cannot lose baseline schedule data.

**Undo `0009_ship_roles_and_suggestions.sql`:**

This is the largest rollback in the set — it drops 2 tables, ~20
functions, and replaces every policy 0009 wrote with the 0002/0006/0007/
0008 policies it superseded. Don't hand-roll it: copy the full commented
`ROLLBACK` block at the bottom of
`migrations/0009_ship_roles_and_suggestions.sql` verbatim — it restores
`ship.can_read_project()` to its pre-0009 definition, re-creates every
`FOR ALL` policy 0009 replaced, and only then drops 0009's functions and
tables, in that order (Postgres refuses to drop a function a live policy
still references). It does **not** restore data: dropping
`ship.project_roles` discards every role ever granted, and dropping
`ship.suggestions` discards the review history. Back both up first if
either matters:

```sql
create table ship._project_roles_backup as select * from ship.project_roles;
create table ship._suggestions_backup   as select * from ship.suggestions;
```

**Undo `0008_ship_taxonomies.sql`:**

```sql
begin;
drop policy if exists project_taxonomy_values_select on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_insert on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_update on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_delete on ship.project_taxonomy_values;

drop trigger  if exists line_items_dd_check_taxonomy on ship.line_items;
drop function if exists ship.check_line_item_taxonomy();
drop function if exists ship.taxonomy_value_allowed(text, text, text);
drop function if exists ship.seed_default_taxonomy(text);
drop function if exists ship.default_taxonomy_rows();

drop table if exists ship.project_taxonomy_values;

-- Restoring the 4 original CHECK constraints is safe ONLY if no row has
-- taken on a value outside the original hardcoded lists since 0008 was
-- applied. Verify first (repeat for all 4 columns) — see the full
-- statements in this migration's own ROLLBACK comment:
--   select distinct building_area_impacted from ship.line_items
--    where building_area_impacted not in
--      ('WHOLE BUILDING','ANNEX','WEST WING','EAST WING','BULFINCH','SITE','OTHER *');
commit;
```

**Undo `0007_ship_phases.sql`:**

```sql
begin;
drop trigger  if exists phase_dependencies_zz_no_cycle     on ship.phase_dependencies;
drop trigger  if exists phase_dependencies_aa_sync_project on ship.phase_dependencies;
drop table    if exists ship.phase_dependencies;
drop table    if exists ship.chunk_phases;
drop table    if exists ship.phase_template_steps;
alter table ship.project_cost_settings drop column if exists default_phase_template_id;
drop table    if exists ship.phase_templates;
drop function if exists ship.assert_no_dependency_cycle();
drop function if exists ship.sync_phase_dependency_project();
drop function if exists ship.can_access_phase(uuid);
drop function if exists ship.phase_project_id(uuid);
commit;
```

`chunk_projects.timeline_segments` was never modified by `0007`, so v1's
timeline keeps working after this rollback.

**Undo `0006_ship_cost_and_energy.sql`:**

```sql
begin;
drop table if exists ship.escalation_rate_overrides;
drop table if exists ship.project_energy_settings;
drop table if exists ship.project_cost_settings;

drop trigger  if exists line_items_cc_sync_ecc on ship.line_items;
drop function if exists ship.sync_line_item_ecc();

alter table ship.line_items
  drop column if exists ecc_amount,
  drop column if exists annual_energy_savings,
  drop column if exists annual_cost_savings,
  drop column if exists energy_notes;

alter table ship.project_timeline_settings
  drop constraint if exists project_timeline_settings_fy_month_ck,
  drop constraint if exists project_timeline_settings_fy_labels_ck,
  drop column     if exists start_calendar_year,
  drop column     if exists fiscal_year_start_month,
  drop column     if exists fiscal_year_labels_by;

drop function if exists ship.parse_cost_input(text);
commit;
```

**Undo `0005_ship_function_grants.sql`:**

Nothing to drop — this migration only `revoke`s a stray default `PUBLIC`
EXECUTE grant on three trigger functions. "Undoing" it would mean
re-granting `PUBLIC`/`anon`/`authenticated` EXECUTE on
`ship.fill_item_number()` / `ship.fill_chunk_number()` /
`ship.normalize_line_item()`. Don't — that grant was the inconsistency
this migration closed, not a feature to restore.

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

### Tables (27, all in `ship`)

#### v1 (0001) — 11 tables

| Table | Purpose |
| --- | --- |
| `profiles` | SHIP membership. A row here is what makes an `auth.users` row a SHIP user. Created only by `claim_invite()`. |
| `projects` | `id` is the slug (`federal-campus-master-plan`). |
| `project_consultants` | One row per discipline per project, with `org_name`. |
| `project_members` | `(project_id, email, consultant_type)`. Replaces **both** `consultants[].emails` and the derived `assignedUsers`. Every RLS read passes through it. |
| `line_items` | The 29 `LineItem` fields + `updated_at` (v1) + the 0006 cost/energy columns (v2). |
| `chunk_projects` | Chunk / package projects. `timeline_segments` is jsonb, unused by new code since 0007 but kept for backward compat. |
| `chunk_project_items` | Real child table (was the `itemLinks` array). Its `on delete cascade` fixes the orphaned-link bug in `deleteLineItem()`. |
| `project_timeline_settings` | Per-project timeline config. Column is **`interval_unit`**, not `interval` (reserved type name); the TS field stays `interval` and the mapper renames it. Gained calendar-anchor columns in 0006. |
| `item_number_counters` | Race-safe `(project_id, discipline) → next A1/M2/HP3`. No client grants. |
| `chunk_number_counters` | Race-safe `project_id → next PP10`. No client grants. |
| `pending_invites` | The allowlist gating who may become a SHIP user. No client grants. |

#### v2 (0006–0010) — 11 more tables

| Table | Added by | Purpose |
| --- | --- | --- |
| `project_cost_settings` | 0006 | Per-project TPC factor + escalation curve. One row per project, defaults if absent. |
| `escalation_rate_overrides` | 0006 | Per-year escalation-rate pins, keyed by `year_offset` from `base_year`. |
| `project_energy_settings` | 0006 | Per-project energy unit label, baseline, and the interactive-effects de-rate. |
| `phase_templates` | 0007 | Named phase taxonomies. `project_id is null` = built-in (readable by everyone, writable by nobody over the API). |
| `phase_template_steps` | 0007 | The ordered steps of a template — a starting point copied into `chunk_phases`, then edited freely. |
| `chunk_phases` | 0007 | THE sub-task level: a package's phases, each with its own `pct_of_tpc`, timeline slot, and duration-lock flag. |
| `phase_dependencies` | 0007 | FS/SS/FF/SF links between phases, with a `lag_slots` (may be negative — a lead). |
| `project_taxonomy_values` | 0008 | Per-project dropdown vocabulary for the 4 taxonomy-constrained `line_items` columns. |
| `project_roles` | 0009 | Per-project authority: `(project_id, email) → admin/editor/consultant/viewer`. Keyed on email, like `project_members`, for the same reason. |
| `suggestions` | 0009 | A proposed patch to someone else's `line_items` row. Applied only by `apply_suggestion()`, never by a direct UPDATE. |
| `scenarios` | 0010 | A branched, in-jsonb copy of a project's schedule (what-if sandbox). Published back or discarded; never a `scenario_id` column on the live tables — see the 0010 header for why. |

#### Later (0012–0020) — 5 more tables

| Table | Added by | Purpose |
| --- | --- | --- |
| `form_fields` | 0012 | The per-project line-item form: built-in (column-backed) and custom fields, in order. |
| `form_field_options` | 0012 | Dropdown options for a form field, in order. |
| `project_access_notices` | 0013 | "You've been added to <project>" for an invitee who already had an account; shown as a toast at next sign-in. A user reads and marks seen only their own; the service role inserts. |
| `schema_conversions` | 0020 | One row per one-off data conversion, so it can never run twice. No client grants. |
| `time_unit_conversion_log` | 0020 | The months-per-slot factor each project was multiplied by. Audit trail and the way back. No client grants. |

Since 0020 the `*_slots` columns (`chunk_phases.start_slot` / `duration_slots`,
`phase_dependencies.lag_slots`, `phase_template_steps.default_duration_slots`)
hold **months**, whatever their names say.

### RPCs

"Gate" = what the function checks before doing anything; "definer" =
whether it runs `SECURITY DEFINER` (owner privilege, bypasses RLS — so its
internal gate check IS the security boundary, not a convenience).

| Function | Gate | Definer | Replaces / purpose |
| --- | --- | --- | --- |
| `ship.ensure_invites(text[], text)` | `is_admin()` (platform) | yes | `ensureConsultantUsers()` |
| `ship.create_project(text, jsonb)` | `is_admin()` (platform) | yes | `createProject()` |
| `ship.update_project(text, text, jsonb)` | `is_admin()` (platform) | yes | `updateProject()` / SettingsTab save |
| `ship.claim_invite()` | any signed-in user | yes | *(new)* the signup gate |
| `ship.parse_cost_input(text)` (0006) | none — pure, granted to `authenticated` | no (`immutable`, touches no table) | Ports `parseCostInput()` from `lib/costs.ts`. Read the Gotchas note below before touching the exponent regex. |
| `ship.seed_default_taxonomy(text)` (0008) | `is_admin()` (platform) | yes | Populates a new project's taxonomy with the generic defaults. Not yet wired into `create_project()` — that's an app-layer change, out of scope for 0008. |
| `ship.apply_suggestion(uuid, text)` (0009) | `can_edit_project()` on the suggestion's project | yes | Locks the suggestion row, enforces the column allowlist (`suggestable_line_item_columns()`), applies the patch, flips status to `accepted`. |
| `ship.reject_suggestion(uuid, text)` (0009) | `can_edit_project()` on the suggestion's project | yes | Same lock discipline as `apply_suggestion`; writes no line item. |
| `ship.baseline_fingerprint(text)` (0010) | none — read-only, granted to `authenticated` | yes (must see the true baseline past RLS) | md5 over the project's phases + dependencies; used by publish/rebase to detect drift. |
| `ship.create_scenario(text, text, text)` (0010, tightened 0011) | `can_contribute_project()` | yes | Branches the current baseline into a private `scenarios` row. **0011 tightened this from `can_read_project()`** — a viewer's sandbox must stay ephemeral (SPEC R5.3), and persisting one is not ephemeral. |
| `ship.publish_scenario(uuid)` (0010, tightened 0011) | `can_edit_project()` | yes | Applies a scenario back onto the baseline; refuses on fingerprint drift. **0011 tightened this from `can_read_project()` — see the Gotchas note; this was a real privilege-escalation bug.** |
| `ship.rebase_scenario(uuid)` (0010) | scenario owner, or `is_admin()` | yes | Re-reads the current baseline into a stale scenario's payload and re-stamps its fingerprint, so a drift refusal isn't a dead end. |

### RLS / authority helper functions (0007, 0009)

These aren't meant to be called directly by the client — they're the
predicates every policy above is built from. Full detail (and the
uncorrelated-vs-correlated performance rule that dictates which shape is
used where) is in the header of `0009_ship_roles_and_suggestions.sql`
section 3; don't "simplify" the two shapes into one without reading it
first.

| Function | Shape | Used for |
| --- | --- | --- |
| `ship.project_role(text)` | returns `text`, per-row | THE authority function — `admin\|editor\|consultant\|viewer\|null` for the caller on one project. Everything else below is a boolean or set-returning projection of it. |
| `ship.is_project_admin`, `ship.can_edit_project`, `ship.can_contribute_project`, `ship.can_read_project` | boolean, per-row | `INSERT ... WITH CHECK` policies (one known row) and any correlated per-row filter. `can_read_project` was **redefined** in 0009 — see Gotchas. |
| `ship.my_project_ids`, `my_editable_project_ids`, `my_admin_project_ids`, `my_contributor_project_ids` | `setof text`, no args | `SELECT`/`UPDATE`/`DELETE USING` and `UPDATE WITH CHECK` — uncorrelated, hoisted into one InitPlan per statement instead of one call per row. |
| `ship.my_readable_chunk_ids`, `my_editable_chunk_ids`, `my_readable_phase_ids`, `my_editable_phase_ids`, `my_readable_template_ids`, `my_editable_template_ids` | `setof uuid`, no args | Same trick, one level down, for tables keyed by a parent id rather than `project_id` directly. |
| `ship.can_edit_chunk`, `can_edit_phase`, `can_edit_template`, `ship.phase_project_id` (0007), `ship.line_item_project_id` | boolean/text, per-row | `INSERT ... WITH CHECK` on the chunk/phase/template/suggestion tables. |

All are `SECURITY DEFINER`, `stable`, `set search_path = ''`, and
`revoke ... from public` + `grant execute ... to authenticated` — no
exceptions.

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
migrations `0001`–`0005` (the set actually applied to the remote project —
see `LOCAL-DEV.md`; `0006` onward are local-only so far) is safe and
additive today; onboarding users is a separate decision. See
`PREFLIGHT.md` in this directory for the full audit and evidence.

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
  permits it. That policy is still `FOR ALL` and still gated on the
  PLATFORM admin flag (`ship.is_admin()`), because `ship.profiles` is a
  platform-level table with no project to scope to. Do not confuse it with
  `projects_admin_all`, which 0009 *did* split into
  `projects_insert`/`projects_update`/`projects_delete`, the latter two
  gated on `my_admin_project_ids()`.
- **Chunking is admin + editor write, everyone-else read — NOT "any
  project member" any more.** That used to be true (0002/0007 both wrote
  `using (ship.can_read_project(...))` on the chunk/phase/timeline write
  policies, "so an admin-only write policy wouldn't give consultants a UI
  that silently fails"). **0009 narrowed it**: per SPEC's role matrix,
  `consultant` and `viewer` are read-only on packages, schedule and
  templates; only `admin`/`editor` write. This is a real behaviour change,
  not a doc fix — 0009's whole backfill strategy (every existing
  `project_members` row becomes `editor`, not `consultant`) exists
  specifically so this narrowing didn't silently break anyone's UI. If
  you're touching chunk/phase policies, the ones to know are
  `chunk_projects_update`, `chunk_project_items_update`,
  `chunk_phases_update`, `phase_dependencies_update`,
  `phase_templates_update`, `phase_template_steps_update`,
  `project_timeline_settings_update` — all gated on
  `project_id in (select ship.my_editable_project_ids())` (or the
  chunk/phase-id equivalent).
- **`0005_ship_function_grants.sql` is a no-op in practice, on purpose.**
  It revokes the stray default `PUBLIC` EXECUTE grant on 3 trigger-only
  functions (`fill_item_number`, `fill_chunk_number`,
  `normalize_line_item`). A `BEFORE`-row trigger's invocation doesn't
  check the invoking role's EXECUTE privilege on the trigger function at
  all — only the table privilege and the function owner's own EXECUTE
  matter — so this closes a security-advisor WARN without changing any
  observable behaviour. Don't "fix" it by granting `authenticated`
  EXECUTE back; that's precisely the inconsistency it removes.
- **Alphabetical BEFORE-trigger ordering on `line_items` is now a 4-link
  chain, and the names encode it on purpose:**
  `line_items_aa_normalize` (fills `discipline`) →
  `line_items_bb_fill_item_number` (reads `discipline`, from 0003) →
  `line_items_cc_sync_ecc` (recomputes `ecc_amount` from
  `estimated_first_cost`, from 0006) →
  `line_items_dd_check_taxonomy` (validates the 4 taxonomy columns, from
  0008). `cc` and `dd` don't functionally depend on `aa`/`bb`, but they're
  named to continue the sequence rather than break the convention.
  Renumbering any of them changes fire order; don't.
- **Taxonomy validation fails OPEN, not closed, when a project has zero
  rows for a `kind`.** `ship.taxonomy_value_allowed()` (0008) returns
  `true` for every value if `project_taxonomy_values` has no rows at all
  for `(project_id, kind)` — deliberately, so a kind added later without a
  matching backfill (or a project created outside the normal flow) can't
  brick line-item entry. This is a vocabulary, not a security boundary;
  RLS is the actual boundary and is never fail-open. Once a project has
  *any* value for a kind, validation is fully enforced for that kind.
- **`substring(s from pattern)` returns the first CAPTURE GROUP, not the
  whole match, when the pattern has one.** `ship.parse_cost_input()`
  (0006) pulls out a leading numeric literal with a regex whose exponent
  group MUST be non-capturing (`(?:[eE]...)`). A capturing group there
  returns `NULL` for every input without an exponent — i.e. almost every
  real cost string — and the function silently parses every cost in the
  database as `0`. This is called out in the migration precisely because
  it's the kind of bug that passes review and fails silently in
  production; if you touch this function, test `'$1.2m'`, `'850k'`, and
  `'1,250'` against it before committing, not just the exponent case.
- **`chunk_phases.pct_of_tpc` is deliberately NOT constrained to sum to
  100 across a package.** A CHECK can't span rows, and a trigger that
  auto-normalised would silently rescale a number a cost estimator typed
  — worse than showing them it's wrong. The UI is responsible for
  surfacing a running total that goes red off 100; the database will
  happily store 60 or 140.
- **The v2 backfills in `0007`/`0008` are no-ops on a fresh database —
  that's why `seeds/002_v2_phases.sql` and `seeds/003_v2_taxonomy.sql`
  exist.** Both backfills join against `ship.projects`/`ship.line_items`
  to migrate *existing* data forward. The Supabase CLI applies all
  migrations before any seed, so on a fresh `db reset` there are zero
  rows in those tables when 0007/0008 run — the backfills execute, match
  nothing, and do nothing. The two extra seed files are the fixture
  equivalent, written to run *after* `001_seed.sql` creates the projects
  and line items. If you're wondering why local phases/taxonomy don't
  show up after a reset, check that both seeds ran, in glob order
  (001 → 002 → 003).
