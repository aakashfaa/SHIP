-- =====================================================================
-- 0011_ship_scenario_authority.sql
-- SHIP v2 -- close a privilege escalation in the what-if sandbox.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0010. Local stack only; not applied remotely.
--
-- THE BUG
-- -------
-- 0010 shipped `publish_scenario()` with this, verbatim:
--
--     -- Anyone who may edit the project's schedule may publish a
--     -- scenario on it; owning the scenario is not sufficient, because
--     -- publishing writes the shared baseline.
--     if not ship.can_read_project(v_scenario.project_id) then
--
-- The comment says EDIT. The code checks READ. At the time 0010 was
-- written those were arguably close enough -- but 0009 had already
-- redefined `can_read_project()` as "project_role() is not null", which
-- is true for every role including `viewer`.
--
-- `publish_scenario()` is SECURITY DEFINER, so its
-- `update ship.chunk_phases` runs as the owner and bypasses
-- `chunk_phases_update`, which correctly requires
-- `my_editable_chunk_ids()`. The RLS policy that should have caught this
-- never ran.
--
-- Net effect, confirmed by impersonating the seeded viewer
-- (electrical@voltworks.com on federal-campus-master-plan):
--
--     role   | passes_publish_gate | should_be_the_gate
--     -------+---------------------+-------------------
--     viewer | t                   | f
--
-- A read-only user could take a scenario, write any payload they liked
-- into it (`scenarios_update_own` permits an owner to edit their own
-- row), and publish it -- persisting arbitrary start_slot,
-- duration_slots, pct_of_tpc and duration_locked onto every phase in the
-- project, plus arbitrary dep_type and lag_slots onto every dependency.
-- That is the entire schedule, rewritten by someone who is supposed to
-- be looking at it.
--
-- THE FIX, IN TWO LAYERS
-- ----------------------
-- 1. `publish_scenario()` now checks `can_edit_project()` -- what its own
--    comment always said it did. Admin and editor only.
--
-- 2. `create_scenario()` now checks `can_contribute_project()` rather
--    than read. Spec R5.3 gives a viewer a sandbox that "is never
--    persisted anywhere"; a row in `ship.scenarios` is persistence. A
--    viewer's what-if is a client-side overlay and must stay one.
--    Consultants keep the ability to save a scenario -- they cannot
--    publish it, so modelling an idea privately is harmless and is
--    exactly the sort of thing they are on the project to do.
--
-- The UI gate added alongside this (SandboxBar `ephemeral` mode) is a
-- courtesy so a viewer is never offered a button that would fail. It is
-- NOT the boundary. This file is.
--
-- WHY THE BODIES ARE REPRODUCED IN FULL
-- -------------------------------------
-- Postgres has no way to patch one line of a function; `create or
-- replace` takes the whole body. These were dumped from the live
-- database with `pg_get_functiondef()` and re-emitted with ONLY the
-- authorisation check and its error message changed, so nothing else can
-- have drifted in transcription. Diff them against 0010 if in doubt.
--
-- Re-runnable: `create or replace function` throughout.
-- =====================================================================

begin;


-- ---------------------------------------------------------------------
-- create_scenario: contributors only. A viewer's sandbox is ephemeral.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ship.create_scenario(p_project_id text, p_name text, p_description text DEFAULT ''::text)
 RETURNS ship.scenarios
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_email    text;
  v_scenario ship.scenarios;
begin
  v_email := ship.current_email();

  if v_email is null or not ship.can_contribute_project(p_project_id) then
    raise exception 'create_scenario: viewers cannot save a what-if on project %', p_project_id
      using errcode = '42501';
  end if;

  insert into ship.scenarios (project_id, name, description, owner_email,
                              payload, baseline_fingerprint)
  values (
    p_project_id,
    btrim(p_name),
    coalesce(p_description, ''),
    v_email,
    jsonb_build_object(
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
      ), '[]'::jsonb),
      'cost_settings', coalesce((
        select to_jsonb(s) from ship.project_cost_settings s
         where s.project_id = p_project_id
      ), '{}'::jsonb)
    ),
    ship.baseline_fingerprint(p_project_id)
  )
  returning * into v_scenario;

  return v_scenario;
end;
$function$;

-- ---------------------------------------------------------------------
-- publish_scenario: admin and editor only. This is the escalation fix.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ship.publish_scenario(p_scenario_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_scenario    ship.scenarios;
  v_current     text;
  v_phases      integer := 0;
  v_links       integer := 0;
begin
  select * into v_scenario
    from ship.scenarios
   where id = p_scenario_id
   for update;

  if not found then
    raise exception 'publish_scenario: no such scenario' using errcode = '42704';
  end if;

  -- Anyone who may edit the project's schedule may publish a scenario on
  -- it; owning the scenario is not sufficient, because publishing writes
  -- the shared baseline.
  if not ship.can_edit_project(v_scenario.project_id) then
    raise exception 'publish_scenario: you do not have edit access to project %', v_scenario.project_id
      using errcode = '42501';
  end if;

  if v_scenario.published_at is not null then
    raise exception 'publish_scenario: this scenario was already published at %',
      v_scenario.published_at
      using errcode = '22023';
  end if;

  v_current := ship.baseline_fingerprint(v_scenario.project_id);

  if v_current <> v_scenario.baseline_fingerprint then
    raise exception
      'publish_scenario: the live schedule changed after this scenario was created'
      using errcode = '40001',
            hint = 'Someone edited the plan while you were exploring. Re-branch from the current schedule and redo your changes, the way you would resolve a Revit sync conflict.';
  end if;

  with payload_phases as (
    select * from jsonb_to_recordset(v_scenario.payload -> 'phases')
      as x(id uuid, start_slot numeric, duration_slots numeric,
           pct_of_tpc numeric, duration_locked boolean)
  )
  update ship.chunk_phases p
     set start_slot      = pp.start_slot,
         duration_slots  = pp.duration_slots,
         pct_of_tpc      = pp.pct_of_tpc,
         duration_locked = pp.duration_locked
    from payload_phases pp
   where p.id = pp.id
     -- The project scoping has to be an EXISTS rather than a join in the
     -- FROM clause: Postgres does not allow the UPDATE target (`p`) to be
     -- referenced from a join condition there, and fails with "invalid
     -- reference to FROM-clause entry". This form keeps the tenant
     -- boundary intact, which is the part that actually matters.
     and exists (
       select 1
         from ship.chunk_projects c
        where c.id = p.chunk_project_id
          and c.project_id = v_scenario.project_id
     );

  get diagnostics v_phases = row_count;

  with payload_links as (
    select * from jsonb_to_recordset(v_scenario.payload -> 'dependencies')
      as x(id uuid, dep_type text, lag_slots numeric)
  )
  update ship.phase_dependencies d
     set dep_type  = pl.dep_type,
         lag_slots = pl.lag_slots
    from payload_links pl
   where d.id = pl.id
     and d.project_id = v_scenario.project_id;

  get diagnostics v_links = row_count;

  update ship.scenarios
     set published_at = now(),
         updated_at   = now()
   where id = p_scenario_id;

  return jsonb_build_object(
    'scenario_id',        p_scenario_id,
    'phases_updated',     v_phases,
    'dependencies_updated', v_links
  );
end;
$function$;

-- ---------------------------------------------------------------------
-- Grants are unchanged from 0010 -- `create or replace` preserves them,
-- but they are restated so this file is self-contained if anyone reads
-- it alone.
-- ---------------------------------------------------------------------
revoke all    on function ship.create_scenario(text, text, text)  from public;
revoke all    on function ship.publish_scenario(uuid)             from public;
grant execute on function ship.create_scenario(text, text, text)  to authenticated;
grant execute on function ship.publish_scenario(uuid)             to authenticated;

commit;

-- =====================================================================
-- ROLLBACK
--
-- Re-apply 0010's definitions of the two functions. Note that doing so
-- REINTRODUCES the escalation described above; there is no version of
-- this worth rolling back to on its own.
--
-- HOW TO VERIFY (impersonate; the SQL editor bypasses RLS entirely)
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"<viewer auth.users id>","email":"electrical@voltworks.com","role":"authenticated"}';
--
--   select ship.project_role('federal-campus-master-plan');      -- viewer
--   select ship.create_scenario('federal-campus-master-plan','probe','');
--   -- expected: ERROR 42501 create_scenario: viewers cannot save a what-if
-- rollback;
--
-- And as the seeded consultant (consultant1@gmail.com), who MAY branch
-- but MUST NOT publish:
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"<consultant id>","email":"consultant1@gmail.com","role":"authenticated"}';
--   select ship.create_scenario('federal-campus-master-plan','probe','');  -- ok
--   select ship.publish_scenario('<that scenario id>');
--   -- expected: ERROR 42501 publish_scenario: you do not have edit access
-- rollback;
-- =====================================================================
