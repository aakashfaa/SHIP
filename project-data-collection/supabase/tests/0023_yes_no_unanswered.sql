-- =====================================================================
-- 0023_yes_no_unanswered.sql tests
-- Run: node supabase/tests/run.mjs 0023
-- The five built-in Yes/No columns accept 'Yes' | 'No' | NULL, and still
-- reject anything else. Rolled back; nothing is left behind.
-- =====================================================================
begin;

select pg_temp.ok(
  (select count(*) from information_schema.columns
    where table_schema = 'ship' and table_name = 'line_items' and is_nullable = 'YES'
      and column_name in ('addressing_resiliency_sustainability', 'addressing_deferred_maintenance',
                          'code_life_safety_improvement', 'accessibility_improvement', 'historic_impact')) = 5,
  '0023 all five Yes/No columns are nullable');

select pg_temp.ok(
  (select count(*) from information_schema.columns
    where table_schema = 'ship' and table_name = 'line_items' and column_default is not null
      and column_name in ('addressing_resiliency_sustainability', 'addressing_deferred_maintenance',
                          'code_life_safety_improvement', 'accessibility_improvement', 'historic_impact')) = 0,
  '0023 no column default fills in an answer');

select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select ship.claim_invite();

-- Skipped: the columns are simply not sent (what the client does now).
insert into ship.line_items (project_id, user_email, consultant_type, name)
values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', '0023 probe skipped');

select pg_temp.ok(
  (select addressing_resiliency_sustainability is null and addressing_deferred_maintenance is null
      and code_life_safety_improvement is null and accessibility_improvement is null
      and historic_impact is null
     from ship.line_items where name = '0023 probe skipped'),
  '0023 a skipped Yes/No question is stored as NULL');

-- Answered values still round-trip, and can be cleared back to NULL.
update ship.line_items set historic_impact = 'Yes', accessibility_improvement = 'No'
 where name = '0023 probe skipped';
select pg_temp.ok(
  (select historic_impact = 'Yes' and accessibility_improvement = 'No'
     from ship.line_items where name = '0023 probe skipped'),
  '0023 Yes and No are still stored as given');

update ship.line_items set historic_impact = null where name = '0023 probe skipped';
select pg_temp.ok(
  (select historic_impact is null from ship.line_items where name = '0023 probe skipped'),
  '0023 an answer can be cleared back to unanswered');

-- The CHECK still rejects anything that is not Yes / No / NULL.
select pg_temp.throws($q$update ship.line_items set historic_impact = '' where name = '0023 probe skipped'$q$,
                      '23514', '0023 empty string is rejected (use NULL)');
select pg_temp.throws($q$update ship.line_items set code_life_safety_improvement = 'Maybe' where name = '0023 probe skipped'$q$,
                      '23514', '0023 a non Yes/No value is rejected');
reset role;

rollback;
