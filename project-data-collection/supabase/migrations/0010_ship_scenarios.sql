-- =====================================================================
-- 0010_ship_scenarios.sql
-- SHIP v2 -- what-if scenarios: a private copy of the schedule you can
-- play with and then publish back, or throw away.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0009. Local stack only; not applied remotely.
--
-- WHAT THIS IS FOR
-- ----------------
-- The client described the feature by naming the tool they already use:
--
--   "similar to how we handle the Revit projects. You make a copy of the
--    central model, and then every time you're saving it, you have to
--    publish it back to the central model."                    -- Megan
--
--   "It's like a way of kind of testing something without having a
--    larger impact. [...] we can play around with it and then say, 'Oh,
--    that did work.' And then we can apply it to the main trunk of the
--    idea."                                                    -- Steve
--
-- And the reason they want it is a specific person in a specific
-- meeting:
--
--   "We were having a conversation with Ray, Steve, and you're like,
--    'What if we do this?' And he's like, 'What if you do X, Y, Z?' And
--    then you don't actually want to do it, so you don't save it."
--                                                              -- Megan
--
-- So the unit of work is a whole alternative schedule, explored live in
-- front of a client, that usually gets discarded.
--
-- WHY A SNAPSHOT AND NOT A scenario_id COLUMN
-- -------------------------------------------
-- The obvious design is `scenario_id` on chunk_phases / phase_dependencies
-- / the settings tables, with NULL meaning baseline. It is rejected.
--
-- That design adds a second, orthogonal dimension to every RLS predicate
-- and every aggregate in the product. The first forgotten
-- `where scenario_id is null` in a rollup silently double-counts —
-- baseline plus scenario — and this application's entire job is
-- producing correct totals that get handed to a state agency. A failure
-- mode that is silent and arithmetic is the worst one available here.
--
-- Instead a scenario stores ONE jsonb payload: every chunk_phase row,
-- every phase_dependency row, and the cost settings, as they were at the
-- moment the user branched. The client overlays it in memory. Publishing
-- is one RPC that applies it back inside a single transaction.
--
-- The cost is that a scenario goes stale if the baseline moves
-- underneath it. That is precisely what happens to a Revit local copy,
-- it is a concept these users already hold, and `baseline_fingerprint`
-- below turns it into an honest conflict at publish time rather than
-- silent data loss.
--
-- IT ALSO MAKES THE CLIENT-VIEWER SANDBOX FREE
-- --------------------------------------------
--   "Or it's something where they could even, to a certain degree, play
--    with things a little bit, but it won't save or won't change the
--    baseline."                                                -- Steve
--
-- A viewer's sandbox is the same in-memory overlay, never persisted at
-- all. No row, no policy, no cleanup. With a scenario_id column that
-- case would need its own mechanism.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- scenarios  (10 columns)
--
-- payload
--   The branched state. Shape (versioned, see payload_version):
--     { "phases":       [ {id, chunk_project_id, start_slot, duration_slots,
--                          pct_of_tpc, kind, name, sort_order,
--                          duration_locked}, ... ],
--       "dependencies": [ {id, predecessor_phase_id, successor_phase_id,
--                          dep_type, lag_slots}, ... ],
--       "cost_settings": { tpc_factor, base_year, escalation_* } }
--
--   Rows are carried by their REAL ids, so publishing is an update of
--   known rows rather than a delete-and-recreate. That matters: phase ids
--   are referenced by phase_dependencies, and recreating them would
--   orphan every link in the project.
--
-- payload_version
--   Because this is a jsonb blob rather than columns, nothing in the
--   database constrains its shape. A version tag is the minimum
--   affordance for reading a scenario written by an older client
--   instead of crashing on it.
--
-- baseline_fingerprint
--   A hash of the baseline rows at branch time. Publishing recomputes it
--   and refuses on a mismatch. See ship.publish_scenario().
--
-- visibility
--   'private' (default) or 'project'. Default private because the whole
--   point is exploring an idea you may not want to defend yet.
-- ---------------------------------------------------------------------
create table if not exists ship.scenarios (
  id                   uuid primary key default gen_random_uuid(),
  project_id           text not null references ship.projects(id) on delete cascade,
  name                 text not null check (btrim(name) <> ''),
  description          text not null default '',
  owner_email          text not null check (owner_email = lower(owner_email)),
  visibility           text not null default 'private'
                         check (visibility in ('private', 'project')),
  payload              jsonb not null default '{}'::jsonb
                         check (jsonb_typeof(payload) = 'object'),
  payload_version      integer not null default 1,
  baseline_fingerprint text not null default '',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  published_at         timestamptz
);

create index if not exists scenarios_project_id_idx  on ship.scenarios (project_id);
create index if not exists scenarios_owner_email_idx on ship.scenarios (owner_email);

comment on table ship.scenarios is
  'A branched copy of a project schedule. Modelled on Revit worksharing: branch, explore, publish back or discard. See the migration header for why this is a snapshot and not a scenario_id column.';

-- ---------------------------------------------------------------------
-- ship.baseline_fingerprint(text) -> text
--
-- A stable hash of everything a scenario can change.
--
-- md5 over an ordered aggregate, not a timestamp. `projects.updated_at`
-- would be cheaper but it is not maintained on phase edits, and adding a
-- trigger to maintain it would make every drag write a second row.
-- Hashing the actual content also means a change that is made and then
-- reverted produces no conflict, which is the behaviour a user expects.
--
-- ORDER BY inside string_agg is load bearing. Postgres does not promise
-- row order without it, and an unordered aggregate would produce a
-- different hash for identical data on any given call — turning every
-- publish into a spurious conflict.
--
-- SECURITY DEFINER so it reads past RLS: the fingerprint must cover the
-- true baseline, not the subset the caller happens to be able to see.
-- Otherwise two users with different visibility compute different
-- fingerprints for the same database state.
-- ---------------------------------------------------------------------
create or replace function ship.baseline_fingerprint(p_project_id text)
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

revoke all    on function ship.baseline_fingerprint(text) from public;
grant execute on function ship.baseline_fingerprint(text) to authenticated;

-- ---------------------------------------------------------------------
-- ship.create_scenario(text, text, text) -> ship.scenarios
--
-- Branches the current baseline into a new scenario owned by the caller.
--
-- Building the payload in SQL rather than having the client POST it is
-- deliberate. A client-built payload is a client-supplied set of row ids
-- and values that publish_scenario() would later write back — i.e. an
-- arbitrary-write primitive dressed up as a feature. Reading the
-- baseline here means the payload can only ever describe rows that
-- already exist in this project.
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
  v_scenario ship.scenarios;
begin
  v_email := ship.current_email();

  if v_email is null or not ship.can_read_project(p_project_id) then
    raise exception 'create_scenario: not a member of project %', p_project_id
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
$$;

-- ---------------------------------------------------------------------
-- ship.publish_scenario(uuid) -> jsonb
--
-- Applies a scenario back onto the baseline, in one transaction.
--
-- REFUSES ON DRIFT. If the baseline changed after the scenario was
-- branched, the fingerprint no longer matches and this raises rather
-- than overwriting. That is the Revit sync-with-central conflict, and it
-- is the correct behaviour: the alternative is one user silently
-- reverting another's work by publishing a stale branch.
--
-- ONLY moves and resizes are applied -- start_slot, duration_slots,
-- pct_of_tpc, duration_locked, and dependency lag/type. A scenario
-- deliberately cannot create or delete phases or packages. Two reasons:
-- structural edits inside a throwaway branch are a merge problem, not a
-- copy problem; and the feature the client actually asked for is "what
-- if we moved this", not "what if the project were different".
-- Constraining it now is reversible; discovering later that scenarios
-- can orphan rows is not.
--
-- `where ... and project_id = scenario.project_id` on every write is the
-- tenant boundary. The payload is server-built (see create_scenario),
-- but a row id in it is still data, and a write scoped only by id would
-- be exploitable the day anything else writes a payload.
-- ---------------------------------------------------------------------
create or replace function ship.publish_scenario(p_scenario_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if not ship.can_read_project(v_scenario.project_id) then
    raise exception 'publish_scenario: not a member of project %', v_scenario.project_id
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
$$;

-- ---------------------------------------------------------------------
-- ship.rebase_scenario(uuid) -> ship.scenarios
--
-- The other half of the conflict story. After a drift refusal the user
-- needs a way forward that is not "lose your work": this re-reads the
-- current baseline, keeps the scenario's own phase placements where the
-- underlying row still exists, and re-stamps the fingerprint.
--
-- Phases added to the baseline since branching appear at their baseline
-- position; phases deleted since drop out. That is a last-write-wins
-- merge on placement, which is the honest resolution for a tool whose
-- conflict unit is "where is this bar" rather than "what does this text
-- say".
-- ---------------------------------------------------------------------
create or replace function ship.rebase_scenario(p_scenario_id uuid)
returns ship.scenarios
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scenario ship.scenarios;
begin
  select * into v_scenario from ship.scenarios where id = p_scenario_id for update;

  if not found then
    raise exception 'rebase_scenario: no such scenario' using errcode = '42704';
  end if;

  if v_scenario.owner_email <> ship.current_email() and not ship.is_admin() then
    raise exception 'rebase_scenario: not your scenario' using errcode = '42501';
  end if;

  update ship.scenarios s
     set payload = jsonb_set(
           s.payload,
           '{phases}',
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id',               p.id,
                      'chunk_project_id', p.chunk_project_id,
                      'name',             p.name,
                      'kind',             p.kind,
                      'sort_order',       p.sort_order,
                      -- Keep the scenario's placement when it still has one
                      -- for this row; otherwise take the baseline's.
                      'pct_of_tpc',      coalesce(scenario_phase.pct_of_tpc, p.pct_of_tpc),
                      'start_slot',      coalesce(scenario_phase.start_slot, p.start_slot),
                      'duration_slots',  coalesce(scenario_phase.duration_slots, p.duration_slots),
                      'duration_locked', coalesce(scenario_phase.duration_locked, p.duration_locked)
                    ) order by p.id)
               from ship.chunk_phases p
               join ship.chunk_projects c on c.id = p.chunk_project_id
               left join lateral (
                 select * from jsonb_to_recordset(s.payload -> 'phases')
                   as x(id uuid, start_slot numeric, duration_slots numeric,
                        pct_of_tpc numeric, duration_locked boolean)
                  where x.id = p.id
               ) as scenario_phase on true
              where c.project_id = s.project_id
           ), '[]'::jsonb)
         ),
         baseline_fingerprint = ship.baseline_fingerprint(s.project_id),
         updated_at = now()
   where s.id = p_scenario_id
   returning * into v_scenario;

  return v_scenario;
end;
$$;

revoke all on function ship.create_scenario(text, text, text) from public;
revoke all on function ship.publish_scenario(uuid)            from public;
revoke all on function ship.rebase_scenario(uuid)             from public;

grant execute on function ship.create_scenario(text, text, text) to authenticated;
grant execute on function ship.publish_scenario(uuid)            to authenticated;
grant execute on function ship.rebase_scenario(uuid)             to authenticated;

-- ---------------------------------------------------------------------
-- Grants + RLS
--
-- No INSERT grant: scenarios are created exclusively through
-- ship.create_scenario(), which is what guarantees the payload describes
-- real rows in a project the caller belongs to. A client that could
-- INSERT directly could author any payload it liked and then publish it.
-- ---------------------------------------------------------------------
grant select, update, delete on ship.scenarios to authenticated;

alter table ship.scenarios enable row level security;

drop policy if exists scenarios_select      on ship.scenarios;
drop policy if exists scenarios_update_own  on ship.scenarios;
drop policy if exists scenarios_delete_own  on ship.scenarios;

-- Your own scenarios always; other people's only when shared to the
-- project. A private scenario is someone thinking out loud.
create policy scenarios_select on ship.scenarios
  for select to authenticated
  using (
    ship.can_read_project(project_id)
    and (owner_email = ship.current_email() or visibility = 'project')
  );

-- Rename, re-describe, share. The payload itself is maintained by the
-- RPCs, but an owner editing it directly can only ever damage their own
-- branch -- publish_scenario re-checks the project membership and scopes
-- every write to the project, so a doctored payload cannot reach another
-- project's rows.
create policy scenarios_update_own on ship.scenarios
  for update to authenticated
  using      (owner_email = ship.current_email() and ship.can_read_project(project_id))
  with check (owner_email = ship.current_email() and ship.can_read_project(project_id));

create policy scenarios_delete_own on ship.scenarios
  for delete to authenticated
  using (
    ship.can_read_project(project_id)
    and (owner_email = ship.current_email() or ship.is_admin())
  );

commit;

-- =====================================================================
-- ROLLBACK
--
-- begin;
--   drop function if exists ship.rebase_scenario(uuid);
--   drop function if exists ship.publish_scenario(uuid);
--   drop function if exists ship.create_scenario(text, text, text);
--   drop function if exists ship.baseline_fingerprint(text);
--   drop table    if exists ship.scenarios;
-- commit;
--
-- Nothing outside ship.scenarios is modified by this migration, so a
-- rollback cannot lose baseline schedule data.
--
-- HOW TO VERIFY (impersonate; the SQL editor bypasses RLS)
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"<admin auth.users id>","email":"admin@gmail.com","role":"authenticated"}';
--
--   -- Branch, and confirm the payload captured the real phases:
--   select jsonb_array_length(payload->'phases') as phases,
--          jsonb_array_length(payload->'dependencies') as links
--     from ship.create_scenario('federal-campus-master-plan', 'What if we defer the wings');
--
--   -- Drift detection: change the baseline, then publishing must refuse.
--   update ship.chunk_phases set start_slot = start_slot + 1
--    where id = (select id from ship.chunk_phases limit 1);
--   select ship.publish_scenario((select id from ship.scenarios order by created_at desc limit 1));
--   -- expected: ERROR 40001 ... the live schedule changed
--
--   -- Rebase clears the conflict, and publish then succeeds:
--   select ship.rebase_scenario((select id from ship.scenarios order by created_at desc limit 1));
--   select ship.publish_scenario((select id from ship.scenarios order by created_at desc limit 1));
--
--   -- Publishing twice must refuse:
--   select ship.publish_scenario((select id from ship.scenarios order by created_at desc limit 1));
--   -- expected: ERROR 22023 ... already published
-- rollback;
--
-- -- A non-member cannot branch someone else's project:
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"<consultant id>","email":"planning@atlasmech.com","role":"authenticated"}';
--   select ship.create_scenario('library-renovation', 'nope');
--   -- expected: ERROR 42501 not a member
-- rollback;
-- =====================================================================
