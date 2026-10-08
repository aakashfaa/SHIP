-- =====================================================================
-- 0022_custom_disciplines.sql tests
-- Run: node supabase/tests/run.mjs 0022
-- Works on a throwaway project created (and rolled back) here.
-- =====================================================================
begin;

select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.claim_invite();

create temp table made on commit drop as
select ship.create_project('ZZ 0022 custom disciplines', jsonb_build_array(
  jsonb_build_object('type', 'Architecture', 'orgName', 'FAA',     'emails', jsonb_build_array('admin@gmail.com')),
  jsonb_build_object('type', ' Acoustics  ', 'orgName', 'Sound Co', 'emails', jsonb_build_array('acoustic-0022@example.com')),
  jsonb_build_object('type', 'Energy',       'orgName', 'Power Co', 'emails', jsonb_build_array('energy-0022@example.com')),
  jsonb_build_object('type', 'audio   visual', 'orgName', 'AV Co',  'emails', jsonb_build_array()),
  jsonb_build_object('type', 'mechanical',   'orgName', 'Mech Co',  'emails', jsonb_build_array('mech-0022@example.com'))
)) ->> 'project_id' as id;
reset role;

select pg_temp.ok((select count(*) from ship.project_consultants pc join made on pc.project_id = made.id) = 5,
                  '0022 create_project accepts custom disciplines');
select pg_temp.ok(exists (select 1 from ship.project_consultants pc join made on pc.project_id = made.id
                           where pc.consultant_type = 'Acoustics'),
                  '0022 a custom discipline is stored trimmed');
select pg_temp.ok(exists (select 1 from ship.project_consultants pc join made on pc.project_id = made.id
                           where pc.consultant_type = 'audio visual'),
                  '0022 inner whitespace is collapsed');
select pg_temp.ok(exists (select 1 from ship.project_consultants pc join made on pc.project_id = made.id
                           where pc.consultant_type = 'Mechanical')
                  and exists (select 1 from ship.project_members pm join made on pm.project_id = made.id
                               where pm.consultant_type = 'Mechanical' and pm.email = 'mech-0022@example.com'),
                  '0022 a known discipline in another case is stored with its canonical spelling');
select pg_temp.ok(exists (select 1 from ship.project_members pm join made on pm.project_id = made.id
                           where pm.consultant_type = 'Acoustics' and pm.email = 'acoustic-0022@example.com'),
                  '0022 project_members takes the same canonical name');

-- Prefixes: allocated on roster insert, unique, never a built-in.
select pg_temp.ok((select prefix from ship.project_discipline_prefixes dp join made on dp.project_id = made.id
                    where discipline_key = 'acoustics') = 'ACO',
                  '0022 Acoustics avoids the built-in AC and gets ACO');
select pg_temp.ok((select prefix from ship.project_discipline_prefixes dp join made on dp.project_id = made.id
                    where discipline_key = 'energy') = 'ENE',
                  '0022 Energy avoids the built-in EN and gets ENE');
select pg_temp.ok((select prefix from ship.project_discipline_prefixes dp join made on dp.project_id = made.id
                    where discipline_key = 'audio visual') = 'AV',
                  '0022 a multi-word name uses its initials (AV)');
select pg_temp.ok((select count(*) from ship.project_discipline_prefixes dp join made on dp.project_id = made.id) = 3,
                  '0022 built-in disciplines get no prefix row');

-- Line items number with the custom prefix.
select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, discipline, name,
  addressing_resiliency_sustainability, addressing_deferred_maintenance,
  code_life_safety_improvement, accessibility_improvement, historic_impact, potential_synergies)
select made.id, 'acoustic-0022@example.com', 'Acoustics', 'Acoustics', n,
       'No', 'No', 'No', 'No', 'No', array['Acoustics', 'Mechanical']
  from made, (values ('0022 item one'), ('0022 item two')) as v(n);
reset role;

select pg_temp.ok((select array_agg(item_number order by item_number) from ship.line_items li join made on li.project_id = made.id)
                  = array['ACO1', 'ACO2'],
                  '0022 custom discipline items are numbered ACO1, ACO2');
select pg_temp.ok((select company_name from ship.line_items li join made on li.project_id = made.id limit 1) = 'Sound Co',
                  '0022 company_name resolves through a custom discipline');

-- A Settings save (delete + reinsert of the roster) keeps the prefix,
-- even when the discipline is dropped and later re-added.
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.update_project((select id from made), 'ZZ 0022 custom disciplines', jsonb_build_array(
  jsonb_build_object('type', 'Architecture', 'orgName', 'FAA', 'emails', jsonb_build_array('admin@gmail.com')),
  jsonb_build_object('type', 'Lighting',     'orgName', 'Lux', 'emails', jsonb_build_array())));
select ship.update_project((select id from made), 'ZZ 0022 custom disciplines', jsonb_build_array(
  jsonb_build_object('type', 'Architecture', 'orgName', 'FAA',      'emails', jsonb_build_array('admin@gmail.com')),
  jsonb_build_object('type', 'acoustics',    'orgName', 'Sound Co', 'emails', jsonb_build_array('acoustic-0022@example.com'))));
insert into ship.line_items (project_id, user_email, consultant_type, discipline, name,
  addressing_resiliency_sustainability, addressing_deferred_maintenance,
  code_life_safety_improvement, accessibility_improvement, historic_impact)
select made.id, 'acoustic-0022@example.com', 'acoustics', 'acoustics', '0022 item three', 'No', 'No', 'No', 'No', 'No'
  from made;
reset role;

select pg_temp.ok((select prefix from ship.project_discipline_prefixes dp join made on dp.project_id = made.id
                    where discipline_key = 'acoustics') = 'ACO',
                  '0022 the prefix survives remove + re-add of the discipline');
select pg_temp.ok((select prefix from ship.project_discipline_prefixes dp join made on dp.project_id = made.id
                    where discipline_key = 'lighting') = 'LI',
                  '0022 Lighting gets LI');
select pg_temp.ok((select item_number from ship.line_items li join made on li.project_id = made.id
                    where name = '0022 item three') = 'ACO3',
                  '0022 a re-added discipline continues its numbering (ACO3), never reusing a number');
select pg_temp.ok((select count(distinct item_number) = count(*) from ship.line_items li join made on li.project_id = made.id),
                  '0022 item numbers stay unique');

-- Built-in disciplines keep their fixed prefixes everywhere.
select pg_temp.ok(ship.project_discipline_prefix('federal-campus-master-plan', 'Mechanical') = 'M'
                  and ship.project_discipline_prefix('federal-campus-master-plan', 'mechanical') = 'M'
                  and ship.project_discipline_prefix('federal-campus-master-plan', 'Admin') = 'AD',
                  '0022 built-in prefixes are unchanged');

-- Two names that derive the same base never share a prefix.
select pg_temp.ok(ship.allocate_discipline_prefix((select id from made), 'Lifts') = 'LIF',
                  '0022 Lifts collides with Lighting (LI) and gets LIF');

-- ---------------------------------------------------------------------
-- Line items never allocate a prefix (prefix-pool exhaustion), and case
-- variants share one prefix AND one counter.
-- ---------------------------------------------------------------------
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select ship.claim_invite();
select pg_temp.throws($q$insert into ship.line_items (project_id, user_email, consultant_type, discipline, name,
                           addressing_resiliency_sustainability, addressing_deferred_maintenance,
                           code_life_safety_improvement, accessibility_improvement, historic_impact)
                         values ('federal-campus-master-plan', 'consultant1@gmail.com', 'Architecture', 'Invented 0022', 'x',
                                 'No','No','No','No','No')$q$,
                      '22023', '0022 a contributor cannot number an item under a discipline that is not on the roster', 'roster');
reset role;
select pg_temp.ok(not exists (select 1 from ship.project_discipline_prefixes
                               where project_id = 'federal-campus-master-plan'),
                  '0022 ... and no prefix was allocated for it');

select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into ship.line_items (project_id, user_email, consultant_type, discipline, name,
  addressing_resiliency_sustainability, addressing_deferred_maintenance,
  code_life_safety_improvement, accessibility_improvement, historic_impact)
select made.id, 'acoustic-0022@example.com', 'ACOUSTICS', E' acoustics\t', '0022 item four', 'No', 'No', 'No', 'No', 'No'
  from made;
reset role;
-- The roster was last saved as 'acoustics' (lower case), so that is the spelling.
select pg_temp.ok((select discipline = 'acoustics' and consultant_type = 'acoustics' and item_number = 'ACO4'
                     from ship.line_items li join made on li.project_id = made.id where name = '0022 item four'),
                  '0022 a case/space variant is stored with the roster spelling and continues the same sequence (ACO4)');
select pg_temp.ok((select count(*) from ship.item_number_counters c join made on c.project_id = made.id
                    where lower(c.discipline) = 'acoustics') = 1,
                  '0022 case variants share one counter row');

-- ---------------------------------------------------------------------
-- Validation, and duplicates within one payload.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select pg_temp.throws($q$select ship.update_project((select id from made), 'x', jsonb_build_array(
                           jsonb_build_object('type', 'Acoustics', 'orgName', 'A', 'emails', jsonb_build_array()),
                           jsonb_build_object('type', 'ACOUSTICS ', 'orgName', 'B', 'emails', jsonb_build_array())))$q$,
                      '22023', '0022 update_project: a custom discipline twice (any case) is refused cleanly', 'more than once');
select pg_temp.throws($q$select ship.update_project((select id from made), 'x', jsonb_build_array(
                           jsonb_build_object('type', 'Mechanical', 'orgName', 'A', 'emails', jsonb_build_array()),
                           jsonb_build_object('type', 'mechanical', 'orgName', 'B', 'emails', jsonb_build_array())))$q$,
                      '22023', '0022 update_project: Mechanical + mechanical is refused cleanly', 'more than once');
select pg_temp.throws($q$select ship.create_project('ZZ 0022 dup', jsonb_build_array(
                           jsonb_build_object('type', 'Mechanical', 'orgName', 'A', 'emails', jsonb_build_array()),
                           jsonb_build_object('type', ' MECHANICAL', 'orgName', 'B', 'emails', jsonb_build_array())))$q$,
                      '22023', '0022 create_project: Mechanical + MECHANICAL is refused cleanly', 'more than once');
select pg_temp.throws($q$select ship.update_project((select id from made), 'x', jsonb_build_array(
                           jsonb_build_object('type', repeat('x', 61), 'orgName', 'A', 'emails', jsonb_build_array())))$q$,
                      '23514', '0022 a discipline over 60 characters is refused');
select pg_temp.throws($q$select ship.update_project((select id from made), 'x', jsonb_build_array(
                           jsonb_build_object('type', E'Bad\x01Name', 'orgName', 'A', 'emails', jsonb_build_array())))$q$,
                      '23514', '0022 a C0 control character is refused');
select pg_temp.throws($q$select ship.update_project((select id from made), 'x', jsonb_build_array(
                           jsonb_build_object('type', E'Bad\u0085Name', 'orgName', 'A', 'emails', jsonb_build_array())))$q$,
                      '23514', '0022 a C1 control character is refused');
select pg_temp.throws($q$select ship.update_project((select id from made), 'x', jsonb_build_array(
                           jsonb_build_object('type', 'admin', 'orgName', 'A', 'emails', jsonb_build_array())))$q$,
                      '23514', '0022 Admin is not a roster discipline');
select pg_temp.throws($q$insert into ship.line_items (project_id, user_email, consultant_type, discipline, name,
                           addressing_resiliency_sustainability, addressing_deferred_maintenance,
                           code_life_safety_improvement, accessibility_improvement, historic_impact, potential_synergies)
                         select made.id, 'admin@gmail.com', 'Architecture', 'Architecture', 'bad', 'No','No','No','No','No', array['  ']
                           from made$q$,
                      '23514', '0022 a blank synergy is refused');
reset role;
select pg_temp.ok(char_length(repeat(E'\U0001F600', 60)) = 60 and ship.is_valid_discipline(repeat(E'\U0001F600', 60)),
                  '0022 length is counted in code points (60 emoji pass)');
select pg_temp.ok(ship.canonical_discipline(E' Foo  Bar\t') = 'Foo Bar',
                  '0022 the explicit whitespace set is collapsed and trimmed');

-- No client access to the prefix table or the allocator.
select pg_temp.ok(not has_table_privilege('authenticated', 'ship.project_discipline_prefixes', 'select')
                  and not has_table_privilege('anon', 'ship.project_discipline_prefixes', 'select'),
                  '0022 project_discipline_prefixes is not readable by clients');
select pg_temp.ok(not has_function_privilege('authenticated', 'ship.project_discipline_prefix(text, text)', 'execute')
                  and not has_function_privilege('authenticated', 'ship.allocate_discipline_prefix(text, text)', 'execute'),
                  '0022 the prefix functions are not callable by clients');

-- ---------------------------------------------------------------------
-- Hosted safety: the old CHECKs are dropped by column, whatever their
-- name. Plant a differently named legacy check, re-run the migration's
-- real text, and it must be gone (and the run must be repeatable).
-- ---------------------------------------------------------------------
alter table ship.project_consultants add constraint zz_legacy_named_type_check
  check (consultant_type in ('Architecture', 'Civil')) not valid;
alter table ship.line_items add constraint zz_legacy_named_synergies_check
  check (potential_synergies <@ array['Architecture']::text[]) not valid;
-- @include supabase/migrations/0022_custom_disciplines.sql
select pg_temp.ok(not exists (select 1 from pg_constraint where conname like 'zz_legacy_named_%'),
                  '0022 differently named legacy discipline CHECKs are dropped');
select pg_temp.ok((select count(*) from pg_constraint
                    where conname in ('project_consultants_consultant_type_check', 'project_members_consultant_type_check',
                                      'line_items_consultant_type_check', 'line_items_discipline_check',
                                      'line_items_potential_synergies_check')
                      and pg_get_constraintdef(oid) like '%valid_discipline%') = 5,
                  '0022 re-running the migration leaves exactly the five new checks');

rollback;
