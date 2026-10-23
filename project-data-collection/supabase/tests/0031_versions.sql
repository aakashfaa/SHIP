-- =====================================================================
-- 0031_versions.sql tests  (peer versions replace the what-if)
-- Run: node supabase/tests/run.mjs 0031
--
-- Replaces 0015_scenario_hardening.sql, whose subject (rebase/publish of
-- a private what-if) 0031 removed. The access rules it guarded carry
-- over: only admins/editors write, and losing access stops the writes.
--
-- Seed facts used (federal-campus-master-plan):
--   admin@gmail.com = admin, planning@atlasmech.com = editor,
--   consultant1@gmail.com = consultant, electrical@voltworks.com = viewer.
-- =====================================================================
begin;

select pg_temp.login('planning@atlasmech.com');   set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('consultant1@gmail.com');    set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('electrical@voltworks.com'); set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('admin@gmail.com');          set local role authenticated; select ship.claim_invite(); reset role;

-- Start from a project holding only its live version.
delete from ship.scenarios where project_id = 'federal-campus-master-plan';
update ship.projects set live_version_name = 'Version 1' where id = 'federal-campus-master-plan';

create temp table t31 on commit drop as
select null::uuid as v2, null::uuid as v3, null::uuid as v4;
grant select, update on t31 to authenticated;

-- ---------------------------------------------------------------------
-- Who may create.
-- ---------------------------------------------------------------------
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
update t31 set v2 = (ship.create_version('federal-campus-master-plan', 'Version 2')).id;
reset role;

select pg_temp.ok(
  (select visibility = 'project' and payload_version = 2
          and jsonb_array_length(payload -> 'phases') =
              (select count(*) from ship.chunk_phases p join ship.chunk_projects c on c.id = p.chunk_project_id
                where c.project_id = 'federal-campus-master-plan')
     from ship.scenarios where id = (select v2 from t31)),
  'an editor creates a team version holding a full copy of the live phases');

select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select pg_temp.throws($q$select ship.create_version('federal-campus-master-plan', 'nope')$q$,
                      '42501', 'a consultant cannot create a version');
select pg_temp.throws($q$select ship.save_version_phases((select v2 from t31), '[]'::jsonb)$q$,
                      '42501', 'a consultant cannot edit a version');
reset role;

select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.throws($q$select ship.create_version('federal-campus-master-plan', 'nope')$q$,
                      '42501', 'a viewer cannot create a version');
select pg_temp.ok(
  (select count(*) = 1 from ship.scenarios where id = (select v2 from t31)),
  'a viewer can see the team''s versions');
reset role;

-- ---------------------------------------------------------------------
-- Rename, duplicate, edit.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.rename_version('federal-campus-master-plan', (select v2 from t31), 'Phased plan');
update t31 set v3 = (ship.create_version('federal-campus-master-plan', 'Phased plan copy', (select v2 from t31))).id;
select ship.save_version_phases(
  (select v3 from t31),
  (select jsonb_agg(case when ord = 1 then e || '{"start_slot": 99}'::jsonb else e end)
     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') with ordinality as x(e, ord)
    where s.id = (select v3 from t31)));
reset role;

-- A blank phase name (chunk_phases.name defaults to '') is copied into a
-- version as-is and must not block saving it.
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.save_version_phases(
  (select v2 from t31),
  (select jsonb_agg(case when ord = 1 then e || '{"name": ""}'::jsonb else e end)
     from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') with ordinality as x(e, ord)
    where s.id = (select v2 from t31)));
select pg_temp.throws(
  $q$select ship.save_version_phases((select v2 from t31),
       (select jsonb_agg(e - 'name') from ship.scenarios s, jsonb_array_elements(s.payload -> 'phases') e
         where s.id = (select v2 from t31)))$q$,
  '22023', 'a phase with no name at all is still refused');
reset role;

select pg_temp.ok(
  (select payload -> 'phases' -> 0 ->> 'name' = '' from ship.scenarios where id = (select v2 from t31)),
  'a version saves with a blank phase name');

select pg_temp.ok(
  (select name = 'Phased plan' from ship.scenarios where id = (select v2 from t31)),
  'rename_version renames');
select pg_temp.ok(
  (select (payload -> 'phases' -> 0 ->> 'start_slot')::numeric = 99 from ship.scenarios where id = (select v3 from t31))
  and (select (payload -> 'phases' -> 0 ->> 'start_slot')::numeric <> 99 from ship.scenarios where id = (select v2 from t31)),
  'editing the duplicate leaves the original alone');
select pg_temp.ok(
  not exists (select 1 from ship.chunk_phases where start_slot = 99),
  'editing a version leaves the live plan alone');

-- ---------------------------------------------------------------------
-- Delete: another version, then the live one (promotes), then the last.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
update t31 set v4 = (ship.create_version('federal-campus-master-plan', 'Throwaway')).id;
select ship.delete_version('federal-campus-master-plan', (select v4 from t31));
reset role;

select pg_temp.ok(
  not exists (select 1 from ship.scenarios where id = (select v4 from t31)),
  'deleting a non-live version removes it');

select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.delete_version('federal-campus-master-plan', null, (select v3 from t31));
reset role;

select pg_temp.ok(
  (select live_version_name = 'Phased plan copy' from ship.projects where id = 'federal-campus-master-plan')
  and exists (select 1 from ship.chunk_phases where start_slot = 99)
  and not exists (select 1 from ship.scenarios where id = (select v3 from t31)),
  'deleting the live version moves the chosen one into the live tables');

select pg_temp.ok(
  (select (payload -> 'phases' -> 0 ->> 'start_slot')::numeric <> 99 from ship.scenarios where id = (select v2 from t31)),
  'the other version is unchanged by the switch');

select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.delete_version('federal-campus-master-plan', (select v2 from t31));
select pg_temp.throws($q$select ship.delete_version('federal-campus-master-plan', null)$q$,
                      '22023', 'the last version cannot be deleted', 'last one');
reset role;

-- ---------------------------------------------------------------------
-- Losing access stops the writes (carried over from 0015, M-13).
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
update t31 set v2 = (ship.create_version('federal-campus-master-plan', 'After')).id;
reset role;

delete from ship.project_roles
 where project_id = 'federal-campus-master-plan' and email = 'planning@atlasmech.com';

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$select ship.rename_version('federal-campus-master-plan', (select v2 from t31), 'x')$q$,
                      '42501', 'a former editor cannot rename a version');
select pg_temp.throws($q$select ship.save_version_phases((select v2 from t31), '[]'::jsonb)$q$,
                      '42501', 'a former editor cannot edit a version');
reset role;

set local role anon;
select pg_temp.throws($q$select ship.create_version('federal-campus-master-plan', 'anon')$q$,
                      '42501', 'anon cannot call create_version');
reset role;

rollback;
