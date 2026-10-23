-- =====================================================================
-- 0033_item_org_for_picked_discipline.sql tests
-- Run: node supabase/tests/run.mjs 0033
--
-- Seed facts used (federal-campus-master-plan):
--   admin@gmail.com is the project admin, on the roster under
--   Architecture (FAA); Civil is Terrain Lab (prefix C), Mechanical is
--   Atlas MEP; planning@atlasmech.com is a Mechanical member.
-- =====================================================================
begin;

-- Re-runnable: applying the migration again over itself is a no-op.
-- @include supabase/migrations/0033_item_org_for_picked_discipline.sql

-- ---------------------------------------------------------------------
-- An admin files an item for Civil: Civil's number, Civil's firm.
-- (Before 0033 it took the admin's own firm, FAA.)
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.claim_invite();

insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'Civil', 'T33 civil');
reset role;

select pg_temp.ok(
  (select discipline = 'Civil' and consultant_type = 'Civil' and item_number like 'C%'
          and company_name = 'Terrain Lab' and user_email = 'admin@gmail.com'
     from ship.line_items where name = 'T33 civil'),
  'admin item for Civil is numbered C.., filed under Civil, labelled Terrain Lab, still credited to the admin');

-- ---------------------------------------------------------------------
-- Unchanged: a member filing under their own discipline gets their firm,
-- and an admin's default Architecture item still reads FAA.
-- ---------------------------------------------------------------------
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select ship.claim_invite();
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'planning@atlasmech.com', 'Mechanical', 'T33 mech');
reset role;

select pg_temp.ok(
  (select company_name = 'Atlas MEP' and item_number like 'M%'
     from ship.line_items where name = 'T33 mech'),
  'a member''s own-discipline item keeps their firm');

select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'Architecture', 'T33 arch');
reset role;

select pg_temp.ok(
  (select company_name = 'FAA' and item_number like 'A%'
     from ship.line_items where name = 'T33 arch'),
  'an admin''s Architecture item still reads FAA');

-- ---------------------------------------------------------------------
-- A discipline that is not on the project is still refused.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select pg_temp.throws(
  $q$insert into ship.line_items (project_id, user_email, consultant_type, name)
     values ('federal-campus-master-plan', 'admin@gmail.com', 'Acoustics', 'T33 nope')$q$,
  '22023', 'a discipline off the roster is refused', 'roster');
reset role;

rollback;
