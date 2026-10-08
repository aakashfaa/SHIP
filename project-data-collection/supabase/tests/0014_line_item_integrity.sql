-- =====================================================================
-- 0014_line_item_integrity.sql tests  (M-11, M-12, D-9)
-- Run: node supabase/tests/run.mjs 0014
-- =====================================================================
begin;

-- consultant1: consultant on federal (project_roles), member on library.
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select ship.claim_invite();

-- ---------------------------------------------------------------------
-- M-11 on INSERT: a contributor cannot choose system values.
-- ---------------------------------------------------------------------
insert into ship.line_items (project_id, user_email, consultant_type, name,
  item_number, company_name, created_at,
  addressing_resiliency_sustainability, addressing_deferred_maintenance,
  code_life_safety_improvement, accessibility_improvement, historic_impact,
  estimated_first_cost)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'WS1 probe item',
  'ZZ99', 'Fake Corp', '2000-01-01',
  'No', 'No', 'No', 'No', 'No', '850k');

create temp table probe on commit drop as
select * from ship.line_items where name = 'WS1 probe item';

select pg_temp.ok((select item_number from probe) ~ '^A[0-9]+$',
                  'M-11 insert: forged item_number ignored, server assigned ' || (select item_number from probe));
select pg_temp.ok((select company_name from probe) <> 'Fake Corp',
                  'M-11 insert: forged company_name ignored (got ' || (select company_name from probe) || ')');
select pg_temp.ok((select created_at from probe) > now() - interval '1 minute',
                  'M-11 insert: forged created_at ignored');

-- D-9: number + dropdown columns default to NULL (unanswered).
select pg_temp.ok((select annual_energy_savings is null and annual_cost_savings is null from probe),
                  'D-9 omitted annual savings are stored as NULL, not 0');
select pg_temp.ok((select operational_impact is null and category is null from probe),
                  'D-9 omitted dropdowns are stored as NULL');

-- ---------------------------------------------------------------------
-- M-11 on UPDATE: each system column refuses a change, 42501.
-- ---------------------------------------------------------------------
select pg_temp.throws($q$update ship.line_items set item_number = 'ZZ99' where name = 'WS1 probe item'$q$,
                      '42501', 'M-11 consultant cannot change item_number', 'item_number can''t be changed');
select pg_temp.throws($q$update ship.line_items set company_name = 'Fake Corp' where name = 'WS1 probe item'$q$,
                      '42501', 'M-11 consultant cannot change company_name', 'company_name can''t be changed');
select pg_temp.throws($q$update ship.line_items set created_at = '2000-01-01' where name = 'WS1 probe item'$q$,
                      '42501', 'M-11 consultant cannot backdate created_at', 'created_at can''t be changed');
select pg_temp.throws($q$update ship.line_items set consultant_type = 'Civil' where name = 'WS1 probe item'$q$,
                      '42501', 'M-11 consultant cannot change consultant_type', 'consultant_type can''t be changed');
select pg_temp.throws($q$update ship.line_items set discipline = 'Civil' where name = 'WS1 probe item'$q$,
                      '42501', 'M-11 consultant cannot change discipline', 'discipline can''t be changed');
select pg_temp.throws($q$update ship.line_items set ecc_amount = 1 where name = 'WS1 probe item'$q$,
                      '42501', 'M-11 consultant cannot write ecc_amount', 'ecc_amount can''t be changed');

-- M-12: project_id is immutable (consultant1 can write in library too).
select pg_temp.throws($q$update ship.line_items set project_id = 'library-renovation' where name = 'WS1 probe item'$q$,
                      '42501', 'M-12 a line item cannot be moved to another project', 'project_id can''t be changed');

-- Ordinary edits, including a whole-row resend of unchanged system
-- columns (what the old mapper does), still work.
update ship.line_items
   set name = 'WS1 probe item', short_description = 'edited',
       estimated_first_cost = '1.2m',
       item_number = (select item_number from probe),
       company_name = (select company_name from probe),
       user_email = 'Consultant1@Gmail.com',
       created_at = (select created_at from probe),
       annual_energy_savings = 0
 where name = 'WS1 probe item';
select pg_temp.ok((select short_description = 'edited' and ecc_amount = 1200000 and annual_energy_savings = 0
                     from ship.line_items where name = 'WS1 probe item'),
                  'M-11 normal edit + unchanged system columns accepted; ecc recomputed; 0 stays 0');
update ship.line_items set annual_energy_savings = null where name = 'WS1 probe item';
select pg_temp.ok((select annual_energy_savings is null from ship.line_items where name = 'WS1 probe item'),
                  'D-9 a number can be set back to blank (NULL)');
select pg_temp.throws($q$update ship.line_items set operational_impact = '' where name = 'WS1 probe item'$q$,
                      '23514', 'D-9 note: blank dropdowns must be NULL; '''' still fails the CHECK list');
reset role;

-- ---------------------------------------------------------------------
-- Platform admin may correct system columns, but not project_id.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
update ship.line_items set company_name = 'Corrected Co' where name = 'WS1 probe item';
select pg_temp.ok((select company_name from ship.line_items where name = 'WS1 probe item') = 'Corrected Co',
                  'M-11 a platform admin can still correct company_name');
select pg_temp.throws($q$update ship.line_items set project_id = 'library-renovation' where name = 'WS1 probe item'$q$,
                      '42501', 'M-12 not even a platform admin can move an item between projects');

-- ---------------------------------------------------------------------
-- M-11 / DATA-6: numbering skips a number that is already taken.
-- Squat the NEXT Architecture number on federal, then insert.
-- ---------------------------------------------------------------------
reset role;
create temp table next_arch on commit drop as
select 'A' || next_value as num from ship.item_number_counters
 where project_id = 'federal-campus-master-plan' and discipline = 'Architecture';
grant select on next_arch to authenticated;
select pg_temp.login('admin@gmail.com');
set local role authenticated;
update ship.line_items set item_number = (select num from next_arch) where name = 'WS1 probe item';
reset role;

select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, name,
  addressing_resiliency_sustainability, addressing_deferred_maintenance,
  code_life_safety_improvement, accessibility_improvement, historic_impact)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'WS1 probe item 2',
  'No', 'No', 'No', 'No', 'No');
select pg_temp.ok(
  (select item_number from ship.line_items where name = 'WS1 probe item 2')
    = 'A' || (substring((select num from next_arch) from 2)::int + 1),
  'DATA-6 insert after a squatted number succeeds and skips it (got '
    || (select item_number from ship.line_items where name = 'WS1 probe item 2') || ')');
reset role;

-- ---------------------------------------------------------------------
-- M-12: packages cannot link a line item from another project.
-- planning is an editor on federal; admin can edit everything.
-- ---------------------------------------------------------------------
insert into ship.line_items (project_id, user_email, consultant_type, name,
  addressing_resiliency_sustainability, addressing_deferred_maintenance,
  code_life_safety_improvement, accessibility_improvement, historic_impact)
values ('library-renovation', 'consultant1@gmail.com', 'Architecture', 'WS1 library probe',
  'No', 'No', 'No', 'No', 'No');
create temp table library_item on commit drop as
select id from ship.line_items where name = 'WS1 library probe';
create temp table fed_item on commit drop as
select li.id from ship.line_items li
 where li.project_id = 'federal-campus-master-plan'
   and not exists (select 1 from ship.chunk_project_items x
                    where x.line_item_id = li.id
                      and x.chunk_project_id = '00000000-0000-4000-8000-000000000101')
 limit 1;
grant select on library_item, fed_item to authenticated;

select pg_temp.login('admin@gmail.com');
set local role authenticated;
select pg_temp.throws($q$insert into ship.chunk_project_items (chunk_project_id, line_item_id, quantity)
                         values ('00000000-0000-4000-8000-000000000101', (select id from library_item), '1')$q$,
                      '23514', 'M-12 a federal package cannot link a library line item (admin)');
insert into ship.chunk_project_items (chunk_project_id, line_item_id, quantity)
values ('00000000-0000-4000-8000-000000000101', (select id from fed_item), '1');
select pg_temp.ok(true, 'M-12 same-project links still work');
select pg_temp.throws($q$update ship.chunk_project_items set line_item_id = (select id from library_item)
                          where line_item_id = (select id from fed_item)
                            and chunk_project_id = '00000000-0000-4000-8000-000000000101'$q$,
                      '23514', 'M-12 an existing link cannot be re-pointed at another project''s item');
reset role;

select pg_temp.ok((select count(*) from ship.chunk_project_items cpi
                     join ship.chunk_projects c on c.id = cpi.chunk_project_id
                     join ship.line_items li on li.id = cpi.line_item_id
                    where c.project_id <> li.project_id) = 0,
                  'M-12 no cross-project package links exist');

rollback;
