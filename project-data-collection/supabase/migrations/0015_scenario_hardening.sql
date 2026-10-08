-- =====================================================================
-- 0015_scenario_hardening.sql
-- SHIP -- what-ifs that do not revert colleagues' work, and a scenario
-- row its owner cannot doctor.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0014. Additive; nothing earlier is edited.
--
-- WHAT THIS FIXES (pre-launch audit master IDs)
-- ---------------------------------------------
-- M-07  "Pull in the changes and keep mine" (rebase) pulled nothing in.
--       A scenario payload is a full copy of every phase, so 0010's
--       rebase -- coalesce(scenario value, live value) -- always found a
--       scenario value and kept it. Rebase then re-stamped the
--       fingerprint, so publish passed its drift check and wrote the
--       stale positions over EVERY phase: a colleague's move made after
--       the branch was silently undone (verified: 15 phases rewritten,
--       the colleague's 3 -> 8 put back to 3).
--
--       Fix: `scenarios.base_payload` -- the schedule as it was when the
--       scenario was branched (or last rebased). Rebase is now a 3-way
--       merge, field by field:
--           scenario value  where it differs from base_payload (the
--                           user moved it in the what-if)
--           live value      everywhere else (someone else may have)
--       Dependencies are merged the same way (0010 never rebased them at
--       all). Publish writes only rows whose values actually differ from
--       live, so `phases_updated` now means "phases this publish moved".
--
-- M-13  Scenario authority gaps:
--       * The owner held a whole-row UPDATE: visibility, published_at,
--         baseline_fingerprint, payload, anything. The client grant is
--         now UPDATE (name, description, visibility) only. Payload edits
--         go through ship.save_scenario_payload(), which merges
--         server-side, validates every id and range, and keeps
--         cost_settings (the old client-side whole-payload write dropped
--         it).
--       * publish_scenario() accepted ANY scenario id, including another
--         user's private what-if. It now requires the caller to own the
--         scenario OR the scenario to be shared (visibility = 'project'),
--         on top of the existing can_edit_project() gate.
--       * rebase_scenario() worked for an owner who had since been
--         removed from the project or deactivated, and handed them the
--         current live schedule. It now requires can_read_project()
--         (which is null for an inactive user) as well as ownership.
--       * baseline_fingerprint(project) answered for any project id --
--         an oracle for "did anything change in a project I can't see".
--         It now returns NULL unless the caller can read the project.
--         The RPCs use an internal, ungranted twin.
--
-- CONTRACT
--   ship.save_scenario_payload(p_scenario_id uuid, p_phases jsonb,
--                              p_dependencies jsonb) returns ship.scenarios
--     p_phases:       array of {id, start_slot?, duration_slots?,
--                     pct_of_tpc?, duration_locked?, ...}. Other keys
--                     (name, kind, chunk_project_id, sort_order) are
--                     accepted and ignored -- they are not the user's to
--                     change in a what-if. NULL = leave phases alone.
--     p_dependencies: array of {id, dep_type?, lag_slots?, ...}.
--                     NULL = leave dependencies alone.
--     Merge: each listed id has its listed movable fields replaced; ids
--     not listed are unchanged. Owner only; 42501 otherwise. Unknown ids
--     or out-of-range values raise 22023. A published scenario is
--     frozen (22023).
--   Client UPDATE on ship.scenarios: name, description, visibility only.
--   updated_at is maintained by a trigger.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Internal helpers.
-- ---------------------------------------------------------------------

-- The live schedule of a project, in exactly the payload shape 0010's
-- create_scenario() wrote. Internal: no client grant.
create or replace function ship.schedule_snapshot(p_project_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',               p.id,
               'chunk_project_id', p.chunk_project_id,
               'name',             p.name,
               'kind',             p.kind,
               'sort_order',       p.sort_order,
               'pct_of_tpc',       p.pct_of_tpc,
               'start_slot',       p.start_slot,
               'duration_slots',   p.duration_slots,
               'duration_locked',  p.duration_locked
             ) order by p.id)
        from ship.chunk_phases p
        join ship.chunk_projects c on c.id = p.chunk_project_id
       where c.project_id = p_project_id
    ), '[]'::jsonb),
    'dependencies', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',                   d.id,
               'predecessor_phase_id', d.predecessor_phase_id,
               'successor_phase_id',   d.successor_phase_id,
               'dep_type',             d.dep_type,
               'lag_slots',            d.lag_slots
             ) order by d.id)
        from ship.phase_dependencies d
       where d.project_id = p_project_id
    ), '[]'::jsonb)
  )
$$;

revoke all on function ship.schedule_snapshot(text) from public, anon, authenticated;

-- The fingerprint, ungated, for use INSIDE the RPCs only. Same formula
-- as 0010 so existing scenarios' stored fingerprints stay comparable.
create or replace function ship.schedule_fingerprint(p_project_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((
      select string_agg(
               p.id::text || ':' || p.start_slot || ':' || p.duration_slots || ':' ||
               p.pct_of_tpc || ':' || p.kind || ':' || p.duration_locked,
               '|' order by p.id)
        from ship.chunk_phases p
        join ship.chunk_projects c on c.id = p.chunk_project_id
       where c.project_id = p_project_id
    ), '')
    || '#' ||
    coalesce((
      select string_agg(
               d.id::text || ':' || d.dep_type || ':' || d.lag_slots,
               '|' order by d.id)
        from ship.phase_dependencies d
       where d.project_id = p_project_id
    ), '')
  )
$$;

revoke all on function ship.schedule_fingerprint(text) from public, anon, authenticated;

-- The client-callable one is now gated (M-13: no oracle).
create or replace function ship.baseline_fingerprint(p_project_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when ship.can_read_project(p_project_id)
              then ship.schedule_fingerprint(p_project_id)
         end
$$;

revoke all on function ship.baseline_fingerprint(text) from public, anon;
grant execute on function ship.baseline_fingerprint(text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. base_payload.
-- ---------------------------------------------------------------------
alter table ship.scenarios
  add column if not exists base_payload jsonb not null default '{}'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'scenarios_base_payload_check') then
    alter table ship.scenarios
      add constraint scenarios_base_payload_check check (jsonb_typeof(base_payload) = 'object');
  end if;
end $$;

comment on column ship.scenarios.base_payload is
  'The live schedule (phases + dependencies) at the moment this scenario was branched or last rebased. Rebase and publish diff the payload against it to tell the user''s own moves apart from other people''s. Set only by the RPCs.';

-- Backfill. The true branch-time schedule of an existing scenario is not
-- recoverable. Using the CURRENT live schedule as its base means "every
-- value where the scenario differs from live counts as the user's move"
-- -- i.e. exactly the old behaviour, so no existing what-if loses work.
-- Where the fingerprint still matches, live IS the branch-time schedule
-- and the backfill is exact.
update ship.scenarios s
   set base_payload = ship.schedule_snapshot(s.project_id)
 where s.base_payload = '{}'::jsonb;

-- updated_at is no longer client-writable (column grant below), so keep
-- it honest with a trigger.
create or replace function ship.touch_scenario_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function ship.touch_scenario_updated_at() from public, anon, authenticated;

drop trigger if exists scenarios_touch_updated_at on ship.scenarios;
create trigger scenarios_touch_updated_at
  before update on ship.scenarios
  for each row execute function ship.touch_scenario_updated_at();

-- ---------------------------------------------------------------------
-- 3. Column-level UPDATE for clients (M-13).
-- ---------------------------------------------------------------------
revoke update on ship.scenarios from authenticated;
grant update (name, description, visibility) on ship.scenarios to authenticated;

-- ---------------------------------------------------------------------
-- 4. create_scenario(): also records base_payload.
-- ---------------------------------------------------------------------
create or replace function ship.create_scenario(
  p_project_id  text,
  p_name        text,
  p_description text default ''
)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    text;
  v_snapshot jsonb;
  v_scenario ship.scenarios;
begin
  v_email := ship.current_email();

  if v_email is null or not ship.can_contribute_project(p_project_id) then
    raise exception 'create_scenario: viewers cannot save a what-if on project %', p_project_id
      using errcode = '42501';
  end if;

  v_snapshot := ship.schedule_snapshot(p_project_id);

  insert into ship.scenarios (project_id, name, description, owner_email,
                              payload, base_payload, baseline_fingerprint)
  values (
    p_project_id,
    btrim(p_name),
    coalesce(p_description, ''),
    v_email,
    v_snapshot || jsonb_build_object(
      'cost_settings', coalesce((
        select to_jsonb(s) from ship.project_cost_settings s
         where s.project_id = p_project_id
      ), '{}'::jsonb)
    ),
    v_snapshot,
    ship.schedule_fingerprint(p_project_id)
  )
  returning * into v_scenario;

  return v_scenario;
end;
$$;

revoke all on function ship.create_scenario(text, text, text) from public, anon;
grant execute on function ship.create_scenario(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. rebase_scenario(): 3-way merge; current read access required.
-- ---------------------------------------------------------------------
create or replace function ship.rebase_scenario(p_scenario_id uuid)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
  v_live     jsonb;
  v_phases   jsonb;
  v_links    jsonb;
begin
  select * into v_scenario from ship.scenarios where id = p_scenario_id for update;

  if not found then
    raise exception 'rebase_scenario: no such scenario' using errcode = '42704';
  end if;

  -- can_read_project() is NULL-safe false for a removed or deactivated
  -- user, so a former member can no longer use their old what-if to read
  -- the current live schedule.
  if not ship.can_read_project(v_scenario.project_id) then
    raise exception 'rebase_scenario: you no longer have access to project %', v_scenario.project_id
      using errcode = '42501';
  end if;

  if v_scenario.owner_email is distinct from ship.current_email() and not ship.is_admin() then
    raise exception 'rebase_scenario: not your scenario' using errcode = '42501';
  end if;

  if v_scenario.published_at is not null then
    raise exception 'rebase_scenario: this scenario was already published at %', v_scenario.published_at
      using errcode = '22023';
  end if;

  v_live := ship.schedule_snapshot(v_scenario.project_id);

  -- Phases: one row per LIVE phase (phases deleted since the branch drop
  -- out; phases added since appear with their live values). For each
  -- movable field, the scenario's value wins only when the scenario
  -- changed it relative to base.
  select coalesce(jsonb_agg(
           lp.ph || jsonb_build_object(
             'start_slot',
               case when sp.id is not null and (bp.id is null or sp.start_slot is distinct from bp.start_slot)
                    then to_jsonb(sp.start_slot) else lp.ph -> 'start_slot' end,
             'duration_slots',
               case when sp.id is not null and (bp.id is null or sp.duration_slots is distinct from bp.duration_slots)
                    then to_jsonb(sp.duration_slots) else lp.ph -> 'duration_slots' end,
             'pct_of_tpc',
               case when sp.id is not null and (bp.id is null or sp.pct_of_tpc is distinct from bp.pct_of_tpc)
                    then to_jsonb(sp.pct_of_tpc) else lp.ph -> 'pct_of_tpc' end,
             'duration_locked',
               case when sp.id is not null and (bp.id is null or sp.duration_locked is distinct from bp.duration_locked)
                    then to_jsonb(sp.duration_locked) else lp.ph -> 'duration_locked' end
           ) order by lp.id), '[]'::jsonb)
    into v_phases
    from (select e as ph, (e ->> 'id')::uuid as id
            from jsonb_array_elements(v_live -> 'phases') e) lp
    left join jsonb_to_recordset(coalesce(v_scenario.payload -> 'phases', '[]'::jsonb))
           as sp(id uuid, start_slot numeric, duration_slots numeric, pct_of_tpc numeric, duration_locked boolean)
           on sp.id = lp.id
    left join jsonb_to_recordset(coalesce(v_scenario.base_payload -> 'phases', '[]'::jsonb))
           as bp(id uuid, start_slot numeric, duration_slots numeric, pct_of_tpc numeric, duration_locked boolean)
           on bp.id = lp.id;

  select coalesce(jsonb_agg(
           ld.dep || jsonb_build_object(
             'dep_type',
               case when sd.id is not null and (bd.id is null or sd.dep_type is distinct from bd.dep_type)
                    then to_jsonb(sd.dep_type) else ld.dep -> 'dep_type' end,
             'lag_slots',
               case when sd.id is not null and (bd.id is null or sd.lag_slots is distinct from bd.lag_slots)
                    then to_jsonb(sd.lag_slots) else ld.dep -> 'lag_slots' end
           ) order by ld.id), '[]'::jsonb)
    into v_links
    from (select e as dep, (e ->> 'id')::uuid as id
            from jsonb_array_elements(v_live -> 'dependencies') e) ld
    left join jsonb_to_recordset(coalesce(v_scenario.payload -> 'dependencies', '[]'::jsonb))
           as sd(id uuid, dep_type text, lag_slots numeric)
           on sd.id = ld.id
    left join jsonb_to_recordset(coalesce(v_scenario.base_payload -> 'dependencies', '[]'::jsonb))
           as bd(id uuid, dep_type text, lag_slots numeric)
           on bd.id = ld.id;

  update ship.scenarios s
     set payload              = s.payload || jsonb_build_object('phases', v_phases, 'dependencies', v_links),
         base_payload         = v_live,
         baseline_fingerprint = ship.schedule_fingerprint(s.project_id)
   where s.id = p_scenario_id
  returning * into v_scenario;

  return v_scenario;
end;
$$;

revoke all on function ship.rebase_scenario(uuid) from public, anon;
grant execute on function ship.rebase_scenario(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. publish_scenario(): owner-or-shared; writes only real differences.
-- ---------------------------------------------------------------------
create or replace function ship.publish_scenario(p_scenario_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
  v_phases   integer := 0;
  v_links    integer := 0;
begin
  select * into v_scenario
    from ship.scenarios
   where id = p_scenario_id
   for update;

  if not found then
    raise exception 'publish_scenario: no such scenario' using errcode = '42704';
  end if;

  -- Publishing writes the shared baseline: edit rights on the project
  -- (0011) ...
  if not ship.can_edit_project(v_scenario.project_id) then
    raise exception 'publish_scenario: you do not have edit access to project %', v_scenario.project_id
      using errcode = '42501';
  end if;

  -- ... AND the scenario must be yours or deliberately shared. A private
  -- what-if is someone thinking out loud; nobody else pushes it live.
  if v_scenario.owner_email is distinct from ship.current_email()
     and v_scenario.visibility <> 'project' then
    raise exception 'publish_scenario: this what-if is private to its owner'
      using errcode = '42501';
  end if;

  if v_scenario.published_at is not null then
    raise exception 'publish_scenario: this scenario was already published at %',
      v_scenario.published_at
      using errcode = '22023';
  end if;

  if ship.schedule_fingerprint(v_scenario.project_id) <> v_scenario.baseline_fingerprint then
    raise exception
      'publish_scenario: the live schedule changed after this scenario was created'
      using errcode = '40001',
            hint = 'Someone edited the plan while you were exploring. Pull in their changes (rebase) and publish again.';
  end if;

  with payload_phases as (
    select * from jsonb_to_recordset(coalesce(v_scenario.payload -> 'phases', '[]'::jsonb))
      as x(id uuid, start_slot numeric, duration_slots numeric,
           pct_of_tpc numeric, duration_locked boolean)
  )
  update ship.chunk_phases p
     set start_slot      = coalesce(pp.start_slot,      p.start_slot),
         duration_slots  = coalesce(pp.duration_slots,  p.duration_slots),
         pct_of_tpc      = coalesce(pp.pct_of_tpc,      p.pct_of_tpc),
         duration_locked = coalesce(pp.duration_locked, p.duration_locked)
    from payload_phases pp
   where p.id = pp.id
     and exists (
       select 1
         from ship.chunk_projects c
        where c.id = p.chunk_project_id
          and c.project_id = v_scenario.project_id
     )
     -- Only rows that actually change.
     and (p.start_slot, p.duration_slots, p.pct_of_tpc, p.duration_locked)
         is distinct from
         (coalesce(pp.start_slot, p.start_slot), coalesce(pp.duration_slots, p.duration_slots),
          coalesce(pp.pct_of_tpc, p.pct_of_tpc), coalesce(pp.duration_locked, p.duration_locked));

  get diagnostics v_phases = row_count;

  with payload_links as (
    select * from jsonb_to_recordset(coalesce(v_scenario.payload -> 'dependencies', '[]'::jsonb))
      as x(id uuid, dep_type text, lag_slots numeric)
  )
  update ship.phase_dependencies d
     set dep_type  = coalesce(pl.dep_type,  d.dep_type),
         lag_slots = coalesce(pl.lag_slots, d.lag_slots)
    from payload_links pl
   where d.id = pl.id
     and d.project_id = v_scenario.project_id
     and (d.dep_type, d.lag_slots)
         is distinct from
         (coalesce(pl.dep_type, d.dep_type), coalesce(pl.lag_slots, d.lag_slots));

  get diagnostics v_links = row_count;

  update ship.scenarios
     set published_at = now()
   where id = p_scenario_id;

  return jsonb_build_object(
    'scenario_id',          p_scenario_id,
    'phases_updated',       v_phases,
    'dependencies_updated', v_links
  );
end;
$$;

revoke all on function ship.publish_scenario(uuid) from public, anon;
grant execute on function ship.publish_scenario(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. save_scenario_payload() (M-13).
-- ---------------------------------------------------------------------
create or replace function ship.save_scenario_payload(
  p_scenario_id  uuid,
  p_phases       jsonb,
  p_dependencies jsonb
)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
  v_entry    jsonb;
  v_id       uuid;
  v_val      jsonb;
  v_phases   jsonb;
  v_links    jsonb;
begin
  select * into v_scenario from ship.scenarios where id = p_scenario_id for update;

  if not found then
    raise exception 'save_scenario_payload: no such scenario' using errcode = '42704';
  end if;

  if not ship.can_read_project(v_scenario.project_id)
     or v_scenario.owner_email is distinct from ship.current_email() then
    raise exception 'save_scenario_payload: only the owner of this what-if can change it'
      using errcode = '42501';
  end if;

  if v_scenario.published_at is not null then
    raise exception 'save_scenario_payload: this scenario was already published and is read-only'
      using errcode = '22023';
  end if;

  -- ------------------------------------------------------------ phases
  if p_phases is not null then
    if jsonb_typeof(p_phases) <> 'array' then
      raise exception 'save_scenario_payload: p_phases must be a JSON array' using errcode = '22023';
    end if;

    for v_entry in select e from jsonb_array_elements(p_phases) e loop
      if jsonb_typeof(v_entry) <> 'object' or jsonb_typeof(v_entry -> 'id') <> 'string' then
        raise exception 'save_scenario_payload: every phase needs an id' using errcode = '22023';
      end if;
      v_id := (v_entry ->> 'id')::uuid;

      if not exists (select 1 from jsonb_array_elements(coalesce(v_scenario.payload -> 'phases', '[]'::jsonb)) x
                      where (x ->> 'id')::uuid = v_id)
         and ship.phase_project_id(v_id) is distinct from v_scenario.project_id then
        raise exception 'save_scenario_payload: phase % is not part of project %', v_id, v_scenario.project_id
          using errcode = '22023';
      end if;

      v_val := v_entry -> 'start_slot';
      if v_val is not null and jsonb_typeof(v_val) <> 'null'
         and (jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 0) then
        raise exception 'save_scenario_payload: phase % start_slot must be a number >= 0', v_id using errcode = '22023';
      end if;

      v_val := v_entry -> 'duration_slots';
      if v_val is not null and jsonb_typeof(v_val) <> 'null'
         and (jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 1) then
        raise exception 'save_scenario_payload: phase % duration_slots must be a number >= 1', v_id using errcode = '22023';
      end if;

      v_val := v_entry -> 'pct_of_tpc';
      if v_val is not null and jsonb_typeof(v_val) <> 'null'
         and (jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not between 0 and 100) then
        raise exception 'save_scenario_payload: phase % pct_of_tpc must be between 0 and 100', v_id using errcode = '22023';
      end if;

      v_val := v_entry -> 'duration_locked';
      if v_val is not null and jsonb_typeof(v_val) not in ('null', 'boolean') then
        raise exception 'save_scenario_payload: phase % duration_locked must be true or false', v_id using errcode = '22023';
      end if;
    end loop;

    with patch as (
      -- Last entry wins if an id is listed twice. Only movable fields;
      -- jsonb_strip_nulls drops the ones the caller did not send.
      select distinct on ((e ->> 'id')::uuid)
             (e ->> 'id')::uuid as id,
             jsonb_strip_nulls(jsonb_build_object(
               'start_slot',      e -> 'start_slot',
               'duration_slots',  e -> 'duration_slots',
               'pct_of_tpc',      e -> 'pct_of_tpc',
               'duration_locked', e -> 'duration_locked')) as fields
        from jsonb_array_elements(p_phases) with ordinality as t(e, ord)
       order by (e ->> 'id')::uuid, ord desc
    ),
    existing as (
      select e as ph, (e ->> 'id')::uuid as id
        from jsonb_array_elements(coalesce(v_scenario.payload -> 'phases', '[]'::jsonb)) e
    ),
    live as (
      select e as ph, (e ->> 'id')::uuid as id
        from jsonb_array_elements(ship.schedule_snapshot(v_scenario.project_id) -> 'phases') e
    ),
    merged as (
      select ex.id, ex.ph || coalesce(pa.fields, '{}'::jsonb) as ph
        from existing ex
        left join patch pa on pa.id = ex.id
      union all
      -- A phase added to the live plan after the branch: start from its
      -- live row, then apply the caller's fields.
      select lv.id, lv.ph || pa.fields
        from patch pa
        join live lv on lv.id = pa.id
       where not exists (select 1 from existing ex where ex.id = pa.id)
    )
    select coalesce(jsonb_agg(m.ph order by m.id), '[]'::jsonb) into v_phases from merged m;
  else
    v_phases := coalesce(v_scenario.payload -> 'phases', '[]'::jsonb);
  end if;

  -- ------------------------------------------------------ dependencies
  if p_dependencies is not null then
    if jsonb_typeof(p_dependencies) <> 'array' then
      raise exception 'save_scenario_payload: p_dependencies must be a JSON array' using errcode = '22023';
    end if;

    for v_entry in select e from jsonb_array_elements(p_dependencies) e loop
      if jsonb_typeof(v_entry) <> 'object' or jsonb_typeof(v_entry -> 'id') <> 'string' then
        raise exception 'save_scenario_payload: every dependency needs an id' using errcode = '22023';
      end if;
      v_id := (v_entry ->> 'id')::uuid;

      if not exists (select 1 from jsonb_array_elements(coalesce(v_scenario.payload -> 'dependencies', '[]'::jsonb)) x
                      where (x ->> 'id')::uuid = v_id)
         and not exists (select 1 from ship.phase_dependencies d
                          where d.id = v_id and d.project_id = v_scenario.project_id) then
        raise exception 'save_scenario_payload: dependency % is not part of project %', v_id, v_scenario.project_id
          using errcode = '22023';
      end if;

      v_val := v_entry -> 'dep_type';
      if v_val is not null and jsonb_typeof(v_val) <> 'null'
         and (v_val #>> '{}') not in ('FS', 'SS', 'FF', 'SF') then
        raise exception 'save_scenario_payload: dependency % dep_type must be FS, SS, FF or SF', v_id using errcode = '22023';
      end if;

      v_val := v_entry -> 'lag_slots';
      if v_val is not null and jsonb_typeof(v_val) not in ('null', 'number') then
        raise exception 'save_scenario_payload: dependency % lag_slots must be a number', v_id using errcode = '22023';
      end if;
    end loop;

    with patch as (
      select distinct on ((e ->> 'id')::uuid)
             (e ->> 'id')::uuid as id,
             jsonb_strip_nulls(jsonb_build_object(
               'dep_type',  e -> 'dep_type',
               'lag_slots', e -> 'lag_slots')) as fields
        from jsonb_array_elements(p_dependencies) with ordinality as t(e, ord)
       order by (e ->> 'id')::uuid, ord desc
    ),
    existing as (
      select e as dep, (e ->> 'id')::uuid as id
        from jsonb_array_elements(coalesce(v_scenario.payload -> 'dependencies', '[]'::jsonb)) e
    ),
    live as (
      select e as dep, (e ->> 'id')::uuid as id
        from jsonb_array_elements(ship.schedule_snapshot(v_scenario.project_id) -> 'dependencies') e
    ),
    merged as (
      select ex.id, ex.dep || coalesce(pa.fields, '{}'::jsonb) as dep
        from existing ex
        left join patch pa on pa.id = ex.id
      union all
      select lv.id, lv.dep || pa.fields
        from patch pa
        join live lv on lv.id = pa.id
       where not exists (select 1 from existing ex where ex.id = pa.id)
    )
    select coalesce(jsonb_agg(m.dep order by m.id), '[]'::jsonb) into v_links from merged m;
  else
    v_links := coalesce(v_scenario.payload -> 'dependencies', '[]'::jsonb);
  end if;

  -- `||` keeps every other top-level key -- cost_settings above all.
  update ship.scenarios s
     set payload = s.payload || jsonb_build_object('phases', v_phases, 'dependencies', v_links)
   where s.id = p_scenario_id
  returning * into v_scenario;

  return v_scenario;
end;
$$;

revoke all on function ship.save_scenario_payload(uuid, jsonb, jsonb) from public, anon;
grant execute on function ship.save_scenario_payload(uuid, jsonb, jsonb) to authenticated;

commit;
