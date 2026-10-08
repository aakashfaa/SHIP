-- =====================================================================
-- 0015_scenario_hardening.sql tests  (M-07, M-13)
-- Run: node supabase/tests/run.mjs 0015
--
-- The core regression is DATA-1, the exact sequence the audit verified:
-- A branches and moves X; B moves Y (and a link) on the live plan; A's
-- publish conflicts; A rebases; A publishes. Before 0015 that put Y
-- back. Now Y must keep B's value and only X is written.
-- =====================================================================
begin;

select pg_temp.login('planning@atlasmech.com');   set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('consultant1@gmail.com');    set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('electrical@voltworks.com'); set local role authenticated; select ship.claim_invite(); reset role;

-- Two distinct federal phases X and Y, and a dependency D, chosen as postgres.
create temp table fx on commit drop as
select p.id as x_id, p.start_slot as x_start,
       (select p2.id from ship.chunk_phases p2 join ship.chunk_projects c2 on c2.id = p2.chunk_project_id
         where c2.project_id = 'federal-campus-master-plan' and p2.id <> p.id order by p2.id limit 1) as y_id,
       (select d.id from ship.phase_dependencies d where d.project_id = 'federal-campus-master-plan' order by d.id limit 1) as d_id
  from ship.chunk_phases p join ship.chunk_projects c on c.id = p.chunk_project_id
 where c.project_id = 'federal-campus-master-plan'
 order by p.id limit 1;
alter table fx add column y_start numeric, add column d_lag numeric, add column s_id uuid, add column s2_id uuid;
update fx set y_start = (select start_slot from ship.chunk_phases where id = fx.y_id),
              d_lag   = (select lag_slots from ship.phase_dependencies where id = fx.d_id);
grant select, update on fx to authenticated;
select pg_temp.ok((select x_id is not null and y_id is not null and d_id is not null from fx),
                  'setup: federal has two phases and a dependency');

-- ---------------------------------------------------------------------
-- A = planning (editor) branches, and moves X by +2 in the what-if.
-- ---------------------------------------------------------------------
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
update fx set s_id = (ship.create_scenario('federal-campus-master-plan', 'WS1 what-if')).id;

select pg_temp.ok((select base_payload -> 'phases' = payload -> 'phases' and payload ? 'cost_settings'
                     from ship.scenarios where id = (select s_id from fx)),
                  'M-07 create_scenario stores base_payload = branch-time schedule');

select ship.save_scenario_payload(
  (select s_id from fx),
  jsonb_build_array(jsonb_build_object('id', (select x_id from fx), 'start_slot', (select x_start from fx) + 2,
                                       'name', 'ignored', 'kind', 'study')),
  null);

select pg_temp.ok((select (x ->> 'start_slot')::numeric = (select x_start from fx) + 2
                     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') x
                    where s.id = (select s_id from fx) and (x ->> 'id')::uuid = (select x_id from fx)),
                  'M-13 save_scenario_payload merged the move into X');
select pg_temp.ok((select (x ->> 'start_slot')::numeric = (select y_start from fx)
                     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') x
                    where s.id = (select s_id from fx) and (x ->> 'id')::uuid = (select y_id from fx)),
                  'M-13 phases not listed are left untouched');
select pg_temp.ok((select payload ? 'cost_settings' and payload -> 'cost_settings' <> '{}'::jsonb
                     from ship.scenarios where id = (select s_id from fx)),
                  'M-13 save_scenario_payload preserves cost_settings');
select pg_temp.ok((select x ->> 'kind' <> 'study' or x ->> 'name' <> 'ignored'
                     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') x
                    where s.id = (select s_id from fx) and (x ->> 'id')::uuid = (select x_id from fx)),
                  'M-13 non-movable keys (name/kind) in p_phases are ignored');

-- Validation.
select pg_temp.throws($q$select ship.save_scenario_payload((select s_id from fx),
  jsonb_build_array(jsonb_build_object('id', (select x_id from fx), 'duration_slots', 0)), null)$q$,
  '22023', 'M-13 duration_slots < 1 refused');
select pg_temp.throws($q$select ship.save_scenario_payload((select s_id from fx),
  jsonb_build_array(jsonb_build_object('id', (select x_id from fx), 'start_slot', -1)), null)$q$,
  '22023', 'M-13 start_slot < 0 refused');
select pg_temp.throws($q$select ship.save_scenario_payload((select s_id from fx),
  jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'start_slot', 1)), null)$q$,
  '22023', 'M-13 a phase id outside the project is refused', 'is not part of project');
select pg_temp.throws($q$select ship.save_scenario_payload((select s_id from fx), null,
  jsonb_build_array(jsonb_build_object('id', (select d_id from fx), 'dep_type', 'XX')))$q$,
  '22023', 'M-13 an invalid dep_type is refused');

-- Direct writes to protected columns are gone.
select pg_temp.throws($q$update ship.scenarios set payload = '{}'::jsonb where id = (select s_id from fx)$q$,
                      '42501', 'M-13 owner cannot write payload directly');
select pg_temp.throws($q$update ship.scenarios set published_at = now() where id = (select s_id from fx)$q$,
                      '42501', 'M-13 owner cannot fake published_at');
select pg_temp.throws($q$update ship.scenarios set baseline_fingerprint = 'x' where id = (select s_id from fx)$q$,
                      '42501', 'M-13 owner cannot overwrite baseline_fingerprint');
select pg_temp.throws($q$update ship.scenarios set base_payload = '{}'::jsonb where id = (select s_id from fx)$q$,
                      '42501', 'M-13 owner cannot overwrite base_payload');
update ship.scenarios set name = 'WS1 what-if (renamed)', description = 'd' where id = (select s_id from fx);
select pg_temp.ok((select name from ship.scenarios where id = (select s_id from fx)) = 'WS1 what-if (renamed)',
                  'M-13 owner can still rename / describe');
reset role;

-- ---------------------------------------------------------------------
-- B = admin moves Y (+3) and changes D's lag on the LIVE plan.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
update ship.chunk_phases set start_slot = start_slot + 3 where id = (select y_id from fx);
update ship.phase_dependencies set lag_slots = lag_slots + 1 where id = (select d_id from fx);
reset role;

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$select ship.publish_scenario((select s_id from fx))$q$,
                      '40001', 'M-07 publish after a live edit conflicts');

select ship.rebase_scenario((select s_id from fx));

select pg_temp.ok((select (x ->> 'start_slot')::numeric = (select x_start from fx) + 2
                     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') x
                    where s.id = (select s_id from fx) and (x ->> 'id')::uuid = (select x_id from fx)),
                  'M-07 rebase keeps MY move of X');
select pg_temp.ok((select (x ->> 'start_slot')::numeric = (select y_start from fx) + 3
                     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') x
                    where s.id = (select s_id from fx) and (x ->> 'id')::uuid = (select y_id from fx)),
                  'M-07 rebase pulls in the colleague''s move of Y');
select pg_temp.ok((select (x ->> 'lag_slots')::numeric = (select d_lag from fx) + 1
                     from ship.scenarios s, jsonb_array_elements(s.payload -> 'dependencies') x
                    where s.id = (select s_id from fx) and (x ->> 'id')::uuid = (select d_id from fx)),
                  'M-07 rebase pulls in the colleague''s dependency change');

select pg_temp.ok((ship.publish_scenario((select s_id from fx)) ->> 'phases_updated')::int = 1,
                  'M-07 publish writes only the one phase that differs (was: every phase)');
reset role;

select pg_temp.ok((select start_slot from ship.chunk_phases where id = (select y_id from fx)) = (select y_start from fx) + 3,
                  'M-07 DATA-1 regression: the colleague''s move of Y survived rebase + publish');
select pg_temp.ok((select lag_slots from ship.phase_dependencies where id = (select d_id from fx)) = (select d_lag from fx) + 1,
                  'M-07 the colleague''s dependency change survived too');
select pg_temp.ok((select start_slot from ship.chunk_phases where id = (select x_id from fx)) = (select x_start from fx) + 2,
                  'M-07 my move of X is live');

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$select ship.save_scenario_payload((select s_id from fx), '[]'::jsonb, null)$q$,
                      '22023', 'a published scenario is read-only');
reset role;

-- ---------------------------------------------------------------------
-- M-13: publish someone else's PRIVATE what-if; ownership on save.
-- consultant1 (consultant) owns s2; planning (editor) tries to publish.
-- ---------------------------------------------------------------------
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
update fx set s2_id = (ship.create_scenario('federal-campus-master-plan', 'WS1 private idea')).id;
reset role;

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$select ship.publish_scenario((select s2_id from fx))$q$,
                      '42501', 'M-13 an editor cannot publish someone else''s private what-if', 'private');
select pg_temp.throws($q$select ship.save_scenario_payload((select s2_id from fx), '[]'::jsonb, null)$q$,
                      '42501', 'M-13 only the owner can save a scenario payload');
reset role;

select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
update ship.scenarios set visibility = 'project' where id = (select s2_id from fx);
select pg_temp.throws($q$select ship.publish_scenario((select s2_id from fx))$q$,
                      '42501', 'consultant (owner) still cannot publish: edit rights required', 'edit access');
reset role;

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.ok((ship.publish_scenario((select s2_id from fx)) ->> 'scenario_id') is not null,
                  'M-13 once shared (visibility=project) an editor can publish it');
reset role;

-- ---------------------------------------------------------------------
-- M-13: a removed owner can no longer rebase (and read live through it).
-- ---------------------------------------------------------------------
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
update fx set s2_id = (ship.create_scenario('federal-campus-master-plan', 'WS1 before removal')).id;
reset role;
delete from ship.project_roles where project_id = 'federal-campus-master-plan' and email = 'consultant1@gmail.com';
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select pg_temp.throws($q$select ship.rebase_scenario((select s2_id from fx))$q$,
                      '42501', 'M-13 a removed owner cannot rebase', 'no longer have access');
select pg_temp.throws($q$select ship.save_scenario_payload((select s2_id from fx), '[]'::jsonb, null)$q$,
                      '42501', 'M-13 a removed owner cannot save either');
reset role;

-- Deactivated owner, same rule.
update ship.profiles set is_active = false where email = 'planning@atlasmech.com';
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$select ship.rebase_scenario((select s_id from fx))$q$,
                      '42501', 'M-13 a deactivated owner cannot rebase');
reset role;
update ship.profiles set is_active = true where email = 'planning@atlasmech.com';

-- ---------------------------------------------------------------------
-- M-13: baseline_fingerprint is no longer an oracle.
-- electrical is a viewer on federal and has no access to library.
-- ---------------------------------------------------------------------
select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok(ship.baseline_fingerprint('library-renovation') is null,
                  'M-13 baseline_fingerprint returns NULL for a project you cannot read');
select pg_temp.ok(ship.baseline_fingerprint('federal-campus-master-plan') is not null,
                  'M-13 baseline_fingerprint still works for a project you can read');
reset role;

rollback;
