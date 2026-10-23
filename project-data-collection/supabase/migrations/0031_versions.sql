-- =====================================================================
-- 0031_versions.sql
-- SHIP -- the Timeline's "What if" becomes "Versions": several peer
-- versions of the plan, each with its own schedule and cost model, all
-- sharing the same packages and line items.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0030. Local stack only; not applied remotely.
-- Re-runnable: `if not exists`, `create or replace`, guarded backfills.
--
-- WHAT THE OWNER ASKED FOR
-- ------------------------
--   "Now we want to change the 'What If' (try a 'What If' inside our
--    timeline) to be 'Different Versions.' Each version can have a
--    different cost model but they will have the same packages and line
--    items so they can be saved and changed."
--
-- And, from the follow-up Q&A:
--   * "All equal, pick on export": no version is special in the UI. Every
--     version is a peer; an export asks which one to use.
--   * "Whole team": every project member sees every version. Admins and
--     editors create, rename, duplicate, edit and delete them; consultants
--     and viewers switch between them read-only.
--
-- WHAT A VERSION IS
-- -----------------
-- Everything that differs between two alternatives of the plan:
--   * the package phases -- start / duration (months), % of TPC, and the
--     phase names / kinds the Cost model's phase template produces;
--   * the phase dependencies;
--   * the cost model: ship.project_cost_settings (TPC factor, base year,
--     escalation, phase template) and ship.escalation_rate_overrides.
-- SHARED by every version: packages (chunk_projects), what is in them
-- (chunk_project_items), line items, timeline length / fiscal settings,
-- and the energy / graph settings (project-wide; see 0032).
--
-- WHY THE 0010 SNAPSHOT DESIGN IS KEPT
-- ------------------------------------
-- 0010 explains why a what-if is a jsonb snapshot overlaid on the live
-- rows rather than a `scenario_id` column on chunk_phases and the settings
-- tables: the first rollup that forgets `where scenario_id = ...` silently
-- double-counts, and this product's whole job is totals handed to a state
-- agency. Nothing about peer versions changes that argument, so:
--
--   * ONE version lives in the ordinary tables (chunk_phases,
--     phase_dependencies, project_cost_settings, escalation_rate_overrides)
--     exactly as before. Its name is `projects.live_version_name`
--     (default 'Version 1'). Every other screen and query that reads those
--     tables -- Packaging, Master View, anything added later -- keeps
--     working unchanged and sees that version.
--   * EVERY OTHER version is a ship.scenarios row (table and function
--     names kept to limit churn; "scenario" = "version" from here on) whose
--     payload carries its own phases, dependencies, cost settings and rate
--     overrides, and is overlaid on the live rows in memory -- by the same
--     pure function on the client (Timeline) and the server (Excel export),
--     lib/cost-model.ts `applyVersionOverlay`.
--
-- The UI does not show which version is "in the tables"; it is an
-- implementation detail. That is what makes deleting it work like deleting
-- any other version: ship.delete_version() promotes another version into
-- the tables and removes that version's snapshot, in one transaction.
--
-- PAYLOAD (payload_version = 2)
-- -----------------------------
--   { "phases":         [ {id, chunk_project_id, template_step_id, name, kind,
--                          sort_order, pct_of_tpc, start_slot,
--                          duration_slots, duration_locked}, ... ],
--     "dependencies":   [ {id, predecessor_phase_id, successor_phase_id,
--                          dep_type, lag_slots}, ... ],
--     "cost_settings":  { tpc_factor, base_year, escalation_mode,
--                         escalation_annual_percent, escalation_step_years,
--                         escalation_basis, escalation_confidence_years,
--                         default_phase_template_id },
--     "rate_overrides": [ {year_offset, rate_percent}, ... ] }
--
--   start_slot / duration_slots / lag_slots are MONTHS (0020 kept the key
--   names). Phases are held PER PACKAGE: if the payload has any phase for a
--   package, those phases ARE that package in this version (its structure
--   may differ from the live one after a phase-template change); a package
--   with no phases in the payload -- one created after the version was --
--   falls back to its live phases until it is edited in this version, at
--   which point its phases are copied in. Phases of packages that no longer
--   exist are ignored (and dropped on the next write).
--
-- WHAT GOES AWAY
-- --------------
-- The Revit-style branch / publish / rebase flow: there is no "central
-- model" among peers, so a baseline fingerprint, a 3-way rebase and a
-- publish-with-conflict have nothing to protect. publish_scenario(),
-- rebase_scenario(), save_scenario_payload(), create_scenario() and the
-- client-callable baseline_fingerprint() are DROPPED (nothing calls them
-- any more, and publish/save_scenario_payload carried the old per-owner
-- rules). schedule_snapshot() / schedule_fingerprint() stay as internal,
-- ungranted helpers. Scenarios that were already PUBLISHED under the old
-- flow are history, not versions: they are left in the table untouched,
-- hidden by the client, and refused by every RPC below.
--
-- PERMISSIONS
-- -----------
--   read:   any project member (ship.can_read_project) -- RLS select.
--   write:  admin / editor (ship.can_edit_project), RPCs only. The table
--           grants authenticated SELECT and nothing else: no INSERT (as in
--           0010), and UPDATE / DELETE are revoked -- the old owner-only
--           policies are dropped with them.
--   anon:   nothing.
-- Every RPC is SECURITY DEFINER with the permission check done first, and
-- every write is scoped to the version's project.
--
-- CONTRACT
--   ship.create_version(p_project_id text, p_name text,
--                       p_source_scenario_id uuid default null)
--     -> ship.scenarios. Copies the live version (source null) or the
--        given version (fallback packages filled in from live).
--   ship.rename_version(p_project_id text, p_scenario_id uuid, p_name text)
--     -> void. p_scenario_id null renames the live version.
--   ship.delete_version(p_project_id text, p_scenario_id uuid,
--                       p_promote_scenario_id uuid default null) -> jsonb
--     p_scenario_id null deletes the live version: p_promote_scenario_id
--     (default: the most recently edited version) is written into the live
--     tables and its snapshot removed. Refused (22023) when it is the last
--     version. Returns {deleted, promoted_scenario_id, live_version_name}.
--   ship.save_version_phases(p_scenario_id uuid, p_phases jsonb)
--     -> ship.scenarios. p_phases: complete phase lists for one or more
--        packages (payload phase shape); each listed package's phases are
--        replaced by the ones given. Validated like replace_chunk_phases
--        (0025).
--   ship.save_version_cost_settings(p_scenario_id uuid, p_settings jsonb,
--                                   p_rate_overrides jsonb)
--     -> ship.scenarios. p_settings: any subset of the cost_settings keys,
--        merged in; p_rate_overrides: the complete new list, or null to
--        leave it alone.
--   Errors: 42501 no edit access, 42704 unknown version, 22023 bad input
--   or a published (historic) what-if.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. The live version's name.
-- ---------------------------------------------------------------------
alter table ship.projects
  add column if not exists live_version_name text not null default 'Version 1';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_live_version_name_check') then
    alter table ship.projects
      add constraint projects_live_version_name_check
      check (btrim(live_version_name) <> '' and length(live_version_name) <= 120);
  end if;
end $$;

comment on column ship.projects.live_version_name is
  'Name of the version whose schedule and cost model are stored in the ordinary tables (chunk_phases, phase_dependencies, project_cost_settings, escalation_rate_overrides). Every other version is a ship.scenarios row. See migration 0031.';

-- ---------------------------------------------------------------------
-- 2. Internal helpers (no client grant).
-- ---------------------------------------------------------------------

-- The live cost model, in payload shape.
create or replace function ship.version_cost_snapshot(p_project_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'cost_settings', coalesce((
      select jsonb_build_object(
               'tpc_factor',                  s.tpc_factor,
               'base_year',                   s.base_year,
               'escalation_mode',             s.escalation_mode,
               'escalation_annual_percent',   s.escalation_annual_percent,
               'escalation_step_years',       s.escalation_step_years,
               'escalation_basis',            s.escalation_basis,
               'escalation_confidence_years', s.escalation_confidence_years,
               'default_phase_template_id',   s.default_phase_template_id)
        from ship.project_cost_settings s
       where s.project_id = p_project_id
    ), '{}'::jsonb),
    'rate_overrides', coalesce((
      select jsonb_agg(jsonb_build_object(
               'year_offset',  o.year_offset,
               'rate_percent', o.rate_percent) order by o.year_offset)
        from ship.escalation_rate_overrides o
       where o.project_id = p_project_id
    ), '[]'::jsonb)
  )
$$;

revoke all on function ship.version_cost_snapshot(text) from public, anon, authenticated;

-- The live phases of a project in payload shape (with template_step_id,
-- which 0015's schedule_snapshot does not carry).
create or replace function ship.version_live_phases(p_project_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',               p.id,
           'chunk_project_id', p.chunk_project_id,
           'template_step_id', p.template_step_id,
           'name',             p.name,
           'kind',             p.kind,
           'sort_order',       p.sort_order,
           'pct_of_tpc',       p.pct_of_tpc,
           'start_slot',       p.start_slot,
           'duration_slots',   p.duration_slots,
           'duration_locked',  p.duration_locked
         ) order by p.chunk_project_id, p.sort_order, p.id), '[]'::jsonb)
    from ship.chunk_phases p
    join ship.chunk_projects c on c.id = p.chunk_project_id
   where c.project_id = p_project_id
$$;

revoke all on function ship.version_live_phases(text) from public, anon, authenticated;

-- A payload made complete against the CURRENT live rows:
--   * phases of packages that no longer exist are dropped;
--   * every package with no phases in the payload gets its live phases;
--   * dependencies are the payload's (both ends present) plus live links
--     between two fallback phases;
--   * a missing cost_settings / rate_overrides is filled in from live.
-- Used when duplicating a version and before the live tables change hands
-- (delete_version), so no version's fallback packages shift underneath it.
create or replace function ship.materialize_version_payload(p_project_id text, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_phases jsonb;
  v_links  jsonb;
  v_cost   jsonb := ship.version_cost_snapshot(p_project_id);
begin
  with chunks as (
    select c.id from ship.chunk_projects c where c.project_id = p_project_id
  ),
  kept as (
    select e
      from jsonb_array_elements(coalesce(p_payload -> 'phases', '[]'::jsonb)) e
     where (e ->> 'chunk_project_id') in (select id::text from chunks)
  ),
  covered as (
    select distinct e ->> 'chunk_project_id' as chunk_id from kept
  ),
  fallback as (
    select e
      from jsonb_array_elements(ship.version_live_phases(p_project_id)) e
     where (e ->> 'chunk_project_id') not in (select chunk_id from covered)
  )
  select coalesce(jsonb_agg(x.e order by x.e ->> 'chunk_project_id',
                                         (x.e ->> 'sort_order')::numeric,
                                         x.e ->> 'id'), '[]'::jsonb)
    into v_phases
    from (select e from kept union all select e from fallback) x;

  with ids as (
    select e ->> 'id' as id from jsonb_array_elements(v_phases) e
  ),
  fallback_ids as (
    select e ->> 'id' as id
      from jsonb_array_elements(v_phases) e
     where (e ->> 'chunk_project_id') not in (
       select p ->> 'chunk_project_id'
         from jsonb_array_elements(coalesce(p_payload -> 'phases', '[]'::jsonb)) p)
  ),
  payload_links as (
    select e
      from jsonb_array_elements(coalesce(p_payload -> 'dependencies', '[]'::jsonb)) e
     where (e ->> 'predecessor_phase_id') in (select id from ids)
       and (e ->> 'successor_phase_id')   in (select id from ids)
  ),
  live_links as (
    select jsonb_build_object(
             'id',                   d.id,
             'predecessor_phase_id', d.predecessor_phase_id,
             'successor_phase_id',   d.successor_phase_id,
             'dep_type',             d.dep_type,
             'lag_slots',            d.lag_slots) as e
      from ship.phase_dependencies d
     where d.project_id = p_project_id
       and d.predecessor_phase_id::text in (select id from fallback_ids)
       and d.successor_phase_id::text   in (select id from fallback_ids)
       and d.id::text not in (select e ->> 'id' from payload_links)
  )
  select coalesce(jsonb_agg(x.e order by x.e ->> 'id'), '[]'::jsonb)
    into v_links
    from (select e from payload_links union all select e from live_links) x;

  return coalesce(p_payload, '{}'::jsonb)
         || jsonb_build_object(
              'phases',         v_phases,
              'dependencies',   v_links,
              'cost_settings',
                case when jsonb_typeof(p_payload -> 'cost_settings') = 'object'
                      and p_payload -> 'cost_settings' <> '{}'::jsonb
                     then (v_cost -> 'cost_settings') || (p_payload -> 'cost_settings')
                     else v_cost -> 'cost_settings' end,
              'rate_overrides',
                case when jsonb_typeof(p_payload -> 'rate_overrides') = 'array'
                     then p_payload -> 'rate_overrides'
                     else v_cost -> 'rate_overrides' end);
end;
$$;

revoke all on function ship.materialize_version_payload(text, jsonb) from public, anon, authenticated;

-- Loads a version for writing: exists, not a historic published what-if,
-- and the caller may edit its project. Locks the row.
create or replace function ship.version_for_write(p_scenario_id uuid, p_context text)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
begin
  select * into v_scenario from ship.scenarios where id = p_scenario_id for update;

  -- An unknown version and one in a project you cannot read look the same.
  if not found or not coalesce(ship.can_read_project(v_scenario.project_id), false) then
    raise exception '%: no such version', p_context using errcode = '42704';
  end if;

  if not coalesce(ship.can_edit_project(v_scenario.project_id), false) then
    raise exception '%: only project admins and editors can change versions', p_context
      using errcode = '42501';
  end if;

  if v_scenario.published_at is not null then
    raise exception '%: this is a published what-if from before versions, not a version', p_context
      using errcode = '22023';
  end if;

  return v_scenario;
end;
$$;

revoke all on function ship.version_for_write(uuid, text) from public, anon, authenticated;

-- Shared input check for a version name.
create or replace function ship.version_name_or_raise(p_name text, p_context text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_name is null or btrim(p_name) = '' or length(btrim(p_name)) > 120 then
    raise exception '%: a version name must be 1-120 characters', p_context
      using errcode = '22023';
  end if;
  return btrim(p_name);
end;
$$;

revoke all on function ship.version_name_or_raise(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Existing what-ifs become versions.
--    * project-visible (the whole team sees every version);
--    * cost model filled in: a pre-0031 what-if's cost_settings were a
--      snapshot nobody could edit and the Timeline never used -- it priced
--      every what-if with the LIVE cost model. Copying the live cost model
--      in keeps every existing what-if priced exactly as it was.
--    Guarded on payload_version so a re-run does not overwrite edits.
-- ---------------------------------------------------------------------
alter table ship.scenarios disable trigger scenarios_touch_updated_at;

update ship.scenarios s
   set visibility      = 'project',
       payload         = s.payload || ship.version_cost_snapshot(s.project_id),
       payload_version = 2
 where s.payload_version < 2
   and s.published_at is null;

update ship.scenarios s
   set visibility = 'project'
 where s.visibility <> 'project';

alter table ship.scenarios enable trigger scenarios_touch_updated_at;

alter table ship.scenarios alter column visibility set default 'project';
alter table ship.scenarios alter column payload_version set default 2;

comment on column ship.scenarios.payload is
  'A version''s own schedule and cost model (payload_version 2, migration 0031): phases (per package; start_slot / duration_slots in MONTHS), dependencies (lag_slots in MONTHS), cost_settings, rate_overrides. Written only by the version RPCs.';

-- ---------------------------------------------------------------------
-- 4. The old what-if flow goes.
-- ---------------------------------------------------------------------
drop function if exists ship.publish_scenario(uuid);
drop function if exists ship.rebase_scenario(uuid);
drop function if exists ship.save_scenario_payload(uuid, jsonb, jsonb);
drop function if exists ship.create_scenario(text, text, text);
drop function if exists ship.baseline_fingerprint(text);

-- ---------------------------------------------------------------------
-- 5. Grants + RLS: whole team reads, RPCs write.
-- ---------------------------------------------------------------------
revoke all on ship.scenarios from anon;
revoke insert, update, delete on ship.scenarios from authenticated;
grant select on ship.scenarios to authenticated;

drop policy if exists scenarios_select      on ship.scenarios;
drop policy if exists scenarios_update_own  on ship.scenarios;
drop policy if exists scenarios_delete_own  on ship.scenarios;

create policy scenarios_select on ship.scenarios
  for select to authenticated
  using (ship.can_read_project(project_id));

-- ---------------------------------------------------------------------
-- 6. create_version
-- ---------------------------------------------------------------------
create or replace function ship.create_version(
  p_project_id         text,
  p_name               text,
  p_source_scenario_id uuid default null
)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    text := ship.current_email();
  v_name     text;
  v_payload  jsonb;
  v_source   ship.scenarios;
  v_scenario ship.scenarios;
begin
  if v_email is null or not coalesce(ship.can_edit_project(p_project_id), false) then
    raise exception 'create_version: only project admins and editors can create versions'
      using errcode = '42501';
  end if;

  v_name := ship.version_name_or_raise(p_name, 'create_version');

  if p_source_scenario_id is null then
    -- A copy of the version in the live tables.
    v_payload := jsonb_build_object('phases', '[]'::jsonb, 'dependencies', '[]'::jsonb);
  else
    select * into v_source
      from ship.scenarios
     where id = p_source_scenario_id
       and project_id = p_project_id
       and published_at is null;
    if not found then
      raise exception 'create_version: no such version to copy' using errcode = '42704';
    end if;
    v_payload := v_source.payload;
  end if;

  -- Materialising an empty payload yields the complete live version.
  v_payload := ship.materialize_version_payload(p_project_id, v_payload);

  insert into ship.scenarios (project_id, name, description, owner_email, visibility,
                              payload, payload_version, base_payload, baseline_fingerprint)
  values (p_project_id, v_name, '', v_email, 'project',
          v_payload, 2, ship.schedule_snapshot(p_project_id), '')
  returning * into v_scenario;

  return v_scenario;
end;
$$;

revoke all on function ship.create_version(text, text, uuid) from public, anon;
grant execute on function ship.create_version(text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. rename_version
-- ---------------------------------------------------------------------
create or replace function ship.rename_version(
  p_project_id  text,
  p_scenario_id uuid,
  p_name        text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name     text;
  v_scenario ship.scenarios;
begin
  v_name := ship.version_name_or_raise(p_name, 'rename_version');

  if p_scenario_id is null then
    if not coalesce(ship.can_edit_project(p_project_id), false) then
      raise exception 'rename_version: only project admins and editors can rename versions'
        using errcode = '42501';
    end if;
    update ship.projects set live_version_name = v_name where id = p_project_id;
    return;
  end if;

  v_scenario := ship.version_for_write(p_scenario_id, 'rename_version');
  if v_scenario.project_id <> p_project_id then
    raise exception 'rename_version: no such version' using errcode = '42704';
  end if;

  update ship.scenarios set name = v_name where id = p_scenario_id;
end;
$$;

revoke all on function ship.rename_version(text, uuid, text) from public, anon;
grant execute on function ship.rename_version(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. delete_version (and promotion of a version into the live tables)
-- ---------------------------------------------------------------------
create or replace function ship.delete_version(
  p_project_id          text,
  p_scenario_id         uuid,
  p_promote_scenario_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
  v_promote  ship.scenarios;
  v_payload  jsonb;
  v_cost     jsonb;
  v_template uuid;
  v_name     text;
begin
  if not coalesce(ship.can_edit_project(p_project_id), false) then
    raise exception 'delete_version: only project admins and editors can delete versions'
      using errcode = '42501';
  end if;

  -- Serialise version deletes per project: two people deleting the last
  -- two versions at once must not both succeed.
  perform 1 from ship.projects where id = p_project_id for update;

  if p_scenario_id is not null then
    v_scenario := ship.version_for_write(p_scenario_id, 'delete_version');
    if v_scenario.project_id <> p_project_id then
      raise exception 'delete_version: no such version' using errcode = '42704';
    end if;
    delete from ship.scenarios where id = p_scenario_id;
    select live_version_name into v_name from ship.projects where id = p_project_id;
    return jsonb_build_object('deleted', p_scenario_id,
                              'promoted_scenario_id', null,
                              'live_version_name', v_name);
  end if;

  -- Deleting the version that lives in the tables: another one moves in.
  if p_promote_scenario_id is not null then
    select * into v_promote from ship.scenarios
     where id = p_promote_scenario_id and project_id = p_project_id and published_at is null
     for update;
  else
    select * into v_promote from ship.scenarios
     where project_id = p_project_id and published_at is null
     order by updated_at desc, created_at desc
     limit 1
     for update;
  end if;

  if v_promote.id is null then
    if p_promote_scenario_id is not null then
      raise exception 'delete_version: no such version to switch to' using errcode = '42704';
    end if;
    raise exception 'delete_version: a project needs at least one version; this is the last one'
      using errcode = '22023';
  end if;

  -- 1. Freeze every OTHER version's fallback packages at the current live
  --    phases before the live rows change hands, so deleting one version
  --    never moves a bar in another.
  update ship.scenarios s
     set payload = ship.materialize_version_payload(p_project_id, s.payload)
   where s.project_id = p_project_id
     and s.published_at is null
     and s.id <> v_promote.id;

  v_payload := ship.materialize_version_payload(p_project_id, v_promote.payload);

  -- 2. Phases: replace the project's phases with the version's. Links go
  --    with the old phases (ON DELETE CASCADE) and are re-created below.
  delete from ship.chunk_phases p
   using ship.chunk_projects c
   where c.id = p.chunk_project_id
     and c.project_id = p_project_id;

  insert into ship.chunk_phases
    (id, chunk_project_id, template_step_id, name, kind, sort_order,
     pct_of_tpc, start_slot, duration_slots, duration_locked)
  select (e ->> 'id')::uuid,
         (e ->> 'chunk_project_id')::uuid,
         case when jsonb_typeof(e -> 'template_step_id') = 'string'
               and exists (select 1 from ship.phase_template_steps t
                            where t.id = (e ->> 'template_step_id')::uuid)
              then (e ->> 'template_step_id')::uuid end,
         coalesce(e ->> 'name', ''),
         coalesce(e ->> 'kind', 'construction'),
         coalesce((e ->> 'sort_order')::numeric, 0)::integer,
         coalesce((e ->> 'pct_of_tpc')::numeric, 0),
         greatest(coalesce((e ->> 'start_slot')::numeric, 0), 0),
         greatest(coalesce((e ->> 'duration_slots')::numeric, 1), 1),
         coalesce((e ->> 'duration_locked')::boolean, false)
    from jsonb_array_elements(v_payload -> 'phases') e
   -- materialize already kept only this project's packages; restated as
   -- the tenant boundary for the write.
   where exists (select 1 from ship.chunk_projects c
                  where c.id = (e ->> 'chunk_project_id')::uuid
                    and c.project_id = p_project_id);

  insert into ship.phase_dependencies
    (id, project_id, predecessor_phase_id, successor_phase_id, dep_type, lag_slots)
  select (e ->> 'id')::uuid,
         p_project_id,
         (e ->> 'predecessor_phase_id')::uuid,
         (e ->> 'successor_phase_id')::uuid,
         coalesce(e ->> 'dep_type', 'FS'),
         coalesce((e ->> 'lag_slots')::numeric, 0)
    from jsonb_array_elements(v_payload -> 'dependencies') e;

  -- 3. Cost model.
  v_cost := v_payload -> 'cost_settings';
  v_template := case when jsonb_typeof(v_cost -> 'default_phase_template_id') = 'string'
                      and exists (select 1 from ship.phase_templates t
                                   where t.id = (v_cost ->> 'default_phase_template_id')::uuid
                                     and (t.project_id is null or t.project_id = p_project_id))
                     then (v_cost ->> 'default_phase_template_id')::uuid end;

  insert into ship.project_cost_settings (project_id) values (p_project_id)
  on conflict (project_id) do nothing;

  update ship.project_cost_settings s
     set tpc_factor                  = coalesce((v_cost ->> 'tpc_factor')::numeric, s.tpc_factor),
         base_year                   = coalesce((v_cost ->> 'base_year')::integer, s.base_year),
         escalation_mode             = coalesce(v_cost ->> 'escalation_mode', s.escalation_mode),
         escalation_annual_percent   = coalesce((v_cost ->> 'escalation_annual_percent')::numeric, s.escalation_annual_percent),
         escalation_step_years       = coalesce((v_cost ->> 'escalation_step_years')::integer, s.escalation_step_years),
         escalation_basis            = coalesce(v_cost ->> 'escalation_basis', s.escalation_basis),
         escalation_confidence_years = coalesce((v_cost ->> 'escalation_confidence_years')::integer, s.escalation_confidence_years),
         default_phase_template_id   = case when v_cost ? 'default_phase_template_id'
                                            then v_template
                                            else s.default_phase_template_id end,
         updated_at                  = now(),
         updated_by                  = auth.uid()
   where s.project_id = p_project_id;

  delete from ship.escalation_rate_overrides where project_id = p_project_id;
  insert into ship.escalation_rate_overrides (project_id, year_offset, rate_percent)
  select p_project_id, (e ->> 'year_offset')::integer, (e ->> 'rate_percent')::numeric
    from jsonb_array_elements(coalesce(v_payload -> 'rate_overrides', '[]'::jsonb)) e;

  -- 4. The promoted version is now the one in the tables.
  update ship.projects set live_version_name = v_promote.name where id = p_project_id;
  delete from ship.scenarios where id = v_promote.id;

  return jsonb_build_object('deleted', null,
                            'promoted_scenario_id', v_promote.id,
                            'live_version_name', v_promote.name);
end;
$$;

revoke all on function ship.delete_version(text, uuid, uuid) from public, anon;
grant execute on function ship.delete_version(text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 9. save_version_phases
-- ---------------------------------------------------------------------
create or replace function ship.save_version_phases(
  p_scenario_id uuid,
  p_phases      jsonb
)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
  v_entry    jsonb;
  v_chunk    text;
  v_num      numeric;
  v_phases   jsonb;
begin
  v_scenario := ship.version_for_write(p_scenario_id, 'save_version_phases');

  if p_phases is null or jsonb_typeof(p_phases) <> 'array' then
    raise exception 'save_version_phases: p_phases must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_phases) > 5000 then
    raise exception 'save_version_phases: too many phases' using errcode = '22023';
  end if;

  for v_entry in select e from jsonb_array_elements(p_phases) e loop
    if jsonb_typeof(v_entry) <> 'object'
       or jsonb_typeof(v_entry -> 'id') <> 'string'
       or (v_entry ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'save_version_phases: every phase needs a uuid id' using errcode = '22023';
    end if;

    v_chunk := v_entry ->> 'chunk_project_id';
    if v_chunk is null or not exists (
         select 1 from ship.chunk_projects c
          where c.id::text = v_chunk and c.project_id = v_scenario.project_id) then
      raise exception 'save_version_phases: package % is not part of project %',
        coalesce(v_chunk, 'null'), v_scenario.project_id
        using errcode = '22023';
    end if;

    -- Blank is allowed: chunk_phases.name defaults to '' and a version
    -- copies the live phases as they are.
    if coalesce(jsonb_typeof(v_entry -> 'name'), '') <> 'string' or length(btrim(v_entry ->> 'name')) > 200 then
      raise exception 'save_version_phases: a phase name must be text of at most 200 characters' using errcode = '22023';
    end if;

    if coalesce(v_entry ->> 'kind', '') not in ('study', 'design', 'construction', 'closeout') then
      raise exception 'save_version_phases: unknown phase kind %', coalesce(v_entry ->> 'kind', 'null')
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_entry -> 'pct_of_tpc') <> 'number'
       or jsonb_typeof(v_entry -> 'start_slot') <> 'number'
       or jsonb_typeof(v_entry -> 'duration_slots') <> 'number'
       or jsonb_typeof(v_entry -> 'sort_order') <> 'number' then
      raise exception 'save_version_phases: pct_of_tpc, start_slot, duration_slots and sort_order must be numbers'
        using errcode = '22023';
    end if;

    v_num := (v_entry ->> 'pct_of_tpc')::numeric;
    if v_num < 0 or v_num > 100 then
      raise exception 'save_version_phases: pct_of_tpc must be 0-100, got %', v_num using errcode = '22023';
    end if;
    if (v_entry ->> 'start_slot')::numeric < 0 then
      raise exception 'save_version_phases: start (months) must be >= 0' using errcode = '22023';
    end if;
    if (v_entry ->> 'duration_slots')::numeric < 1 then
      raise exception 'save_version_phases: duration (months) must be >= 1' using errcode = '22023';
    end if;
    v_num := (v_entry ->> 'sort_order')::numeric;
    if v_num < 0 or v_num <> trunc(v_num) then
      raise exception 'save_version_phases: sort_order must be a whole number >= 0' using errcode = '22023';
    end if;

    if v_entry ? 'duration_locked'
       and jsonb_typeof(v_entry -> 'duration_locked') not in ('boolean', 'null') then
      raise exception 'save_version_phases: duration_locked must be a boolean' using errcode = '22023';
    end if;

    if v_entry ? 'template_step_id'
       and jsonb_typeof(v_entry -> 'template_step_id') not in ('string', 'null') then
      raise exception 'save_version_phases: template_step_id must be a uuid or null' using errcode = '22023';
    end if;
    if jsonb_typeof(v_entry -> 'template_step_id') = 'string'
       and (v_entry ->> 'template_step_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'save_version_phases: template_step_id must be a uuid or null' using errcode = '22023';
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(p_phases) e
     group by e ->> 'chunk_project_id' having count(*) > 50
  ) then
    raise exception 'save_version_phases: at most 50 phases per package' using errcode = '22023';
  end if;

  -- Every package listed is replaced wholesale; every other package's
  -- payload phases are kept, minus packages that no longer exist.
  with listed as (
    select distinct e ->> 'chunk_project_id' as chunk_id from jsonb_array_elements(p_phases) e
  ),
  kept as (
    select e
      from jsonb_array_elements(coalesce(v_scenario.payload -> 'phases', '[]'::jsonb)) e
     where (e ->> 'chunk_project_id') not in (select chunk_id from listed)
       and exists (select 1 from ship.chunk_projects c
                    where c.id::text = e ->> 'chunk_project_id'
                      and c.project_id = v_scenario.project_id)
  ),
  incoming as (
    select jsonb_build_object(
             'id',               lower(e ->> 'id'),
             'chunk_project_id', e ->> 'chunk_project_id',
             'template_step_id', case when jsonb_typeof(e -> 'template_step_id') = 'string'
                                      then lower(e ->> 'template_step_id') end,
             'name',             btrim(e ->> 'name'),
             'kind',             e ->> 'kind',
             'sort_order',       (e ->> 'sort_order')::integer,
             'pct_of_tpc',       (e -> 'pct_of_tpc'),
             'start_slot',       (e -> 'start_slot'),
             'duration_slots',   (e -> 'duration_slots'),
             'duration_locked',  coalesce((e ->> 'duration_locked')::boolean, false)
           ) as e
      from jsonb_array_elements(p_phases) e
  )
  select coalesce(jsonb_agg(x.e order by x.e ->> 'chunk_project_id',
                                         (x.e ->> 'sort_order')::numeric,
                                         x.e ->> 'id'), '[]'::jsonb)
    into v_phases
    from (select e from kept union all select e from incoming) x;

  if (select count(*) from jsonb_array_elements(v_phases))
     <> (select count(distinct e ->> 'id') from jsonb_array_elements(v_phases) e) then
    raise exception 'save_version_phases: phase ids must be unique within a version' using errcode = '22023';
  end if;

  -- Links whose ends are gone (a package re-phased) go with them.
  update ship.scenarios s
     set payload = s.payload || jsonb_build_object(
           'phases', v_phases,
           'dependencies', coalesce((
             select jsonb_agg(d)
               from jsonb_array_elements(coalesce(s.payload -> 'dependencies', '[]'::jsonb)) d
              where (d ->> 'predecessor_phase_id') in (select e ->> 'id' from jsonb_array_elements(v_phases) e)
                and (d ->> 'successor_phase_id')   in (select e ->> 'id' from jsonb_array_elements(v_phases) e)
           ), '[]'::jsonb)),
         payload_version = 2
   where s.id = p_scenario_id
  returning * into v_scenario;

  return v_scenario;
end;
$$;

revoke all on function ship.save_version_phases(uuid, jsonb) from public, anon;
grant execute on function ship.save_version_phases(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 10. save_version_cost_settings
-- ---------------------------------------------------------------------
create or replace function ship.save_version_cost_settings(
  p_scenario_id    uuid,
  p_settings       jsonb,
  p_rate_overrides jsonb
)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
  v_key      text;
  v_val      jsonb;
  v_patch    jsonb := '{}'::jsonb;
  v_num      numeric;
  v_entry    jsonb;
  v_rates    jsonb;
begin
  v_scenario := ship.version_for_write(p_scenario_id, 'save_version_cost_settings');

  if p_settings is not null then
    if jsonb_typeof(p_settings) <> 'object' then
      raise exception 'save_version_cost_settings: p_settings must be an object' using errcode = '22023';
    end if;

    for v_key, v_val in select key, value from jsonb_each(p_settings) loop
      case v_key
        when 'tpc_factor' then
          if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric <= 0
             or (v_val #>> '{}')::numeric > 10 then
            raise exception 'save_version_cost_settings: tpc_factor must be > 0 and <= 10' using errcode = '22023';
          end if;
        when 'base_year' then
          if jsonb_typeof(v_val) <> 'number' then
            raise exception 'save_version_cost_settings: base_year must be a year' using errcode = '22023';
          end if;
          v_num := (v_val #>> '{}')::numeric;
          if v_num <> trunc(v_num) or v_num < 1900 or v_num > 2200 then
            raise exception 'save_version_cost_settings: base_year must be 1900-2200' using errcode = '22023';
          end if;
        when 'escalation_mode' then
          if coalesce(v_val #>> '{}', '') not in ('compound_annual', 'stepped') then
            raise exception 'save_version_cost_settings: unknown escalation_mode' using errcode = '22023';
          end if;
        when 'escalation_annual_percent' then
          if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 0
             or (v_val #>> '{}')::numeric > 100 then
            raise exception 'save_version_cost_settings: escalation_annual_percent must be 0-100' using errcode = '22023';
          end if;
        when 'escalation_step_years' then
          if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 1
             or (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric) then
            raise exception 'save_version_cost_settings: escalation_step_years must be a whole number >= 1' using errcode = '22023';
          end if;
        when 'escalation_basis' then
          if coalesce(v_val #>> '{}', '') not in ('midpoint', 'start') then
            raise exception 'save_version_cost_settings: unknown escalation_basis' using errcode = '22023';
          end if;
        when 'escalation_confidence_years' then
          if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 0
             or (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric) then
            raise exception 'save_version_cost_settings: escalation_confidence_years must be a whole number >= 0' using errcode = '22023';
          end if;
        when 'default_phase_template_id' then
          if jsonb_typeof(v_val) <> 'null' and (
               jsonb_typeof(v_val) <> 'string'
               or (v_val #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               or not exists (select 1 from ship.phase_templates t
                               where t.id = (v_val #>> '{}')::uuid
                                 and (t.project_id is null or t.project_id = v_scenario.project_id))) then
            raise exception 'save_version_cost_settings: that phase template is not available to this project'
              using errcode = '22023';
          end if;
        else
          raise exception 'save_version_cost_settings: unknown setting %', v_key using errcode = '22023';
      end case;
      v_patch := v_patch || jsonb_build_object(v_key, v_val);
    end loop;
  end if;

  if p_rate_overrides is not null then
    if jsonb_typeof(p_rate_overrides) <> 'array' or jsonb_array_length(p_rate_overrides) > 101 then
      raise exception 'save_version_cost_settings: p_rate_overrides must be an array' using errcode = '22023';
    end if;
    for v_entry in select e from jsonb_array_elements(p_rate_overrides) e loop
      if jsonb_typeof(v_entry) <> 'object'
         or jsonb_typeof(v_entry -> 'year_offset') <> 'number'
         or jsonb_typeof(v_entry -> 'rate_percent') <> 'number' then
        raise exception 'save_version_cost_settings: each override needs year_offset and rate_percent' using errcode = '22023';
      end if;
      v_num := (v_entry ->> 'year_offset')::numeric;
      if v_num <> trunc(v_num) or v_num < 0 or v_num > 100 then
        raise exception 'save_version_cost_settings: year_offset must be a whole number 0-100' using errcode = '22023';
      end if;
      v_num := (v_entry ->> 'rate_percent')::numeric;
      if v_num < 0 or v_num > 100 then
        raise exception 'save_version_cost_settings: rate_percent must be 0-100' using errcode = '22023';
      end if;
    end loop;
    if (select count(*) from jsonb_array_elements(p_rate_overrides))
       <> (select count(distinct (e ->> 'year_offset')::numeric) from jsonb_array_elements(p_rate_overrides) e) then
      raise exception 'save_version_cost_settings: one override per year' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'year_offset',  (e ->> 'year_offset')::integer,
             'rate_percent', e -> 'rate_percent') order by (e ->> 'year_offset')::integer), '[]'::jsonb)
      into v_rates
      from jsonb_array_elements(p_rate_overrides) e;
  end if;

  -- Fill a missing cost model from live first (defensive; 0031 backfilled).
  update ship.scenarios s
     set payload = (case when jsonb_typeof(s.payload -> 'rate_overrides') = 'array'
                          and jsonb_typeof(s.payload -> 'cost_settings') = 'object'
                         then s.payload
                         else s.payload || ship.version_cost_snapshot(s.project_id) end)
                   || jsonb_build_object(
                        'cost_settings',
                          coalesce(case when jsonb_typeof(s.payload -> 'cost_settings') = 'object'
                                        then s.payload -> 'cost_settings' end,
                                   ship.version_cost_snapshot(s.project_id) -> 'cost_settings')
                          || v_patch)
                   || case when v_rates is not null
                           then jsonb_build_object('rate_overrides', v_rates)
                           else '{}'::jsonb end,
         payload_version = 2
   where s.id = p_scenario_id
  returning * into v_scenario;

  return v_scenario;
end;
$$;

revoke all on function ship.save_version_cost_settings(uuid, jsonb, jsonb) from public, anon;
grant execute on function ship.save_version_cost_settings(uuid, jsonb, jsonb) to authenticated;

commit;

-- =====================================================================
-- ROLLBACK
--
-- begin;
--   drop function if exists ship.save_version_cost_settings(uuid, jsonb, jsonb);
--   drop function if exists ship.save_version_phases(uuid, jsonb);
--   drop function if exists ship.delete_version(text, uuid, uuid);
--   drop function if exists ship.rename_version(text, uuid, text);
--   drop function if exists ship.create_version(text, text, uuid);
--   drop function if exists ship.version_name_or_raise(text, text);
--   drop function if exists ship.version_for_write(uuid, text);
--   drop function if exists ship.materialize_version_payload(text, jsonb);
--   drop function if exists ship.version_live_phases(text);
--   drop function if exists ship.version_cost_snapshot(text);
--   alter table ship.projects drop column if exists live_version_name;
--   -- then re-apply 0015 (create/publish/rebase/save_scenario_payload,
--   -- baseline_fingerprint, the owner policies and column grants).
-- commit;
--
-- HOW TO VERIFY (impersonate; the SQL editor bypasses RLS)
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"<admin id>","email":"admin@gmail.com","role":"authenticated"}';
--   select id, jsonb_array_length(payload->'phases')
--     from ship.create_version('federal-campus-master-plan', 'Version 2');
--   select ship.save_version_cost_settings('<that id>', '{"tpc_factor": 1.5}', null);
--   select ship.delete_version('federal-campus-master-plan', null);   -- promotes Version 2
--   select live_version_name from ship.projects where id = 'federal-campus-master-plan';
--   select tpc_factor from ship.project_cost_settings where project_id = 'federal-campus-master-plan';  -- 1.5
--   select ship.delete_version('federal-campus-master-plan', null);
--   -- expected: ERROR 22023 ... at least one version
-- rollback;
-- =====================================================================
