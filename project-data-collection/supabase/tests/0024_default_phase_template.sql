-- =====================================================================
-- 0024_default_phase_template.sql tests
-- Run: node supabase/tests/run.mjs 0024
-- =====================================================================
begin;

create temp table made (result jsonb) on commit drop;
grant select, insert on made to authenticated;

-- Snapshot of every existing project's template, to prove 0024 left them alone.
create temp table before_templates on commit drop as
  select project_id, default_phase_template_id from ship.project_cost_settings;

select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into made select ship.create_project('WS 0024 template probe', '[]'::jsonb);
reset role;

select pg_temp.ok((select c.default_phase_template_id = t.id
                     from ship.project_cost_settings c, ship.phase_templates t
                    where c.project_id = (select result ->> 'project_id' from made)
                      and t.is_builtin and t.name = 'DCAMM Study + Design'),
                  'create_project starts a new project on DCAMM Study + Design');
select pg_temp.ok((select base_year = extract(year from current_date)
                     from ship.project_cost_settings where project_id = (select result ->> 'project_id' from made)),
                  'create_project still fixes base_year (M-25)');
select pg_temp.ok((select count(*) from ship.form_fields where project_id = (select result ->> 'project_id' from made) and is_builtin) > 0,
                  'create_project still seeds the default form (M-44)');
select pg_temp.ok(not exists (
                    select 1 from before_templates b
                      join ship.project_cost_settings c using (project_id)
                     where c.default_phase_template_id is distinct from b.default_phase_template_id),
                  'existing projects keep their phase template');

rollback;
