-- =====================================================================
-- 0034_item_org_is_submitters_firm.sql tests
-- Run: node supabase/tests/run.mjs 0034
--
-- Seed facts used (federal-campus-master-plan):
--   admin@gmail.com is the project admin, on the roster under
--   Architecture (FAA); Civil is Terrain Lab; planning@atlasmech.com is a
--   Mechanical member (Atlas MEP) and an editor. Envelope and Plumbing
--   are not on the roster.
-- =====================================================================
begin;

-- Re-runnable: applying the migration again over itself is a no-op.
-- @include supabase/migrations/0034_item_org_is_submitters_firm.sql

-- ---------------------------------------------------------------------
-- The reported case: an FAA user files Envelope items on a project with
-- no Envelope firm. They read FAA, not Unknown Organization.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.claim_invite();
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'Envelope', 'T34 envelope');
-- A picked discipline that DOES have a firm still reads the submitter's.
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'Civil', 'T34 civil');
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'Architecture', 'T34 arch');
reset role;

select pg_temp.ok(
  (select company_name = 'FAA' and org_discipline = 'Architecture' and item_number like 'EN%'
     from ship.line_items where name = 'T34 envelope'),
  'an FAA admin''s Envelope item reads FAA and follows Architecture');

select pg_temp.ok(
  (select company_name = 'FAA' and org_discipline = 'Architecture' and item_number like 'C%'
     from ship.line_items where name = 'T34 civil'),
  'an FAA admin''s Civil item reads FAA, not Terrain Lab');

select pg_temp.ok(
  (select company_name = 'FAA' and org_discipline is null
     from ship.line_items where name = 'T34 arch'),
  'an own-discipline item is unchanged: FAA, org_discipline NULL');

-- Unchanged: a member filing under their own discipline.
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select ship.claim_invite();
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'planning@atlasmech.com', 'Mechanical', 'T34 mech');
reset role;

select pg_temp.ok(
  (select company_name = 'Atlas MEP' and org_discipline is null
     from ship.line_items where name = 'T34 mech'),
  'a member''s own-discipline item keeps their firm');

-- Unchanged: a submitter with no firm on the project (a service import)
-- gets the discipline's roster firm.
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'importer@example.com', 'Civil', 'T34 import');

select pg_temp.ok(
  (select company_name = 'Terrain Lab' and org_discipline is null
     from ship.line_items where name = 'T34 import'),
  'an off-roster submitter''s item takes the discipline''s firm');

-- ---------------------------------------------------------------------
-- Roster saves: re-inserting Envelope / Civil leaves the FAA items alone;
-- renaming the Architecture firm reaches them.
-- ---------------------------------------------------------------------
insert into ship.project_consultants (project_id, consultant_type, org_name)
values ('federal-campus-master-plan', 'Envelope', 'Skin Co');
update ship.project_consultants set org_name = org_name
 where project_id = 'federal-campus-master-plan' and consultant_type = 'Civil';
delete from ship.project_consultants
 where project_id = 'federal-campus-master-plan' and consultant_type = 'Civil';
insert into ship.project_consultants (project_id, consultant_type, org_name)
values ('federal-campus-master-plan', 'Civil', 'Terrain Lab');

select pg_temp.ok(
  (select bool_and(company_name = 'FAA')
     from ship.line_items where name in ('T34 envelope', 'T34 civil')),
  'saving the Envelope / Civil roster rows does not relabel FAA''s items');

select pg_temp.ok(
  (select company_name = 'Terrain Lab'
     from ship.line_items where name = 'T34 import'),
  'items that follow Civil still follow it');

update ship.project_consultants set org_name = 'FAA Inc'
 where project_id = 'federal-campus-master-plan' and consultant_type = 'Architecture';

select pg_temp.ok(
  (select bool_and(company_name = 'FAA Inc')
     from ship.line_items where name in ('T34 envelope', 'T34 civil', 'T34 arch')),
  'renaming the Architecture firm reaches the items filed for other disciplines');

-- ---------------------------------------------------------------------
-- Guard: a client may not set or change org_discipline.
-- ---------------------------------------------------------------------
-- (planning@atlasmech.com: a platform admin is trusted by the guard.)
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, name, org_discipline)
values ('federal-campus-master-plan', 'planning@atlasmech.com', 'Mechanical', 'T34 sneaky', 'Civil');
select pg_temp.throws(
  $q$update ship.line_items set org_discipline = 'Civil' where name = 'T34 sneaky'$q$,
  '42501', 'a client cannot change org_discipline', 'org_discipline');
reset role;

select pg_temp.ok(
  (select org_discipline is null from ship.line_items where name = 'T34 sneaky'),
  'a client-supplied org_discipline is cleared on insert');

-- ---------------------------------------------------------------------
-- Backfill: an item 0033 labelled Unknown Organization is repaired; one
-- that already names a firm is not.
-- ---------------------------------------------------------------------
delete from ship.project_consultants
 where project_id = 'federal-campus-master-plan' and consultant_type = 'Envelope';
update ship.project_consultants set org_name = 'FAA'
 where project_id = 'federal-campus-master-plan' and consultant_type = 'Architecture';
-- Staged as trusted (no JWT), so the guard keeps the labels as given.
select set_config('request.jwt.claims', '', true);
insert into ship.line_items (project_id, user_email, consultant_type, name, company_name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'Plumbing', 'T34 old unknown', 'Unknown Organization'),
       ('federal-campus-master-plan', 'admin@gmail.com', 'Civil',    'T34 old civil',   'Terrain Lab');

-- @include supabase/migrations/0034_item_org_is_submitters_firm.sql

select pg_temp.ok(
  (select company_name = 'FAA' and org_discipline = 'Architecture'
     from ship.line_items where name = 'T34 old unknown'),
  'backfill: an Unknown Organization item takes its submitter''s firm');

select pg_temp.ok(
  (select company_name = 'Terrain Lab' and org_discipline is null
     from ship.line_items where name = 'T34 old civil'),
  'backfill: an item that already names a firm is left alone');

rollback;
