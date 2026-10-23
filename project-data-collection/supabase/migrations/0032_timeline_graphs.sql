-- =====================================================================
-- 0032_timeline_graphs.sql
-- SHIP -- the energy chart under the Timeline becomes one of any number
-- of user-defined graphs, each fed by a line-item column of the user's
-- choosing, in a colour of the user's choosing.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0031: everything in `ship`, no extensions,
-- one transaction. Additive only -- nothing earlier is edited, and
-- project_energy_settings is left exactly where it is.
--
-- WHY
-- ---
-- Megan, after the energy chart shipped:
--   "similar to the energy reduction graph that shows up on the timeline,
--    would it be possible to add a parameter for carbon reduction that
--    can be tracked on a separate graph right below energy? It could be a
--    different color (blue maybe?)."
--
-- The owner's instruction generalised it:
--   "Similarly allow them to create graphs from any column they want. For
--    one example they want to do that for carbon reduction too. The
--    parameter for that will also be there so let them set that up
--    manually. Even the energy: make it so that, essentially, they set it
--    up in the timeline setting."
--
-- So the graph is no longer a hardcoded "energy" thing with one settings
-- row per project. It is a ROW: a label, the line-item column it sums, a
-- unit, an optional baseline, an interaction factor and a colour. Energy
-- is simply the first of them, seeded from the settings it had before.
--
-- WHAT THIS ADDS
-- --------------
-- ship.project_graphs, one row per graph drawn under a project's Timeline,
-- in sort_order. The engine (lib/cost-model.ts computeMetricSeries) treats
-- every graph the way it treated energy: per package, sum the column over
-- the package's line items times their package quantity, de-rate by the
-- interaction factor, and step the total in when the package's last
-- construction phase finishes.
--
-- source_key
--   Which line-item value the graph sums. Either a numeric BUILT-IN
--   column (annual_energy_savings, annual_cost_savings, or
--   estimated_first_cost via its trigger-maintained ecc_amount) or the
--   key of a CUSTOM form field (0012) whose input type is number or
--   currency -- e.g. an "Annual carbon reduction (MTCO2e)" field an admin
--   adds in the form builder. Deliberately NOT a foreign key to
--   form_fields: built-ins are columns, not field rows the graph could
--   own, and deleting a custom field must not silently delete a graph
--   someone set up (the app shows "this column no longer exists" and
--   lets them repoint it). The CHECK only pins the key's shape -- the
--   same shape form_fields.key has -- and the app decides which keys are
--   numeric, because that is a property of the form, which changes.
--
-- unit_label / baseline_annual / interaction_factor
--   Same meaning, same constraints and same reasoning as their
--   project_energy_settings namesakes (0006): free-text unit, nullable
--   baseline (without one the chart plots cumulative reduction from
--   zero), and an honest single de-rate in (0, 2]. The unit may be blank
--   here -- a count of something has no unit -- where energy's could not.
--
-- color
--   '#rrggbb', stored lower-case (a trigger normalises; the CHECK pins the
--   result). Validated rather than free text because it is interpolated
--   into SVG attributes on every viewer's screen.
--
-- SEEDING -- "nothing visibly changes"
-- ------------------------------------
-- Every existing project gets one graph, "Energy reduction", summing
-- annual_energy_savings, with its project_energy_settings unit, baseline
-- and interaction factor, in #059669 -- the exact green the chart has
-- always been drawn in (components/project-workspace/timeline).
--
-- New projects and freshly seeded databases get the same graph through
-- a trigger on project_energy_settings INSERT, rather than by redefining
-- create_project() again: create_project() (0024) inserts that row, and
-- so do supabase/seeds/002 (federal-campus, with its 12.5M baseline and
-- 0.90 factor) and 005 (everyone else). On `db reset` the migrations run
-- before the seeds, so a backfill alone would seed nothing there; the
-- trigger catches the seeds' inserts with their real values. It only
-- fires when the project has no graph yet.
--
-- Re-running this file re-seeds only projects that have NO graphs at all
-- (a project whose editors deliberately deleted every graph would get
-- Energy back on a re-run; that is the one non-idempotent edge, and
-- re-running a migration against live data is not something we do).
--
-- project_energy_settings: LEFT IN PLACE, NO LONGER READ BY THE APP.
-- The Timeline, the Cost model popup and the Excel export all read
-- project_graphs from this migration on. The old table is kept (and
-- create_project keeps filling it) because it is the seed source above,
-- because dropping a table is not additive, and because a rollback of the
-- app to the previous build must still find it. Edits to graphs are NOT
-- written back to it. A later cleanup migration may drop it together
-- with the trigger below.
--
-- WHO MAY READ / WRITE
-- --------------------
-- Exactly project_energy_settings' rules as 0009 widened them:
--   read  -- anyone who can read the project (my_project_ids), viewers
--            included: the graphs are drawn for them.
--   write -- project admin + editor (can_edit_project /
--            my_editable_project_ids) and platform admins.
-- Graphs are project-wide, never per what-if / version: they describe
-- what a package delivers, not when it is scheduled.
--
-- Grants: authenticated gets select/insert/update/delete (RLS then
-- filters); anon and public get nothing.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Table.
-- ---------------------------------------------------------------------
create table if not exists ship.project_graphs (
  id                 uuid primary key default gen_random_uuid(),
  project_id         text not null
                       references ship.projects(id) on delete cascade,
  label              text not null
                       check (btrim(label) <> '' and char_length(label) <= 80),
  source_key         text not null
                       check (source_key ~ '^[a-z][a-z0-9_]*$' and char_length(source_key) <= 63),
  unit_label         text not null default ''
                       check (char_length(unit_label) <= 40),
  baseline_annual    numeric
                       check (baseline_annual is null or baseline_annual >= 0),
  interaction_factor numeric not null default 1.0
                       check (interaction_factor > 0 and interaction_factor <= 2),
  color              text not null default '#059669'
                       check (color ~ '^#[0-9a-f]{6}$'),
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references ship.profiles(id) on delete set null
);

create index if not exists project_graphs_project_sort_idx
  on ship.project_graphs (project_id, sort_order);

comment on table ship.project_graphs is
  'Graphs drawn under a project''s Timeline (0032). Each sums one numeric line-item value (source_key: a built-in column or a custom number/currency form field key) per package, steps it in when the package''s construction finishes, and draws it in `color`. Supersedes project_energy_settings, which the app no longer reads.';
comment on column ship.project_graphs.source_key is
  'Built-in numeric column (annual_energy_savings, annual_cost_savings, estimated_first_cost) or a custom form_fields.key of input type number/currency. Not a foreign key on purpose -- see 0032.';
comment on column ship.project_graphs.interaction_factor is
  'De-rate for interactive effects between measures, as project_energy_settings.interaction_factor (0006). 1.00 = values taken as summed.';
comment on column ship.project_graphs.color is
  'Line colour, #rrggbb lower-case. Normalised by ship.normalise_project_graph().';

-- ---------------------------------------------------------------------
-- 2. Normalise colour, keep updated_at / updated_by honest.
-- ---------------------------------------------------------------------
create or replace function ship.normalise_project_graph()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.color      := lower(btrim(new.color));
  new.label      := btrim(new.label);
  new.unit_label := btrim(new.unit_label);
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    new.created_at := old.created_at;
    new.id         := old.id;
    new.project_id := old.project_id;   -- a graph never moves project
  end if;
  -- Who changed it is the signed-in caller, not whatever the client sent.
  -- Looked up rather than assumed, so a caller without a profile row (seed
  -- SQL, service role) leaves it as given instead of failing the FK.
  new.updated_by := coalesce(
    (select p.id from ship.profiles p where p.id = auth.uid()),
    case when auth.uid() is null then new.updated_by end);
  return new;
end;
$$;

revoke all on function ship.normalise_project_graph() from public, anon, authenticated;

drop trigger if exists project_graphs_normalise on ship.project_graphs;
create trigger project_graphs_normalise
  before insert or update on ship.project_graphs
  for each row execute function ship.normalise_project_graph();

-- ---------------------------------------------------------------------
-- 3. Grants + RLS (0009's project_energy_settings rules).
-- ---------------------------------------------------------------------
revoke all on ship.project_graphs from public, anon, authenticated;
grant select, insert, update, delete on ship.project_graphs to authenticated;
grant select on ship.project_graphs to service_role;

alter table ship.project_graphs enable row level security;

drop policy if exists project_graphs_select on ship.project_graphs;
drop policy if exists project_graphs_insert on ship.project_graphs;
drop policy if exists project_graphs_update on ship.project_graphs;
drop policy if exists project_graphs_delete on ship.project_graphs;

create policy project_graphs_select on ship.project_graphs
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy project_graphs_insert on ship.project_graphs
  for insert to authenticated
  with check (ship.can_edit_project(project_id));

create policy project_graphs_update on ship.project_graphs
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy project_graphs_delete on ship.project_graphs
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

-- ---------------------------------------------------------------------
-- 4. New projects / seeded databases: the Energy graph, from the energy
--    settings row as it is inserted. SECURITY DEFINER because the row
--    can be inserted by create_project() (itself definer) or by seed SQL
--    running as postgres; either way the graph is the project's default,
--    not something the caller is choosing.
-- ---------------------------------------------------------------------
create or replace function ship.seed_energy_graph()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into ship.project_graphs
    (project_id, label, source_key, unit_label, baseline_annual,
     interaction_factor, color, sort_order, updated_by)
  select new.project_id, 'Energy reduction', 'annual_energy_savings',
         left(new.unit_label, 40), new.baseline_annual,
         new.interaction_factor, '#059669', 0, new.updated_by
   where not exists (select 1 from ship.project_graphs g where g.project_id = new.project_id);
  return new;
end;
$$;

revoke all on function ship.seed_energy_graph() from public, anon, authenticated;

drop trigger if exists project_energy_settings_seed_graph on ship.project_energy_settings;
create trigger project_energy_settings_seed_graph
  after insert on ship.project_energy_settings
  for each row execute function ship.seed_energy_graph();

-- ---------------------------------------------------------------------
-- 5. Backfill every existing project. From its energy settings where it
--    has them; a project somehow without a settings row still gets the
--    graph, with 0006's defaults.
-- ---------------------------------------------------------------------
insert into ship.project_graphs
  (project_id, label, source_key, unit_label, baseline_annual,
   interaction_factor, color, sort_order, updated_by)
select p.id, 'Energy reduction', 'annual_energy_savings',
       left(coalesce(e.unit_label, 'kBtu/yr'), 40), e.baseline_annual,
       coalesce(e.interaction_factor, 1.0), '#059669', 0, e.updated_by
  from ship.projects p
  left join ship.project_energy_settings e on e.project_id = p.id
 where not exists (select 1 from ship.project_graphs g where g.project_id = p.id);

commit;

-- ---------------------------------------------------------------------
-- ROLLBACK (manual)
--   drop trigger if exists project_energy_settings_seed_graph on ship.project_energy_settings;
--   drop function if exists ship.seed_energy_graph();
--   drop table if exists ship.project_graphs;
--   drop function if exists ship.normalise_project_graph();
-- project_energy_settings is untouched, so the previous build works as is.
-- ---------------------------------------------------------------------
