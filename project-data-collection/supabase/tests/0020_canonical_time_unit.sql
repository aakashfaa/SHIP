-- =====================================================================
-- 0020_canonical_time_unit.sql tests  (M-01, decision D-1)
-- Run: node supabase/tests/run.mjs 0020
--
-- Part 1 checks the database as it is after 0020 + seeds: positions are
-- months, the columns say so, and the scenario RPCs work in months.
--
-- Part 2 re-runs the migration's REAL text over staged "before" data, all
-- inside this transaction (rolled back at the end): the run-once marker is
-- removed, federal-campus-master-plan is pretended to have been stored at
-- Quarter zoom (3 months per slot), two what-ifs are staged -- one in step
-- with the live plan, one already stale -- and the conversion must
-- multiply every position by 3, scale the payload numbers and nothing
-- else, re-stamp only the in-step what-if's fingerprint, leave updated_at
-- alone, and then do NOTHING when run a second time.
-- =====================================================================
begin;

-- ---------------------------------------------------------------- part 1

select pg_temp.ok(
  exists (select 1 from ship.schema_conversions where key = 'schedule_months'),
  'D-1 the run-once marker for the months conversion is present');

select pg_temp.ok(
  col_description('ship.chunk_phases'::regclass,
    (select attnum from pg_attribute where attrelid = 'ship.chunk_phases'::regclass and attname = 'start_slot'))
    like 'MONTHS%',
  'D-1 chunk_phases.start_slot is documented as months');

-- The seed writes months directly (seeds run after migrations): PP12's
-- construction is years 11-12 of the fixture = months 132..155.
select pg_temp.ok(
  (select p.start_slot = 132 and p.duration_slots = 24
     from ship.chunk_phases p
     join ship.chunk_projects c on c.id = p.chunk_project_id
    where c.project_id = 'federal-campus-master-plan' and c.chunk_number = 'PP12'
      and p.kind = 'construction'),
  'D-1 seeded PP12 construction is stored as months 132 + 24');

select pg_temp.ok(
  (select array_agg(default_duration_slots order by sort_order)
     from ship.phase_template_steps st
     join ship.phase_templates t on t.id = st.template_id
    where t.is_builtin and t.name = 'DCAMM Study + Design') = array[12, 24, 36]::numeric[],
  'D-1 built-in template defaults are months (1/2/3 years -> 12/24/36)');

-- A what-if saves and publishes month values that no whole-year slot could
-- express (13 months), through the unchanged 0015 RPCs.
select pg_temp.login('admin@gmail.com'); set local role authenticated; select ship.claim_invite(); reset role;

create temp table t20 on commit drop as
select (select p.id from ship.chunk_phases p
          join ship.chunk_projects c on c.id = p.chunk_project_id
         where c.project_id = 'federal-campus-master-plan' and c.chunk_number = 'PP10'
           and p.kind = 'construction') as phase_id,
       null::uuid as scenario_id;
grant select, update on t20 to authenticated;

select pg_temp.login('admin@gmail.com');
set local role authenticated;
update t20 set scenario_id = (ship.create_scenario('federal-campus-master-plan', 'months test')).id;
select ship.save_scenario_payload(
  (select scenario_id from t20),
  jsonb_build_array(jsonb_build_object('id', (select phase_id from t20)::text,
                                       'start_slot', 37, 'duration_slots', 13)),
  '[]'::jsonb);
select pg_temp.ok(
  (select (e ->> 'start_slot')::numeric = 37 and (e ->> 'duration_slots')::numeric = 13
     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') e
    where s.id = (select scenario_id from t20) and (e ->> 'id')::uuid = (select phase_id from t20)),
  'D-1 save_scenario_payload stores a 13-month duration as-is');
select ship.publish_scenario((select scenario_id from t20));
reset role;

select pg_temp.ok(
  (select start_slot = 37 and duration_slots = 13 from ship.chunk_phases where id = (select phase_id from t20)),
  'D-1 publish writes the month values to the live plan');

-- ---------------------------------------------------------------- part 2

-- Stage the "before" world. Positions on federal are now read as QUARTER
-- slots (zoom 4), so the expected result is exactly x3.
update ship.project_timeline_settings set zoom_level = 4, interval_unit = 'quarterly'
 where project_id = 'federal-campus-master-plan';
delete from ship.schema_conversions where key = 'schedule_months';
delete from ship.time_unit_conversion_log;

create temp table before_phases on commit drop as
select p.id, p.start_slot, p.duration_slots
  from ship.chunk_phases p join ship.chunk_projects c on c.id = p.chunk_project_id
 where c.project_id = 'federal-campus-master-plan';
create temp table before_deps on commit drop as
select id, lag_slots from ship.phase_dependencies where project_id = 'federal-campus-master-plan';
create temp table before_steps on commit drop as
select st.id, st.default_duration_slots from ship.phase_template_steps st
  join ship.phase_templates t on t.id = st.template_id where t.project_id is null;

-- Two what-ifs, written directly (as postgres) so the staged values are
-- exactly what we say: one in step with live, one already stale.
insert into ship.scenarios (project_id, name, owner_email, payload, base_payload, baseline_fingerprint, updated_at)
select 'federal-campus-master-plan', 'in step', 'admin@gmail.com',
       jsonb_build_object(
         'phases', jsonb_build_array(
            jsonb_build_object('id', (select phase_id from t20)::text, 'start_slot', 2, 'duration_slots', 1.5,
                               'pct_of_tpc', 90, 'name', 'kept'),
            jsonb_build_object('id', gen_random_uuid()::text, 'start_slot', null)),
         'dependencies', jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'lag_slots', -1)),
         'cost_settings', jsonb_build_object('tpc_factor', 1.33)),
       jsonb_build_object('phases', jsonb_build_array(
            jsonb_build_object('id', (select phase_id from t20)::text, 'start_slot', 4, 'duration_slots', 2))),
       ship.schedule_fingerprint('federal-campus-master-plan'),
       '2026-01-01T00:00:00Z';
insert into ship.scenarios (project_id, name, owner_email, payload, base_payload, baseline_fingerprint, updated_at)
select 'federal-campus-master-plan', 'stale', 'admin@gmail.com', '{"phases": []}', '{"phases": []}', 'stale-fingerprint',
       '2026-01-01T00:00:00Z';

-- First run: converts.
-- @include supabase/migrations/0020_canonical_time_unit.sql

select pg_temp.ok(
  not exists (
    select 1 from before_phases b join ship.chunk_phases p on p.id = b.id
     where p.start_slot <> b.start_slot * 3 or p.duration_slots <> b.duration_slots * 3),
  'M-01 every phase position is multiplied by the project''s months-per-slot (Quarter = 3)');
select pg_temp.ok(
  not exists (
    select 1 from before_deps b join ship.phase_dependencies d on d.id = b.id
     where d.lag_slots <> b.lag_slots * 3),
  'M-01 dependency lags are multiplied too');
select pg_temp.ok(
  not exists (
    select 1 from before_steps b join ship.phase_template_steps st on st.id = b.id
     where st.default_duration_slots <> b.default_duration_slots * 12),
  'M-01 built-in template defaults are multiplied by 12 (they were Year-zoom slots)');
select pg_temp.ok(
  (select months_per_slot = 3 and phases > 0 from ship.time_unit_conversion_log
    where project_id = 'federal-campus-master-plan'),
  'M-01 the factor used is logged per project');

select pg_temp.ok(
  (select (payload -> 'phases' -> 0 ->> 'start_slot')::numeric = 6
      and (payload -> 'phases' -> 0 ->> 'duration_slots')::numeric = 4.5
      and payload -> 'phases' -> 0 ->> 'name' = 'kept'
      and (payload -> 'phases' -> 0 ->> 'pct_of_tpc')::numeric = 90
      and payload -> 'phases' -> 1 -> 'start_slot' = 'null'::jsonb
      and (payload -> 'dependencies' -> 0 ->> 'lag_slots')::numeric = -3
      and payload -> 'cost_settings' = '{"tpc_factor": 1.33}'::jsonb
      and (base_payload -> 'phases' -> 0 ->> 'start_slot')::numeric = 12
      and (base_payload -> 'phases' -> 0 ->> 'duration_slots')::numeric = 6
     from ship.scenarios where name = 'in step'),
  'M-01 scenario payload and base_payload numbers are scaled; every other key is untouched');
select pg_temp.ok(
  (select baseline_fingerprint = ship.schedule_fingerprint(project_id) from ship.scenarios where name = 'in step'),
  'M-01 an in-step what-if is re-stamped, so converting is not a false "live plan changed" conflict');
select pg_temp.ok(
  (select baseline_fingerprint = 'stale-fingerprint' from ship.scenarios where name = 'stale'),
  'M-01 an already-stale what-if stays stale');
select pg_temp.ok(
  (select bool_and(updated_at = '2026-01-01T00:00:00Z') from ship.scenarios where name in ('in step', 'stale')),
  'M-01 converting units does not bump scenarios.updated_at');
select pg_temp.ok(
  (select tgenabled <> 'D' from pg_trigger where tgname = 'scenarios_touch_updated_at'),
  'M-01 the updated_at trigger is switched back on afterwards');

-- Second run: the marker makes it a no-op.
create temp table after_first on commit drop as
select p.id, p.start_slot, p.duration_slots from ship.chunk_phases p;
-- @include supabase/migrations/0020_canonical_time_unit.sql
select pg_temp.ok(
  not exists (
    select 1 from after_first a join ship.chunk_phases p on p.id = a.id
     where p.start_slot <> a.start_slot or p.duration_slots <> a.duration_slots),
  'M-01 running 0020 a second time changes nothing (run-once marker)');
select pg_temp.ok(
  (select (payload -> 'phases' -> 0 ->> 'start_slot')::numeric = 6 from ship.scenarios where name = 'in step'),
  'M-01 ... including scenario payloads');

rollback;
