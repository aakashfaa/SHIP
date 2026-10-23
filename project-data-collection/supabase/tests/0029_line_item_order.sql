-- =====================================================================
-- 0029_line_item_order.sql tests  (drag-to-reorder + gap-free numbers)
-- Run: node supabase/tests/run.mjs 0029
--
-- Seed facts used (federal-campus-master-plan):
--   A1..A3 belong to admin@gmail.com; consultant1 = consultant,
--   planning@atlasmech.com = editor, electrical@voltworks.com = viewer.
-- =====================================================================
begin;

-- Re-runnable: applying the migration again over itself is a no-op.
-- @include supabase/migrations/0029_line_item_order.sql

select pg_temp.ok(
  (select count(*) = 0 from ship.line_items where sort_order is null),
  'every line item has a sort_order after the backfill');

select pg_temp.ok(
  not exists (
    select 1 from ship.line_items li
     where li.item_number <> (
       select pl.target_number from ship.line_item_number_plan(li.project_id) pl where pl.id = li.id)),
  'every existing item already holds its gap-free number');

-- Helper: the Architecture numbers of the T29 items, in name order.
create or replace function pg_temp.t29_numbers()
returns text
language sql
as $$
  select string_agg(li.name || '=' || li.item_number, ' ' order by li.name)
    from ship.line_items li
   where li.project_id = 'federal-campus-master-plan' and li.name like 'T29 %'
$$;
grant execute on function pg_temp.t29_numbers() to authenticated;

create or replace function pg_temp.t29_id(p_name text)
returns uuid
language sql
as $$
  select li.id from ship.line_items li
   where li.project_id = 'federal-campus-master-plan' and li.name = p_name
$$;
grant execute on function pg_temp.t29_id(text) to authenticated;

-- ---------------------------------------------------------------------
-- Inserts go last and take the next number.
-- ---------------------------------------------------------------------
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select ship.claim_invite();

insert into ship.line_items (project_id, user_email, consultant_type, name, sort_order)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'T29 a', -50);
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'T29 b'),
       ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'T29 c');
reset role;

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, discipline, name)
values ('federal-campus-master-plan', 'planning@atlasmech.com', 'Architecture', 'Architecture', 'T29 x');
reset role;

select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'T29 d');

select pg_temp.ok(pg_temp.t29_numbers() = 'T29 a=A4 T29 b=A5 T29 c=A6 T29 d=A8 T29 x=A7',
                  'inserts numbered in arrival order: ' || pg_temp.t29_numbers());
select pg_temp.ok(
  (select sort_order from ship.line_items where id = pg_temp.t29_id('T29 a'))
    = (select max(sort_order) from ship.line_items
        where project_id = 'federal-campus-master-plan' and name not like 'T29 %') + 1,
  'a client-supplied sort_order (-50) is ignored; the new item goes last');

-- ---------------------------------------------------------------------
-- Direct writes stay blocked.
-- ---------------------------------------------------------------------
select pg_temp.throws($q$update ship.line_items set sort_order = 0 where name = 'T29 a'$q$,
                      '42501', 'a consultant cannot PATCH sort_order', 'sort_order can''t be changed');
select pg_temp.throws($q$update ship.line_items set item_number = 'A1' where name = 'T29 a'$q$,
                      '42501', 'a consultant still cannot PATCH item_number', 'item_number can''t be changed');

-- ---------------------------------------------------------------------
-- Reorder own items: only these items swap slots; x (editor's) stays.
-- ---------------------------------------------------------------------
select ship.reorder_line_items('federal-campus-master-plan',
  array[pg_temp.t29_id('T29 d'), pg_temp.t29_id('T29 a'), pg_temp.t29_id('T29 b'), pg_temp.t29_id('T29 c')]);

select pg_temp.ok(pg_temp.t29_numbers() = 'T29 a=A5 T29 b=A6 T29 c=A8 T29 d=A4 T29 x=A7',
                  'consultant reorder (d,a,b,c): d=A4, x keeps A7, c=A8: ' || pg_temp.t29_numbers());
select pg_temp.ok((select string_agg(item_number, ',' order by item_number) from ship.line_items
                    where project_id = 'federal-campus-master-plan' and user_email = 'admin@gmail.com'
                      and discipline = 'Architecture') = 'A1,A2,A3',
                  'other people''s items (admin A1-A3) did not move');
select pg_temp.ok(coalesce(current_setting('ship.renumbering', true), '') <> 'on',
                  'the renumbering flag is off again after the call');

-- Permission denials.
select pg_temp.throws(format($q$select ship.reorder_line_items('federal-campus-master-plan', array['%s','%s']::uuid[])$q$,
                             pg_temp.t29_id('T29 a'), pg_temp.t29_id('T29 x')),
                      '42501', 'a consultant cannot reorder someone else''s item', 'not yours to edit');
select pg_temp.throws(format($q$select ship.reorder_line_items('library-renovation', array['%s']::uuid[])$q$,
                             pg_temp.t29_id('T29 a')),
                      '42501', 'ids must belong to the named project');
select pg_temp.throws(format($q$select ship.reorder_line_items('federal-campus-master-plan', array['%s','%s']::uuid[])$q$,
                             pg_temp.t29_id('T29 a'), pg_temp.t29_id('T29 a')),
                      '22023', 'duplicate ids are refused');
select pg_temp.throws($q$select ship.renumber_line_items('federal-campus-master-plan')$q$,
                      '42501', 'the internal renumber is not callable by clients');
reset role;

select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.throws(format($q$select ship.reorder_line_items('federal-campus-master-plan', array['%s']::uuid[])$q$,
                             (select id from ship.line_items where project_id = 'federal-campus-master-plan' and item_number = 'E1')),
                      '42501', 'a viewer cannot reorder, not even their own items', 'permission');
reset role;

reset role;
set local role anon;
select pg_temp.throws($q$select ship.reorder_line_items('federal-campus-master-plan', '{}'::uuid[])$q$,
                      '42501', 'anon cannot call reorder_line_items');
reset role;

-- An editor may reorder anyone's items.
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select ship.reorder_line_items('federal-campus-master-plan',
  array[pg_temp.t29_id('T29 x'), pg_temp.t29_id('T29 d')]);
select pg_temp.ok(pg_temp.t29_numbers() = 'T29 a=A5 T29 b=A6 T29 c=A8 T29 d=A7 T29 x=A4',
                  'editor reorder (x before d) swaps their slots: ' || pg_temp.t29_numbers());

-- A package link to d survives renumbering (it is by uuid).
insert into ship.chunk_projects (project_id, name, sort_order) values ('federal-campus-master-plan', 'T29 pkg', 999);
insert into ship.chunk_project_items (chunk_project_id, line_item_id)
select c.id, pg_temp.t29_id('T29 d') from ship.chunk_projects c where c.name = 'T29 pkg';
reset role;

-- ---------------------------------------------------------------------
-- Delete renumbers the rest; the counter follows.
-- ---------------------------------------------------------------------
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
delete from ship.line_items where name = 'T29 a';
select pg_temp.ok(pg_temp.t29_numbers() = 'T29 b=A5 T29 c=A7 T29 d=A6 T29 x=A4',
                  'deleting A5 closes the gap: ' || pg_temp.t29_numbers());
select pg_temp.ok(
  (select count(*) = 1 from ship.chunk_project_items cpi
     join ship.line_items li on li.id = cpi.line_item_id
    where li.name = 'T29 d'),
  'the package still links d after it was renumbered twice');

insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'T29 e');
select pg_temp.ok((select item_number from ship.line_items where name = 'T29 e') = 'A8',
                  'after a delete the next insert takes count+1 (A8), not the old counter');
reset role;

-- ---------------------------------------------------------------------
-- A stale taxonomy value must not stop a delete-renumber.
-- ---------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
update ship.line_items set category = 'END OF LIFE' where name = 'T29 b';
delete from ship.form_field_options o
 using ship.form_fields f
 where o.field_id = f.id and f.project_id = 'federal-campus-master-plan'
   and f.key = 'category' and o.value = 'END OF LIFE';
select set_config('ship.renumbering', 'on', true);
update ship.line_items set updated_at = '2001-01-01' where name = 'T29 c';
select set_config('ship.renumbering', 'off', true);
delete from ship.line_items where name = 'T29 x';
select pg_temp.ok(pg_temp.t29_numbers() = 'T29 b=A4 T29 c=A6 T29 d=A5 T29 e=A7',
                  'renumber skips the taxonomy re-check (b holds a deleted category): ' || pg_temp.t29_numbers());
select pg_temp.ok((select updated_at = '2001-01-01' from ship.line_items where name = 'T29 c'),
                  'renumber leaves updated_at alone (normalize skipped)');

-- ---------------------------------------------------------------------
-- Custom discipline prefix (0022) renumbers within its own prefix.
-- ---------------------------------------------------------------------
insert into ship.project_consultants (project_id, consultant_type, org_name)
values ('federal-campus-master-plan', 'Acoustics T29', 'Sound Co');
insert into ship.line_items (project_id, user_email, consultant_type, discipline, name)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Acoustics T29', 'Acoustics T29', 'T29 k1'),
       ('federal-campus-master-plan', 'consultant1@gmail.com', 'Acoustics T29', 'Acoustics T29', 'T29 k2'),
       ('federal-campus-master-plan', 'consultant1@gmail.com', 'Acoustics T29', 'Acoustics T29', 'T29 k3');
select pg_temp.ok((select string_agg(item_number, ',' order by name) from ship.line_items where name like 'T29 k%') = 'AT1,AT2,AT3',
                  'custom discipline numbered AT1..AT3');
delete from ship.line_items where name = 'T29 k1';
select pg_temp.ok((select string_agg(item_number, ',' order by name) from ship.line_items where name like 'T29 k%') = 'AT1,AT2',
                  'custom discipline renumbers after delete');
select pg_temp.ok((select next_value from ship.item_number_counters
                    where project_id = 'federal-campus-master-plan' and discipline = 'Acoustics T29') = 3,
                  'custom discipline counter reset to count+1');
select pg_temp.ok(pg_temp.t29_numbers() like '%T29 b=A4%',
                  'deleting an Acoustics item did not disturb Architecture');

-- ---------------------------------------------------------------------
-- Deleting a whole project still cascades cleanly.
-- ---------------------------------------------------------------------
insert into ship.projects (id, name) values ('t29-throwaway', 'T29 throwaway');
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('t29-throwaway', 'consultant1@gmail.com', 'Architecture', 'T29 gone 1'),
       ('t29-throwaway', 'consultant1@gmail.com', 'Mechanical',   'T29 gone 2');
delete from ship.projects where id = 't29-throwaway';
select pg_temp.ok(not exists (select 1 from ship.line_items where project_id = 't29-throwaway')
                  and not exists (select 1 from ship.item_number_counters where project_id = 't29-throwaway'),
                  'project delete cascades through the AFTER DELETE renumber');

rollback;
