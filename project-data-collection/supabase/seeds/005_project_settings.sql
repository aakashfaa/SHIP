-- =====================================================================
-- 005_project_settings.sql
-- Every seeded project gets its cost and energy settings rows.
--
-- Runs after 002 (glob order), which gives federal-campus-master-plan its
-- hand-tuned cost/energy settings; this only fills in what is missing.
--
-- WHY THIS IS A SEED AND NOT ONLY MIGRATION 0018
-- ----------------------------------------------
-- 0018 makes create_project() insert these rows and backfills every
-- existing project. On a fresh database that backfill is a no-op: the CLI
-- applies migrations before seeds, so there are no projects yet -- the
-- same reason 002/003/004 exist. Without this file, library-renovation
-- and school-modernization would have no cost-settings row on a reset
-- database, which is precisely the state M-25 removed (the app would
-- have to invent a base year from the viewer's clock).
--
-- Years come from projects.created_at, the same rule as 0018's backfill.
-- Idempotent: ON CONFLICT DO NOTHING.
-- =====================================================================

begin;

insert into ship.project_cost_settings (project_id, base_year)
select p.id, extract(year from p.created_at)::integer
  from ship.projects p
on conflict (project_id) do nothing;

insert into ship.project_energy_settings (project_id)
select p.id
  from ship.projects p
on conflict (project_id) do nothing;

commit;
