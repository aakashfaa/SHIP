-- =====================================================================
-- 0008_ship_taxonomies.sql
-- SHIP v2 -- per-project taxonomies for building_area_impacted,
-- building_level_impacted, category and timeline_priority.
--
-- See docs/SPEC-v2-phasing-and-cost-model.md section 1.9 (R9.1, R9.2,
-- R9.4) for the requirement this implements.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0007. Local stack only; not applied remotely.
--
-- THE PROBLEM THIS SOLVES
-- -----------------------
-- Four columns on ship.line_items were hardcoded, via CHECK, to one
-- client's vocabulary:
--
--   building_area_impacted   'ANNEX', 'WEST WING', 'BULFINCH', ...
--   building_level_impacted  (already generic -- kept as the new default)
--   category                 (already generic -- kept as the new default)
--   timeline_priority        '5_250th ANNIVERSARY', ...
--
-- "ANNEX", "WEST WING" and "BULFINCH" are rooms in ONE specific building
-- (the state house). "5_250th ANNIVERSARY" is that client's own
-- milestone. SHIP is being built for architecture practices generally,
-- so a firm working on a school or a hospital campus must be able to
-- define its own area/level/category/priority vocabulary per project,
-- without a code change or a migration.
--
-- WHAT THIS FILE DOES
-- --------------------
--   1. ship.project_taxonomy_values -- the per-project vocabulary table.
--   2. Drops the four CHECK constraints and replaces them with a
--      BEFORE-row trigger that validates against that table.
--   3. Backfills every existing project's taxonomy with the generic
--      defaults PLUS whatever values its line items already use, so the
--      state-house project keeps ANNEX/WEST WING/BULFINCH/
--      5_250th ANNIVERSARY and nothing that already exists breaks.
--   4. ship.seed_default_taxonomy(text) -- populates a NEW project with
--      building-agnostic defaults. Not wired into ship.create_project()
--      yet; that is a lib/ change happening in parallel and is out of
--      scope for this file.
--   5. Grants + RLS, same read/write split as 0006/0007.
--
-- Re-runnable: `create table if not exists`, `create or replace
-- function`, `drop policy if exists` + `create policy`, `drop trigger if
-- exists` + `create trigger`, `alter table ... drop constraint if
-- exists`, and every insert below is either `on conflict do nothing` or
-- keyed on `not exists`.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- project_taxonomy_values  (5 columns)
--
-- One row per allowed (project, kind, value). `kind` is a small closed
-- set -- it is NOT itself per-project, only the values within each kind
-- are. Adding a fifth taxonomy kind later is a migration; adding a value
-- within an existing kind is a row.
--
-- Primary key (project_id, kind, value) rather than a surrogate id: the
-- triple IS the identity, there is nothing else to key on, and it gives
-- the validation trigger below a plain existence check instead of a
-- lookup-then-compare.
-- ---------------------------------------------------------------------
create table if not exists ship.project_taxonomy_values (
  project_id  text    not null references ship.projects(id) on delete cascade,
  kind        text    not null check (kind in (
                'building_area', 'building_level', 'category', 'timeline_priority')),
  value       text    not null check (btrim(value) <> ''),
  sort_order  integer not null default 0,
  is_archived boolean not null default false,
  primary key (project_id, kind, value)
);

comment on table ship.project_taxonomy_values is
  'Per-project dropdown vocabularies for line_items.{building_area_impacted,building_level_impacted,category,timeline_priority}. See 0008 header and R9 in the v2 spec.';

comment on column ship.project_taxonomy_values.is_archived is
  'Soft-delete flag. A value already written onto line items cannot simply be DELETEd here -- that would either orphan every line item still carrying it (FK violation is avoided only because there is no FK from line_items to this table; the value would just silently no longer validate on the next edit) or force a cascading rewrite of historical records that nobody asked to change. Archiving lets a firm stop OFFERING a value in new dropdowns while every existing line item, and the validation trigger below, keep treating it as a value that value in this project. The UI is responsible for filtering out archived rows when it builds a dropdown; the database does not.';

-- Every ordered read the client does (rendering a dropdown) filters by
-- (project_id, kind) and orders by sort_order; this is that index.
create index if not exists project_taxonomy_values_project_kind_sort_idx
  on ship.project_taxonomy_values (project_id, kind, sort_order);

-- ---------------------------------------------------------------------
-- ship.default_taxonomy_rows() -> table(kind, value, sort_order)
--
-- The single source of truth for "what a brand-new project starts with".
-- Used by both ship.seed_default_taxonomy() (the gated, API-facing entry
-- point) and the one-time backfill below (which runs as this
-- migration's owner and must NOT go through an is_admin()-gated
-- function -- see the note above that backfill).
--
-- BUILDING-AGNOSTIC ON PURPOSE (R9.4): no value here names a specific
-- building, wing, or client milestone.
--   * building_area keeps only WHOLE BUILDING / SITE / OTHER * -- ANNEX,
--     WEST WING and BULFINCH are rooms in one specific building and do
--     not belong in a generic default for firms who have never heard of
--     it.
--   * building_level's existing list (ROOF, ENVELOPE, L1-L5, BASEMENT,
--     SUB BASEMENT, ...) was already generic -- it describes any
--     multi-story building, not this one -- so it carries over unchanged.
--   * category was already generic and carries over unchanged.
--   * timeline_priority drops '5_250th ANNIVERSARY': a milestone specific
--     to one institution is not a universal planning horizon. The
--     remaining five keep their leading digit, which encodes display
--     order and is read by the backfill below via regexp.
--
-- The existing seeded projects do NOT lose ANNEX / WEST WING / BULFINCH /
-- 5_250th ANNIVERSARY -- the backfill after this function re-adds
-- whatever a project's line items actually use, on top of these
-- defaults. This function only controls what a project with NO history
-- starts from.
-- ---------------------------------------------------------------------
create or replace function ship.default_taxonomy_rows()
returns table (kind text, value text, sort_order integer)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('building_area',     'WHOLE BUILDING',          0),
    ('building_area',     'SITE',                     1),
    ('building_area',     'OTHER *',                  2),

    ('building_level',    'WHOLE BUILDING',           0),
    ('building_level',    'ROOF',                      1),
    ('building_level',    'ENVELOPE (EXT. WALLS)',     2),
    ('building_level',    'LEVELS ABOVE GRADE',        3),
    ('building_level',    'LEVELS BELOW GRADE',        4),
    ('building_level',    'L5',                        5),
    ('building_level',    'L4',                        6),
    ('building_level',    'L3',                        7),
    ('building_level',    'L2',                        8),
    ('building_level',    'L1',                        9),
    ('building_level',    'BASEMENT',                 10),
    ('building_level',    'SUB BASEMENT',             11),
    ('building_level',    'OTHER *',                  12),

    ('category',          'END OF LIFE',               0),
    ('category',          'DEFERRED MAINTENANCE',      1),
    ('category',          'UPGRADES / IMPROVEMENTS',   2),
    ('category',          'RESTORATION *',              3),
    ('category',          'STUDY / DOCUMENTATION',      4),

    ('timeline_priority', '0_PRIORITY *',               0),
    ('timeline_priority', '1_HIGH <5 years',            1),
    ('timeline_priority', '2_MID 5-10 years',           2),
    ('timeline_priority', '3_LOW 10-20 years',          3),
    ('timeline_priority', '4_FUTURE >20 years',         4)
  ) as t(kind, value, sort_order)
$$;

-- Internal: revoked from public and NOT granted to authenticated, same
-- pattern as ship.slugify() in 0004. Only called from functions that are
-- themselves SECURITY DEFINER (below) or from this migration running as
-- its owner.
revoke all on function ship.default_taxonomy_rows() from public;

-- ---------------------------------------------------------------------
-- ship.seed_default_taxonomy(p_project_id text) returns void
--
-- Populates a NEW project with the generic defaults above. Gated on
-- ship.is_admin(), same as ship.create_project()/ship.ensure_invites() in
-- 0004 -- a SECURITY DEFINER function bypasses RLS entirely, so without
-- this check any authenticated user could seed (or silently no-op onto)
-- a project's taxonomy regardless of the write policy set below.
--
-- NOT called by ship.create_project() yet -- wiring a new project's
-- creation flow to call this is an application-layer change (lib/), and
-- this file touches only supabase/migrations/0008. Whoever wires it in
-- should call this AFTER the project row exists, inside the same
-- transaction, exactly the way create_project() already seeds
-- chunk_number_counters and project_timeline_settings.
--
-- `on conflict do nothing`: calling this twice for the same project (or
-- after a firm has already customised its taxonomy) never clobbers a row
-- someone edited or archived.
-- ---------------------------------------------------------------------
create or replace function ship.seed_default_taxonomy(p_project_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not ship.is_admin() then
    raise exception 'ship.seed_default_taxonomy: admin role required'
      using errcode = '42501';
  end if;

  insert into ship.project_taxonomy_values (project_id, kind, value, sort_order)
  select p_project_id, d.kind, d.value, d.sort_order
    from ship.default_taxonomy_rows() d
  on conflict (project_id, kind, value) do nothing;
end;
$$;

revoke all    on function ship.seed_default_taxonomy(text) from public;
grant execute on function ship.seed_default_taxonomy(text) to authenticated;

-- ---------------------------------------------------------------------
-- ship.taxonomy_value_allowed(project_id, kind, value) -> boolean
--
-- FAIL-OPEN BY DESIGN: if a project has NO rows at all for (project_id,
-- kind), this returns true for every value. Without that clause,
-- applying this migration would instantly break every INSERT and UPDATE
-- on every project that has not yet been backfilled/seeded for that
-- kind -- the backfill below covers every project that exists today, but
-- a future kind added without a matching backfill, or a project row
-- created outside the normal flow, must not brick line-item entry.
--
-- Fail-open is the right call HERE specifically because this is a
-- vocabulary, not a security boundary: the worst case of failing open is
-- an unconstrained text value in a dropdown-shaped column, exactly what
-- v1 already tolerated. RLS (below) is the actual security boundary and
-- is never fail-open. Once a project has at least one value for a kind,
-- validation is fully enforced for that kind again.
--
-- Archived values still count as "allowed" here on purpose -- is_archived
-- only hides a value from NEW dropdown selections (a UI concern); it must
-- not retroactively invalidate line items that already carry it, or a
-- routine UPDATE to an unrelated column would start failing the moment
-- someone archives a value in use.
-- ---------------------------------------------------------------------
create or replace function ship.taxonomy_value_allowed(
  p_project_id text,
  p_kind       text,
  p_value      text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    not exists (
      select 1 from ship.project_taxonomy_values v
       where v.project_id = p_project_id
         and v.kind = p_kind
    )
    or exists (
      select 1 from ship.project_taxonomy_values v
       where v.project_id = p_project_id
         and v.kind = p_kind
         and v.value = p_value
    )
$$;

revoke all on function ship.taxonomy_value_allowed(text, text, text) from public;

-- ---------------------------------------------------------------------
-- ship.check_line_item_taxonomy()  -- BEFORE INSERT OR UPDATE
--
-- THE CHECK-VS-TRIGGER TRADEOFF, HONESTLY:
-- a CHECK constraint is declarative, indexable by the planner's
-- constraint exclusion, visible in \d, and cannot be bypassed by a
-- codepath that forgets to call a function. A trigger is none of those
-- things -- it is procedural, invisible in \d, and every future write
-- path depends on remembering it exists. The ONLY reason to give that up
-- is that a CHECK constraint can reference nothing but the row and
-- literal constants; it cannot look up "the set of valid values for
-- THIS project", because that set lives in another table and differs
-- per row. A trigger is the only mechanism Postgres has for validating
-- a column against a per-row-dependent set. This is not a stylistic
-- choice -- it is the only tool available once the vocabulary stopped
-- being a database-wide constant.
--
-- SECURITY DEFINER so this validates identically regardless of whether
-- the writer's role happens to hold SELECT on project_taxonomy_values --
-- it is a data-integrity check, not an access-control decision, and it
-- must not become one by accident if that table's read policy is ever
-- narrowed.
--
-- Trigger name is `line_items_dd_check_taxonomy`. 0003 fires BEFORE-row
-- triggers in ALPHABETICAL NAME ORDER on this table
-- (aa_normalize -> bb_fill_item_number -> cc_sync_ecc); this check reads
-- only columns the client supplies directly (none of them derived by an
-- earlier trigger), so its position in that order does not matter
-- functionally. It is named `dd` anyway, to keep the sequence readable
-- as a sequence rather than break the convention for no reason.
-- ---------------------------------------------------------------------
create or replace function ship.check_line_item_taxonomy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not ship.taxonomy_value_allowed(new.project_id, 'building_area', new.building_area_impacted) then
    raise exception 'line_items.building_area_impacted: % is not in this project''s taxonomy', new.building_area_impacted
      using errcode = '23514';
  end if;

  if not ship.taxonomy_value_allowed(new.project_id, 'building_level', new.building_level_impacted) then
    raise exception 'line_items.building_level_impacted: % is not in this project''s taxonomy', new.building_level_impacted
      using errcode = '23514';
  end if;

  if not ship.taxonomy_value_allowed(new.project_id, 'category', new.category) then
    raise exception 'line_items.category: % is not in this project''s taxonomy', new.category
      using errcode = '23514';
  end if;

  if not ship.taxonomy_value_allowed(new.project_id, 'timeline_priority', new.timeline_priority) then
    raise exception 'line_items.timeline_priority: % is not in this project''s taxonomy', new.timeline_priority
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function ship.check_line_item_taxonomy() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Drop the four hardcoded CHECK constraints.
--
-- Names confirmed against pg_constraint on the local stack, not guessed
-- (Postgres's auto-generated name for an inline column CHECK is
-- `<table>_<column>_check`, but that is a convention, not a guarantee):
--
--   select conname from pg_constraint
--    where conrelid = 'ship.line_items'::regclass and contype = 'c';
--
-- `if exists` on every one of these, so re-running this file against a
-- database where 0008 already applied (and the constraints are already
-- gone) is a no-op rather than an error.
-- ---------------------------------------------------------------------
alter table ship.line_items
  drop constraint if exists line_items_building_area_impacted_check,
  drop constraint if exists line_items_building_level_impacted_check,
  drop constraint if exists line_items_category_check,
  drop constraint if exists line_items_timeline_priority_check;

drop trigger if exists line_items_dd_check_taxonomy on ship.line_items;
create trigger line_items_dd_check_taxonomy
  before insert or update on ship.line_items
  for each row execute function ship.check_line_item_taxonomy();

-- ---------------------------------------------------------------------
-- Backfill, part 1: every existing project gets the generic defaults.
--
-- Deliberately every project, not just ones missing rows -- `on conflict
-- do nothing` makes this safe to re-run, and running it before part 2
-- below matters: it is what lets 'WHOLE BUILDING' (which is both a
-- default AND in universal use) keep its default sort_order of 0 rather
-- than whatever position part 2's dense_rank would otherwise assign it.
-- ---------------------------------------------------------------------
insert into ship.project_taxonomy_values (project_id, kind, value, sort_order)
select p.id, d.kind, d.value, d.sort_order
  from ship.projects p
  cross join ship.default_taxonomy_rows() d
on conflict (project_id, kind, value) do nothing;

-- ---------------------------------------------------------------------
-- Backfill, part 2: every value a project's line items ALREADY USE, so
-- applying this migration cannot invalidate a single existing row. This
-- is also what R9.1 means by "the state-house project keeps its current
-- values via data migration" -- ANNEX / WEST WING / BULFINCH and
-- 5_250th ANNIVERSARY are not in the generic defaults above, but they
-- land here because federal-campus-master-plan's line items use them.
--
-- sort_order: TIMELINE_PRIORITIES already encodes display order in a
-- leading digit ('5_250th ANNIVERSARY' sorts after '4_FUTURE >20 years'
-- in lib/constants.ts). The regexp pulls that digit out so the migrated
-- taxonomy renders in the exact order the old hardcoded dropdown did.
-- building_area / building_level / category values that show up here
-- (i.e. in use but not already in the defaults from part 1) have no such
-- encoding -- WHOLE BUILDING/ANNEX/WEST WING/EAST WING/BULFINCH/SITE/
-- OTHER * was just constant declaration order, not a meaningful ranking
-- -- so those are appended after the defaults (sort_order 1000+) in
-- alphabetical order, which is at least stable and deterministic.
-- ---------------------------------------------------------------------
insert into ship.project_taxonomy_values (project_id, kind, value, sort_order)
select v.project_id, v.kind, v.value,
       coalesce(
         (regexp_match(v.value, '^([0-9]+)_'))[1]::integer,
         1000 + dense_rank() over (partition by v.project_id, v.kind order by v.value)
       )
  from (
    select distinct project_id, 'building_area' as kind, building_area_impacted as value
      from ship.line_items
    union all
    select distinct project_id, 'building_level', building_level_impacted
      from ship.line_items
    union all
    select distinct project_id, 'category', category
      from ship.line_items
    union all
    select distinct project_id, 'timeline_priority', timeline_priority
      from ship.line_items
  ) v
on conflict (project_id, kind, value) do nothing;

-- ---------------------------------------------------------------------
-- Grants
-- Same two-part rule as 0002/0006/0007: RLS filters, GRANT authorises.
-- ---------------------------------------------------------------------
grant select                 on ship.project_taxonomy_values to authenticated;
grant insert, update, delete on ship.project_taxonomy_values to authenticated;

alter table ship.project_taxonomy_values enable row level security;

-- ---------------------------------------------------------------------
-- Policies
--
-- Read: anyone who can read the project -- a consultant needs to see the
-- vocabulary to fill out the form at all, exactly like project_cost_settings
-- in 0006.
--
-- Write: ship.is_admin() ONLY, for now.
--
-- >>> 0009 WIDENS THIS. When per-project roles land, these three write
-- >>> policies become `editor or admin on this project`. They are the
-- >>> only thing to change -- swap ship.is_admin() for the project-role
-- >>> helper in the USING and WITH CHECK, and leave the select policy
-- >>> alone. Until then a global admin is the only writer, which is
-- >>> strictly narrower than the end state and therefore safe.
--
-- Every UPDATE policy carries a WITH CHECK mirroring its USING. Without
-- it, a writer could move a taxonomy row to another project by updating
-- project_id: USING passes (the row is currently in a project they can
-- write to) and the new project_id value is never validated -- the same
-- transplant bug 0006's header calls out for its settings tables.
-- ---------------------------------------------------------------------
drop policy if exists project_taxonomy_values_select on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_insert on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_update on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_delete on ship.project_taxonomy_values;

create policy project_taxonomy_values_select on ship.project_taxonomy_values
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy project_taxonomy_values_insert on ship.project_taxonomy_values
  for insert to authenticated
  with check (ship.is_admin());

create policy project_taxonomy_values_update on ship.project_taxonomy_values
  for update to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

create policy project_taxonomy_values_delete on ship.project_taxonomy_values
  for delete to authenticated
  using (ship.is_admin());

commit;

-- =====================================================================
-- ROLLBACK
--
-- begin;
--   drop policy if exists project_taxonomy_values_select on ship.project_taxonomy_values;
--   drop policy if exists project_taxonomy_values_insert on ship.project_taxonomy_values;
--   drop policy if exists project_taxonomy_values_update on ship.project_taxonomy_values;
--   drop policy if exists project_taxonomy_values_delete on ship.project_taxonomy_values;
--
--   drop trigger  if exists line_items_dd_check_taxonomy on ship.line_items;
--   drop function if exists ship.check_line_item_taxonomy();
--   drop function if exists ship.taxonomy_value_allowed(text, text, text);
--   drop function if exists ship.seed_default_taxonomy(text);
--   drop function if exists ship.default_taxonomy_rows();
--
--   drop table if exists ship.project_taxonomy_values;
--
--   -- Restore the four CHECK constraints exactly as 0001 defined them.
--   -- Only safe if no row has taken on a value outside the original
--   -- hardcoded lists since 0008 was applied -- check first:
--   --   select distinct building_area_impacted from ship.line_items
--   --    where building_area_impacted not in
--   --      ('WHOLE BUILDING','ANNEX','WEST WING','EAST WING','BULFINCH','SITE','OTHER *');
--   -- (repeat for the other three columns before re-adding their CHECKs)
--   alter table ship.line_items
--     add constraint line_items_building_area_impacted_check check (building_area_impacted in (
--       'WHOLE BUILDING','ANNEX','WEST WING','EAST WING','BULFINCH','SITE','OTHER *')),
--     add constraint line_items_building_level_impacted_check check (building_level_impacted in (
--       'WHOLE BUILDING','ROOF','ENVELOPE (EXT. WALLS)','LEVELS ABOVE GRADE',
--       'LEVELS BELOW GRADE','L5','L4','L3','L2','L1','BASEMENT','SUB BASEMENT','OTHER *')),
--     add constraint line_items_category_check check (category in (
--       'END OF LIFE','DEFERRED MAINTENANCE','UPGRADES / IMPROVEMENTS',
--       'RESTORATION *','STUDY / DOCUMENTATION')),
--     add constraint line_items_timeline_priority_check check (timeline_priority in (
--       '0_PRIORITY *','1_HIGH <5 years','2_MID 5-10 years',
--       '3_LOW 10-20 years','4_FUTURE >20 years','5_250th ANNIVERSARY'));
-- commit;
--
-- HOW TO VERIFY (impersonate; the SQL editor / a superuser psql session
-- bypasses RLS entirely, so a query that "works" there proves nothing
-- about the policies -- only about the trigger and the backfill)
--
-- -- Every existing project has values for all four kinds:
-- select project_id, kind, count(*)
--   from ship.project_taxonomy_values
--  group by project_id, kind
--  order by project_id, kind;
--
-- -- Every existing line item's four values are present in its project's
-- -- taxonomy (expect 0 rows):
-- select li.id, li.project_id, 'building_area' as kind, li.building_area_impacted as value
--   from ship.line_items li
--  where not exists (
--    select 1 from ship.project_taxonomy_values v
--     where v.project_id = li.project_id and v.kind = 'building_area'
--       and v.value = li.building_area_impacted)
-- union all
-- select li.id, li.project_id, 'building_level', li.building_level_impacted
--   from ship.line_items li
--  where not exists (
--    select 1 from ship.project_taxonomy_values v
--     where v.project_id = li.project_id and v.kind = 'building_level'
--       and v.value = li.building_level_impacted)
-- union all
-- select li.id, li.project_id, 'category', li.category
--   from ship.line_items li
--  where not exists (
--    select 1 from ship.project_taxonomy_values v
--     where v.project_id = li.project_id and v.kind = 'category'
--       and v.value = li.category)
-- union all
-- select li.id, li.project_id, 'timeline_priority', li.timeline_priority
--   from ship.line_items li
--  where not exists (
--    select 1 from ship.project_taxonomy_values v
--     where v.project_id = li.project_id and v.kind = 'timeline_priority'
--       and v.value = li.timeline_priority);
--
-- -- The trigger refuses a value not in the project's taxonomy (expect 23514):
-- begin;
--   update ship.line_items set building_area_impacted = 'NOT A REAL VALUE'
--    where id = (select id from ship.line_items limit 1);
-- rollback;
--
-- -- The trigger accepts a value that IS in the project's taxonomy:
-- begin;
--   update ship.line_items set building_area_impacted = 'SITE'
--    where id = (select id from ship.line_items limit 1);
--   select building_area_impacted from ship.line_items
--    where id = (select id from ship.line_items limit 1);
--   -- expected: SITE
-- rollback;
--
-- -- A project with an EMPTY taxonomy for a kind accepts anything
-- -- (fail-open):
-- begin;
--   insert into ship.projects (id, name) values ('taxonomy-fail-open-test', 'Fail Open Test');
--   insert into ship.line_items (
--     project_id, user_email, consultant_type, discipline, category, timeline_priority,
--     building_area_impacted, building_level_impacted, operational_impact, benefit_to_users,
--     benefit_to_public, relative_first_cost, relative_operation_cost_impact,
--     relative_operational_energy_usage, electrification_eo594,
--     addressing_resiliency_sustainability, addressing_deferred_maintenance,
--     code_life_safety_improvement, accessibility_improvement, historic_impact
--   ) values (
--     'taxonomy-fail-open-test', 'test@example.com', 'Architecture', 'Architecture',
--     'END OF LIFE', '0_PRIORITY *', 'ANYTHING GOES', 'WHOLE BUILDING', 'NONE', 'NONE',
--     'NONE', '$LOW', 'N/A', 'N/A', 'NONE', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'
--   );
--   -- expected: succeeds -- no ship.project_taxonomy_values row exists yet
--   -- for ('taxonomy-fail-open-test', 'building_area'), so the trigger
--   -- fails open per the comment on ship.taxonomy_value_allowed().
-- rollback;
--
-- -- A consultant reads the taxonomy but cannot change it:
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"<their auth.users id>","email":"planning@atlasmech.com","role":"authenticated"}';
--   select * from ship.project_taxonomy_values;         -- their projects only
--   insert into ship.project_taxonomy_values (project_id, kind, value)
--   values ('federal-campus-master-plan', 'category', 'MADE UP');
--   -- expected: ERROR 42501 (no INSERT policy passes for a non-admin)
-- rollback;
-- =====================================================================
