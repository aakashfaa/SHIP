-- =====================================================================
-- 0025_replace_chunk_phases.sql tests
-- Run: node supabase/tests/run.mjs 0025
-- Everything below rolls back; the fixture is untouched.
-- =====================================================================
begin;

select pg_temp.login('planning@atlasmech.com');   set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('consultant1@gmail.com');    set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('electrical@voltworks.com'); set local role authenticated; select ship.claim_invite(); reset role;

-- One federal package to work on, and a snapshot of its phases.
create temp table probe on commit drop as
  select c.id as chunk_id
    from ship.chunk_projects c
   where c.project_id = 'federal-campus-master-plan'
     and exists (select 1 from ship.chunk_phases p where p.chunk_project_id = c.id)
   order by c.chunk_number
   limit 1;
grant select on probe to authenticated;

create temp table before_phases on commit drop as
  select p.* from ship.chunk_phases p where p.chunk_project_id = (select chunk_id from probe);

create temp table good on commit drop as
  select '[{"name":"Design","kind":"design","sort_order":0,"pct_of_tpc":10,"start_month":24,"duration_months":12,"duration_locked":false},
           {"name":"Construction","kind":"construction","sort_order":1,"pct_of_tpc":90,"start_month":36,"duration_months":36}]'::jsonb as j;
grant select on good to authenticated;

select pg_temp.ok((select count(*) from before_phases) > 0, 'baseline: the probe package has phases');

-- Refused for a consultant and a viewer; nothing changes.
select pg_temp.login('consultant1@gmail.com'); set local role authenticated;
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe), (select j from good))$q$,
                      '42501', 'a consultant cannot replace a package''s phases');
reset role;
select pg_temp.login('electrical@voltworks.com'); set local role authenticated;
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe), (select j from good))$q$,
                      '42501', 'a viewer cannot replace a package''s phases');
reset role;
select pg_temp.ok((select count(*) from ship.chunk_phases where chunk_project_id = (select chunk_id from probe))
                    = (select count(*) from before_phases),
                  'refusals leave the phases alone');

-- Invalid payloads are refused before anything is deleted.
select pg_temp.login('planning@atlasmech.com'); set local role authenticated;
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe), '[]'::jsonb)$q$,
                      '22023', 'an empty phase list is refused');
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe),
                        '[{"name":"X","kind":"design","sort_order":0,"pct_of_tpc":120,"start_month":0,"duration_months":12}]'::jsonb)$q$,
                      '22023', 'pct_of_tpc over 100 is refused');
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe),
                        '[{"name":"X","kind":"design","sort_order":0,"pct_of_tpc":10,"start_month":1.5,"duration_months":12}]'::jsonb)$q$,
                      '22023', 'a fractional start month is refused');
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe),
                        '[{"name":" ","kind":"design","sort_order":0,"pct_of_tpc":10,"start_month":0,"duration_months":12}]'::jsonb)$q$,
                      '22023', 'a blank name is refused');
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe),
                        '[{"name":"X","kind":"demolition","sort_order":0,"pct_of_tpc":10,"start_month":0,"duration_months":12}]'::jsonb)$q$,
                      '22023', 'an unknown kind is refused');
-- A failure in the INSERT itself (a template step that does not exist gets
-- past nothing; a random uuid) also leaves the old phases intact.
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe),
                        '[{"name":"X","kind":"design","sort_order":0,"pct_of_tpc":10,"start_month":0,"duration_months":12,
                           "template_step_id":"00000000-0000-0000-0000-000000000001"}]'::jsonb)$q$,
                      '22023', 'an unknown template step is refused');
-- Mid-way: this payload passes validation, so the DELETE runs, and then the
-- INSERT fails (sort_order out of integer range). The delete must roll back.
select pg_temp.throws($q$select ship.replace_chunk_phases((select chunk_id from probe),
                        '[{"name":"X","kind":"design","sort_order":10000000000,"pct_of_tpc":10,"start_month":0,"duration_months":12}]'::jsonb)$q$,
                      '22003', 'an insert that fails after the delete is refused');
reset role;
select pg_temp.ok((select count(*) from ship.chunk_phases p
                    join before_phases b on b.id = p.id
                   where p.chunk_project_id = (select chunk_id from probe))
                    = (select count(*) from before_phases),
                  'every failed call left the original phases in place');

-- An editor replaces them in one go.
select pg_temp.login('planning@atlasmech.com'); set local role authenticated;
select pg_temp.ok((select count(*) from ship.replace_chunk_phases((select chunk_id from probe), (select j from good))) = 2,
                  'an editor replaces the phases and gets the new rows back');
reset role;
select pg_temp.ok((select string_agg(name || ':' || pct_of_tpc || '@' || start_slot || '+' || duration_slots, ',' order by sort_order)
                     from ship.chunk_phases where chunk_project_id = (select chunk_id from probe))
                    = 'Design:10@24+12,Construction:90@36+36',
                  'the package now holds exactly the new phases');
select pg_temp.ok(not exists (select 1 from ship.chunk_phases p join before_phases b on b.id = p.id),
                  'the old phases are gone');

-- A platform admin may too.
select pg_temp.login('admin@gmail.com'); set local role authenticated;
select pg_temp.ok((select count(*) from ship.replace_chunk_phases((select chunk_id from probe), (select j from good))) = 2,
                  'an admin can replace the phases');
reset role;

rollback;
