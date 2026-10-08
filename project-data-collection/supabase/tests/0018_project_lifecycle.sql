-- =====================================================================
-- 0018_project_lifecycle.sql tests  (M-25, M-44)
-- Run: node supabase/tests/run.mjs 0018
-- =====================================================================
begin;

select pg_temp.ok(not exists (select 1 from ship.project_timeline_settings where start_calendar_year is null),
                  'M-25 no project has a NULL start_calendar_year');
select pg_temp.ok(not exists (select 1 from ship.projects p
                               where not exists (select 1 from ship.project_cost_settings c where c.project_id = p.id)
                                  or not exists (select 1 from ship.project_energy_settings e where e.project_id = p.id)
                                  or not exists (select 1 from ship.project_timeline_settings t where t.project_id = p.id)),
                  'M-25 every project has cost, energy and timeline settings rows');
select pg_temp.ok((select attnotnull from pg_attribute
                    where attrelid = 'ship.project_timeline_settings'::regclass
                      and attname = 'start_calendar_year'),
                  'M-25 start_calendar_year is NOT NULL');

create temp table made (result jsonb) on commit drop;
grant select, insert on made to authenticated;

select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into made
select ship.create_project('WS1 lifecycle probe',
  '[{"type":"Civil","orgName":"Probe Civil","emails":["probe-civil-0018@example.com"]}]'::jsonb);
reset role;

select pg_temp.ok((select start_calendar_year = extract(year from current_date)
                     from ship.project_timeline_settings where project_id = (select result ->> 'project_id' from made)),
                  'M-25 create_project fixes start_calendar_year to the creation year');
select pg_temp.ok((select base_year = extract(year from current_date)
                     from ship.project_cost_settings where project_id = (select result ->> 'project_id' from made)),
                  'M-25 create_project inserts project_cost_settings with a fixed base_year');
select pg_temp.ok(exists (select 1 from ship.project_energy_settings where project_id = (select result ->> 'project_id' from made)),
                  'M-25 create_project inserts project_energy_settings');
select pg_temp.ok((select count(*) from ship.form_fields where project_id = (select result ->> 'project_id' from made) and is_builtin) = 24,
                  'M-44 create_project seeds the 24 built-in form fields in the same transaction');
select pg_temp.ok((select count(*) from ship.form_field_options o join ship.form_fields f on f.id = o.field_id
                    where f.project_id = (select result ->> 'project_id' from made) and f.key = 'category') > 0,
                  'M-44 ... including the taxonomy-backed dropdown options');
select pg_temp.ok((select result -> 'invited_emails' from made) = '["probe-civil-0018@example.com"]'::jsonb,
                  'create_project still returns exactly the newly invited emails');
select pg_temp.ok((select project_id = (select result ->> 'project_id' from made) and role = 'consultant'
                     from ship.pending_invites where email = 'probe-civil-0018@example.com'),
                  'create_project invites are scoped to the new project');

-- Calling the client's old follow-up seed RPCs is still harmless.
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select ship.seed_default_taxonomy((select result ->> 'project_id' from made));
select ship.seed_default_form((select result ->> 'project_id' from made));
reset role;
select pg_temp.ok((select count(*) from ship.form_fields where project_id = (select result ->> 'project_id' from made)) = 24,
                  'M-44 the legacy client seed calls are idempotent no-ops');

-- Non-admins still cannot create projects.
select pg_temp.login('planning@atlasmech.com'); set local role authenticated; select ship.claim_invite();
select pg_temp.throws($q$select ship.create_project('nope', '[]'::jsonb)$q$, '42501', 'only platform admins create projects');
reset role;

rollback;
