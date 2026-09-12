-- =====================================================================
-- 003_v2_taxonomy.sql
-- Fixture data for the per-project taxonomy editor (Settings > "Line
-- item vocabularies").
--
-- Runs after 001_seed.sql and 002_v2_phases.sql (glob order), which is
-- what creates ship.projects in the first place.
--
-- WHY THIS IS A SEED AND NOT PART OF MIGRATION 0008
-- --------------------------------------------------
-- 0008 already contains a backfill that gives every existing project the
-- generic defaults from ship.default_taxonomy_rows() plus whatever
-- values its line items already use. On a database with real history
-- that backfill is exactly right. On a fresh one it is a no-op, for the
-- same reason 002_v2_phases.sql exists at all: the Supabase CLI applies
-- migrations BEFORE seeds, so when 0008 runs there are no rows yet in
-- ship.projects for it to join against. This file is the fixture
-- equivalent -- it exists so the taxonomy editor and the Add Data
-- dropdowns have something real to render locally instead of an empty
-- list, and so there is a deterministic subject for manual/visual
-- testing.
--
-- This deliberately does NOT call ship.seed_default_taxonomy(): seeds
-- run as the postgres superuser, where auth.uid() is null, and that
-- function is gated on ship.is_admin() -- calling it here would just
-- raise 42501. Seeds insert directly into the table instead, exactly
-- the way 0008's own backfill does.
--
-- Idempotent: `on conflict do nothing`, safe to re-run.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Every project gets the generic defaults, cross-joined the same way
-- 0008's backfill part 1 does. This alone is enough to make the Settings
-- editor and every Add Data dropdown non-empty for all three fixture
-- projects (federal-campus-master-plan, library-renovation,
-- school-modernization).
-- ---------------------------------------------------------------------
insert into ship.project_taxonomy_values (project_id, kind, value, sort_order)
select p.id, d.kind, d.value, d.sort_order
  from ship.projects p
  cross join ship.default_taxonomy_rows() d
on conflict (project_id, kind, value) do nothing;

-- ---------------------------------------------------------------------
-- PART 2 -- values the seeded line items ALREADY USE.
--
-- Part 1 alone is not enough, and the gap is not cosmetic: 0008 replaced
-- the old CHECK constraints with a trigger (ship.check_line_item_taxonomy)
-- that validates every write against this table. A fixture line item
-- carrying 'ANNEX' -- a State House wing deliberately NOT in the
-- building-agnostic defaults -- becomes UNEDITABLE the moment part 1
-- gives its project a non-empty building_area vocabulary, because the
-- trigger's fail-open clause only applies while a project has ZERO rows
-- for that kind. The symptom is
--   line_items.building_area_impacted: ANNEX is not in this project's taxonomy
-- on any save, including one that never touched that field.
--
-- This mirrors part 2 of 0008's own backfill, which exists for exactly
-- the same reason and is likewise a no-op on a fresh database.
--
-- Sort order copies 0008's rule: a leading "N_" in the value (the
-- timeline_priority convention, '1_HIGH <5 years') is the rank, so those
-- keep their original order; everything else is appended after the
-- defaults at 1000+, alphabetically -- arbitrary, but stable.
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
-- One archived value on federal-campus-master-plan.
--
-- Every other row this file inserts is active, so on a freshly reset
-- database the editor's "N archived / Restore" affordance would have
-- nothing to show and nobody would notice if it broke. 'category' /
-- 'STUDY / DOCUMENTATION' is the pick: the fixture's study phase for
-- this campus is already complete (see 002_v2_phases.sql's phase
-- layout), so a firm using this tool for real would plausibly stop
-- OFFERING that category on new line items going forward -- which is
-- exactly what archiving means (0008's column comment: it hides a value
-- from new dropdown selections without touching line items that already
-- carry it). The seeded line items still use 'STUDY / DOCUMENTATION'
-- (see 001_seed.sql), so this also exercises archiving a value that is
-- actively in use, not just an unused one.
-- ---------------------------------------------------------------------
update ship.project_taxonomy_values
   set is_archived = true
 where project_id = 'federal-campus-master-plan'
   and kind = 'category'
   and value = 'STUDY / DOCUMENTATION';

commit;
