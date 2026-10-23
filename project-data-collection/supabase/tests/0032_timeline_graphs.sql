-- =====================================================================
-- 0032_timeline_graphs.sql tests
-- Run: node supabase/tests/run.mjs 0032
-- =====================================================================
begin;

-- Seed: every project has its Energy graph, copied from its energy settings.
select pg_temp.ok(not exists (
                    select 1 from ship.projects p
                     where not exists (select 1 from ship.project_graphs g where g.project_id = p.id)),
                  'every existing project has at least one graph');
select pg_temp.ok((select count(*) = 0
                     from ship.project_energy_settings e
                     join ship.project_graphs g
                       on g.project_id = e.project_id and g.source_key = 'annual_energy_savings'
                    where g.unit_label <> e.unit_label
                       or g.baseline_annual is distinct from e.baseline_annual
                       or g.interaction_factor <> e.interaction_factor
                       or g.color <> '#059669'),
                  'the Energy graph carries the old unit, baseline, factor, in the old green');

-- New projects get the Energy graph through create_project().
create temp table made (result jsonb) on commit drop;
grant select, insert on made to authenticated;
select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into made select ship.create_project('WS 0032 graph probe', '[]'::jsonb);
reset role;
select pg_temp.ok((select count(*) = 1 and bool_and(label = 'Energy reduction' and color = '#059669')
                     from ship.project_graphs
                    where project_id = (select result ->> 'project_id' from made)),
                  'create_project gives a new project one Energy graph');

-- Editor may add / edit / delete.
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
insert into ship.project_graphs (project_id, label, source_key, unit_label, color, sort_order)
values ('federal-campus-master-plan', 'Carbon reduction', 'annual_carbon_reduction', 'MTCO2e', '#2563EB', 1);
select pg_temp.ok((select color = '#2563eb' from ship.project_graphs where label = 'Carbon reduction'),
                  'editor can add a graph; colour is stored lower-case');
update ship.project_graphs set baseline_annual = 500 where label = 'Carbon reduction';
select pg_temp.ok((select baseline_annual = 500 from ship.project_graphs where label = 'Carbon reduction'),
                  'editor can edit a graph');
select pg_temp.throws($q$update ship.project_graphs set color = 'red' where label = 'Carbon reduction'$q$,
                      '23514', 'a colour that is not #rrggbb is refused');
select pg_temp.throws($q$update ship.project_graphs set interaction_factor = 3 where label = 'Carbon reduction'$q$,
                      '23514', 'interaction factor stays in (0, 2]');
select pg_temp.throws($q$update ship.project_graphs set source_key = 'x; drop' where label = 'Carbon reduction'$q$,
                      '23514', 'source_key must look like a field key');
reset role;

-- Viewer and consultant can read but not write.
select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok((select count(*) >= 2 from ship.project_graphs where project_id = 'federal-campus-master-plan'),
                  'viewer can read the graphs');
update ship.project_graphs set label = 'hacked' where project_id = 'federal-campus-master-plan';
delete from ship.project_graphs where project_id = 'federal-campus-master-plan';
select pg_temp.throws($q$insert into ship.project_graphs (project_id, label, source_key) values ('federal-campus-master-plan', 'x', 'annual_cost_savings')$q$,
                      '42501', 'viewer cannot add a graph');
reset role;
select pg_temp.ok((select count(*) >= 2 and bool_and(label <> 'hacked')
                     from ship.project_graphs where project_id = 'federal-campus-master-plan'),
                  'viewer update/delete touched nothing');

select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select pg_temp.throws($q$insert into ship.project_graphs (project_id, label, source_key) values ('federal-campus-master-plan', 'x', 'annual_cost_savings')$q$,
                      '42501', 'consultant cannot add a graph');
reset role;

-- Someone with no role on a project sees none of its graphs.
select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok((select count(*) = 0 from ship.project_graphs where project_id = 'library-renovation'),
                  'a non-member sees no graphs of another project');
reset role;

-- anon has nothing.
select pg_temp.ok(not has_table_privilege('anon', 'ship.project_graphs', 'select'),
                  'anon has no access to project_graphs');

rollback;
