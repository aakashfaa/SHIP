-- =====================================================================
-- 0033_item_org_for_picked_discipline.sql tests
-- Run: node supabase/tests/run.mjs 0033
--
-- Seed facts used (federal-campus-master-plan):
--   admin@gmail.com is the project admin, on the roster under
--   Architecture (FAA); Civil is Terrain Lab (prefix C), Mechanical is
--   Atlas MEP; planning@atlasmech.com is a Mechanical member and an
--   editor. Plumbing is not on the roster.
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
-- A built-in discipline nobody on the project has: Plumbing numbers P..,
-- and with no firm on the roster it reads Unknown Organization -- not the
-- admin's own firm.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'Plumbing', 'T33 plumbing');
-- "Other": a discipline typed into the form, new to the project.
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'admin@gmail.com', 'acoustics', 'T33 acoustics');
reset role;

select pg_temp.ok(
  (select item_number = 'P1' and company_name = 'Unknown Organization'
     from ship.line_items where name = 'T33 plumbing'),
  'an off-roster built-in discipline: P1, Unknown Organization');

select pg_temp.ok(
  (select li.item_number = dp.prefix || '1' and li.discipline = 'acoustics'
     from ship.line_items li
     join ship.project_discipline_prefixes dp
       on dp.project_id = li.project_id and dp.discipline_key = 'acoustics'
    where li.name = 'T33 acoustics'),
  'an admin''s typed discipline gets a prefix allocated and is numbered 1');

-- An FAA editor (not an admin) may type one too.
select pg_temp.make_user('megan@faainc.com');
insert into ship.pending_invites (email, role, invited_by)
values ('megan@faainc.com', 'consultant', (select id from auth.users where email = 'admin@gmail.com'));
insert into ship.project_roles (project_id, email, role)
values ('federal-campus-master-plan', 'megan@faainc.com', 'editor');
select pg_temp.login('megan@faainc.com');
set local role authenticated;
select ship.claim_invite();
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'megan@faainc.com', 'Lighting', 'T33 lighting');
reset role;

select pg_temp.ok(
  (select item_number like '%1' and discipline = 'Lighting'
     from ship.line_items where name = 'T33 lighting'),
  'an @faainc.com editor may file under a typed discipline');

-- An editor from another firm may not: the discipline is still refused.
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws(
  $q$insert into ship.line_items (project_id, user_email, consultant_type, name)
     values ('federal-campus-master-plan', 'planning@atlasmech.com', 'Glazing', 'T33 nope')$q$,
  '22023', 'a non-FAA editor cannot invent a discipline', 'roster');
reset role;

rollback;
