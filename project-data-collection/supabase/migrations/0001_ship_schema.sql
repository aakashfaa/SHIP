-- =====================================================================
-- 0001_ship_schema.sql
-- SHIP -- schema + tables + indexes.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- -------------------------------------------------
-- This Postgres database also hosts an unrelated production project.
-- Rules enforced by this file (and every other file in this directory):
--
--   * EVERYTHING lives in schema `ship`. Nothing is created, altered or
--     granted in `public`, `auth`, `storage`, `realtime` or `extensions`.
--   * NO `create extension` of any kind -- extensions are database-wide
--     and would be visible to (and breakable by) the other project.
--     That is why emails are plain lowercase `text` + a CHECK instead of
--     `citext`. `gen_random_uuid()` is core in PG13+, so no pgcrypto.
--   * NO trigger is ever created on `auth.users`. Such a trigger fires
--     inside the OTHER project's signup transaction; a bug in it would
--     break their signups. SHIP isolation comes purely from
--     `ship.profiles` membership + RLS (see 0002) and
--     `ship.claim_invite()` (see 0004).
--   * Nothing is added to the shared `supabase_realtime` publication.
--
-- Re-runnable: `create schema if not exists` / `create table if not
-- exists` / `create index if not exists`. NOTE: because the tables use
-- `if not exists`, editing a CHECK constraint in this file will NOT be
-- picked up on a re-run against an already-applied database -- write a
-- new migration file for that.
--
-- ENUM-LIKE COLUMNS ARE `text` + `CHECK (col in (...))`, NOT native
-- enums. Rationale:
--   1. These are UI label strings in a prototype that is still moving
--      ('RESTORATION *', '1_HIGH <5 years', '$$$High',
--      'ENVELOPE (EXT. WALLS)'). A CHECK is a one-transaction
--      drop-and-re-add; `ALTER TYPE ... DROP VALUE` does not exist.
--   2. PostgREST serialises both a native enum and a checked text column
--      as a plain JSON string, so the client sees zero difference.
-- =====================================================================

begin;

create schema if not exists ship;

comment on schema ship is
  'SHIP capital-planning app. Isolated from the other project sharing this database; see supabase/README.md.';

-- Lock the schema down by default. Grants are issued in 0002, next to
-- the RLS policies they pair with.
revoke all on schema ship from public;

-- ---------------------------------------------------------------------
-- profiles  (6 columns)
-- One row per SHIP user. Created ONLY by ship.claim_invite() (0004);
-- there is deliberately no trigger on auth.users, so a user of the other
-- project who signs into this database gets no ship.profiles row and
-- therefore sees nothing (RLS in 0002 is keyed off this table).
-- ---------------------------------------------------------------------
create table if not exists ship.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique check (email = lower(email)),
  name        text not null default '',
  role        text not null default 'consultant' check (role in ('admin','consultant')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table ship.profiles is
  'SHIP membership. A row here is what makes an auth.users row a SHIP user.';

-- ---------------------------------------------------------------------
-- projects  (5 columns)
-- `id` is the slug produced by ship.slugify() (0004), e.g.
-- 'federal-campus-master-plan'. It is the URL segment the app routes on.
-- ---------------------------------------------------------------------
create table if not exists ship.projects (
  id          text primary key check (id <> ''),
  name        text not null,
  created_at  date not null default current_date,
  created_by  uuid references ship.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- project_consultants  (4 columns)
-- The `ProjectConsultant` row minus its `emails` array (which lives in
-- project_members). One row per discipline per project.
-- ---------------------------------------------------------------------
create table if not exists ship.project_consultants (
  id              uuid primary key default gen_random_uuid(),
  project_id      text not null references ship.projects(id) on delete cascade,
  consultant_type text not null check (consultant_type in (
                    'Architecture','Accessibility','Civil','Electrical','Envelope',
                    'Fire Alarm','Hazardous Materials','Historic Preservation','Landscape',
                    'Mechanical','Plumbing','Structural','Security','Telecom')),
  org_name        text not null default '',
  unique (project_id, consultant_type)
);

create index if not exists project_consultants_project_id_idx
  on ship.project_consultants (project_id);

-- ---------------------------------------------------------------------
-- project_members  (3 columns)
-- THE membership table. It replaces BOTH `Project.consultants[].emails`
-- AND the derived `Project.assignedUsers` array from lib/types.ts:
--   consultants[].emails = select email where project_id=? and consultant_type=?
--   assignedUsers        = select distinct email where project_id=?
--
-- DELIBERATE: `email` has NO foreign key to ship.profiles. That
-- decouples SHIP data from the shared auth.users -- a project can list a
-- consultant who has not signed up yet, and deleting a profile never
-- cascades away anyone's project assignment.
--
-- Every RLS read in 0002 funnels through ship.is_member(), which is a
-- lookup on (email, project_id) here, so BOTH indexes below are load
-- bearing. Do not drop them.
-- ---------------------------------------------------------------------
create table if not exists ship.project_members (
  project_id      text not null references ship.projects(id) on delete cascade,
  email           text not null check (email = lower(email) and email <> ''),
  consultant_type text not null check (consultant_type in (
                    'Architecture','Accessibility','Civil','Electrical','Envelope',
                    'Fire Alarm','Hazardous Materials','Historic Preservation','Landscape',
                    'Mechanical','Plumbing','Structural','Security','Telecom')),
  primary key (project_id, email, consultant_type)
);

create index if not exists project_members_email_idx      on ship.project_members (email);
create index if not exists project_members_project_id_idx on ship.project_members (project_id);

-- ---------------------------------------------------------------------
-- line_items  (29 domain columns from the LineItem type, + updated_at)
--
-- DELIBERATE: `user_email` has NO foreign key to ship.profiles, for the
-- same reason as project_members.email -- seed rows are attributed to
-- people with no account, and deleting a profile must not delete work.
--
-- `id` is a uuid here even though the TS mock used string ids like
-- 'seed-li-001'; seeds/001_seed.sql assigns deterministic uuids.
--
-- `consultant_type`/`discipline` accept 'Admin' because the TS type is
-- `ConsultantType | 'Admin'`, but ship.normalize_line_item() (0003)
-- rewrites 'Admin' to 'Architecture' before the CHECK is evaluated.
-- ---------------------------------------------------------------------
create table if not exists ship.line_items (
  id                                   uuid primary key default gen_random_uuid(),
  project_id                           text not null references ship.projects(id) on delete cascade,
  user_email                           text not null check (user_email = lower(user_email)),
  consultant_type                      text not null check (consultant_type in (
                                         'Architecture','Accessibility','Civil','Electrical','Envelope',
                                         'Fire Alarm','Hazardous Materials','Historic Preservation','Landscape',
                                         'Mechanical','Plumbing','Structural','Security','Telecom','Admin')),
  company_name                         text not null default '',
  discipline                           text not null check (discipline in (
                                         'Architecture','Accessibility','Civil','Electrical','Envelope',
                                         'Fire Alarm','Hazardous Materials','Historic Preservation','Landscape',
                                         'Mechanical','Plumbing','Structural','Security','Telecom','Admin')),
  item_number                          text not null default '',
  name                                 text not null default '',
  short_description                    text not null default '',
  category                             text not null check (category in (
                                         'END OF LIFE','DEFERRED MAINTENANCE','UPGRADES / IMPROVEMENTS',
                                         'RESTORATION *','STUDY / DOCUMENTATION')),
  timeline_priority                    text not null check (timeline_priority in (
                                         '0_PRIORITY *','1_HIGH <5 years','2_MID 5-10 years',
                                         '3_LOW 10-20 years','4_FUTURE >20 years','5_250th ANNIVERSARY')),
  building_area_impacted               text not null check (building_area_impacted in (
                                         'WHOLE BUILDING','ANNEX','WEST WING','EAST WING','BULFINCH',
                                         'SITE','OTHER *')),
  building_level_impacted              text not null check (building_level_impacted in (
                                         'WHOLE BUILDING','ROOF','ENVELOPE (EXT. WALLS)','LEVELS ABOVE GRADE',
                                         'LEVELS BELOW GRADE','L5','L4','L3','L2','L1','BASEMENT',
                                         'SUB BASEMENT','OTHER *')),
  operational_impact                   text not null check (operational_impact in ('NONE','LOW','MODERATE','HIGH')),
  benefit_to_users                     text not null check (benefit_to_users in ('NONE','LOW','MODERATE','HIGH')),
  benefit_to_public                    text not null check (benefit_to_public in ('NONE','LOW','MODERATE','HIGH')),
  relative_first_cost                  text not null check (relative_first_cost in ('$LOW','$$Moderate','$$$High')),
  estimated_first_cost                 text not null default '',
  relative_operation_cost_impact       text not null check (relative_operation_cost_impact in (
                                         'MINIMAL IMPACT','MODERATE REDUCTION','HIGH REDUCTION','INCREASE','N/A')),
  relative_operational_energy_usage    text not null check (relative_operational_energy_usage in (
                                         'MINIMAL IMPACT','MODERATE REDUCTION','HIGH REDUCTION','N/A')),
  electrification_eo594                text not null check (electrification_eo594 in ('NONE','LOW','MODERATE','HIGH')),
  addressing_resiliency_sustainability text not null check (addressing_resiliency_sustainability in ('Yes','No')),
  addressing_deferred_maintenance      text not null check (addressing_deferred_maintenance in ('Yes','No')),
  code_life_safety_improvement         text not null check (code_life_safety_improvement in ('Yes','No')),
  accessibility_improvement            text not null check (accessibility_improvement in ('Yes','No')),
  historic_impact                      text not null check (historic_impact in ('Yes','No')),
  potential_synergies                  text[] not null default '{}'::text[]
                                         check (potential_synergies <@ ARRAY[
                                           'Architecture','Accessibility','Civil','Electrical','Envelope',
                                           'Fire Alarm','Hazardous Materials','Historic Preservation','Landscape',
                                           'Mechanical','Plumbing','Structural','Security','Telecom']::text[]),
  supporting_notes                     text not null default '',
  created_at                           timestamptz not null default now(),
  updated_at                           timestamptz,
  unique (project_id, item_number)
);

create index if not exists line_items_project_id_idx
  on ship.line_items (project_id);

-- MasterViewTab reads every item in a project; AddDataTab reads only the
-- signed-in user's own items. This composite index serves the second.
create index if not exists line_items_project_id_user_email_idx
  on ship.line_items (project_id, user_email);

-- ---------------------------------------------------------------------
-- chunk_projects  (8 columns)
-- `timeline_segments` stays jsonb: it is an ordered list of
-- {id,start,duration} that is always read and written as a whole by the
-- timeline editor and is never queried into.
-- ---------------------------------------------------------------------
create table if not exists ship.chunk_projects (
  id                 uuid primary key default gen_random_uuid(),
  project_id         text not null references ship.projects(id) on delete cascade,
  chunk_number       text not null default '',
  name               text not null default '',
  timeline_segments  jsonb not null default '[]'::jsonb
                       check (jsonb_typeof(timeline_segments) = 'array'),
  timeline_start     numeric not null default 0,
  timeline_duration  numeric not null default 1,
  created_at         timestamptz not null default now(),
  unique (project_id, chunk_number)
);

create index if not exists chunk_projects_project_id_idx
  on ship.chunk_projects (project_id);

-- ---------------------------------------------------------------------
-- chunk_project_items  (4 columns)
-- A REAL child table, not the `itemLinks` jsonb array that ChunkProject
-- carried in TypeScript. The `on delete cascade` on line_item_id fixes a
-- live bug: in lib/store.ts, deleteLineItem() leaves dangling
-- itemLinks[].lineItemId entries behind in every chunk that referenced
-- the deleted item.
-- ---------------------------------------------------------------------
create table if not exists ship.chunk_project_items (
  chunk_project_id  uuid not null references ship.chunk_projects(id) on delete cascade,
  line_item_id      uuid not null references ship.line_items(id) on delete cascade,
  quantity          text not null default '',
  position          integer not null default 0,
  primary key (chunk_project_id, line_item_id)
);

-- The pk already indexes chunk_project_id; line_item_id needs its own
-- index so deleting a line item does not sequential-scan this table.
create index if not exists chunk_project_items_line_item_id_idx
  on ship.chunk_project_items (line_item_id);

-- ---------------------------------------------------------------------
-- project_timeline_settings  (6 columns)
-- NOTE the column is `interval_unit`, NOT `interval` -- `interval` is a
-- reserved Postgres type name. The TypeScript field stays `interval`;
-- the client-side mapper renames it on the way in and out.
-- Defaults mirror getTimelineSettingsForProject() in lib/store.ts.
-- ---------------------------------------------------------------------
create table if not exists ship.project_timeline_settings (
  project_id             text primary key references ship.projects(id) on delete cascade,
  years                  integer not null default 10 check (years >= 0),
  interval_unit          text not null default 'yearly' check (interval_unit in (
                           'monthly','quarterly','yearly','bi-yearly','3-yearly','5-yearly')),
  zoom_level             integer not null default 3 check (zoom_level between 1 and 5),
  escalation_percent     numeric not null default 0 check (escalation_percent >= 0),
  escalation_every_years integer not null default 5 check (escalation_every_years > 0)
);

-- ---------------------------------------------------------------------
-- item_number_counters  (3 columns)
-- chunk_number_counters (2 columns)
--
-- Race-safe sources for the human-readable A1 / M2 / PP12 identifiers.
-- SEMANTICS (see 0003 for the full explanation): `next_value` is the
-- NEXT number that will be handed out, which is why the defaults are 1
-- and 10 -- the first item is A1 and the first chunk is PP10.
--
-- These two tables get NO grants to `authenticated` (see 0002). They are
-- touched only by the SECURITY DEFINER trigger functions in 0003.
-- ---------------------------------------------------------------------
create table if not exists ship.item_number_counters (
  project_id  text not null references ship.projects(id) on delete cascade,
  discipline  text not null,
  next_value  integer not null default 1 check (next_value >= 1),
  primary key (project_id, discipline)
);

create table if not exists ship.chunk_number_counters (
  project_id  text primary key references ship.projects(id) on delete cascade,
  next_value  integer not null default 10 check (next_value >= 1)
);

-- ---------------------------------------------------------------------
-- pending_invites  (6 columns)
-- The allowlist that gates who may become a SHIP user. Because there is
-- no trigger on auth.users, signing up is not enough: ship.claim_invite()
-- (0004) refuses to mint a ship.profiles row for an email that is not
-- listed here. A user of the OTHER project on this database who signs in
-- therefore gets nothing.
--
-- NO grants to `authenticated` (see 0002): the allowlist must not be
-- readable or writable from the client. Only the SECURITY DEFINER RPCs
-- ship.ensure_invites() and ship.claim_invite() touch it.
-- ---------------------------------------------------------------------
create table if not exists ship.pending_invites (
  email       text primary key check (email = lower(email) and email <> ''),
  name        text not null default '',
  role        text not null default 'consultant' check (role in ('admin','consultant')),
  invited_by  uuid references ship.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz
);

commit;
