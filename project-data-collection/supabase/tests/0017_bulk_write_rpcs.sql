-- =====================================================================
-- 0017_bulk_write_rpcs.sql tests  (M-18)
-- Run: node supabase/tests/run.mjs 0017
-- =====================================================================
begin;

select pg_temp.login('planning@atlasmech.com'); set local role authenticated; select ship.claim_invite(); reset role;
select pg_temp.login('consultant1@gmail.com');  set local role authenticated; select ship.claim_invite(); reset role;

create temp table ids on commit drop as
select
  (select array_agg(id order by sort_order desc, id) from ship.form_fields
    where project_id = 'federal-campus-master-plan') as fed_fields_reversed,
  (select array_agg(id order by sort_order, id) from ship.form_fields
    where project_id = 'library-renovation') as lib_fields,
  (select f.id from ship.form_fields f where f.project_id = 'federal-campus-master-plan' and f.key = 'operational_impact') as opt_field,
  (select array_agg(o.id order by o.sort_order desc, o.id) from ship.form_field_options o
     join ship.form_fields f on f.id = o.field_id
    where f.project_id = 'federal-campus-master-plan' and f.key = 'operational_impact') as opts_reversed;
grant select on ids to authenticated;

select pg_temp.ok((select cardinality(fed_fields_reversed) > 2 and cardinality(opts_reversed) > 2 from ids),
                  'setup: federal has fields and options to reorder');

-- Editor reverses the whole form, then the operational_impact options.
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select ship.reorder_form_fields('federal-campus-master-plan', (select fed_fields_reversed from ids));
select pg_temp.ok(
  (select array_agg(id order by sort_order) from ship.form_fields where project_id = 'federal-campus-master-plan')
    = (select fed_fields_reversed from ids),
  'M-18 reorder_form_fields applies the new order (was: NOT NULL error on every reorder)');
select pg_temp.ok(
  (select array_agg(sort_order order by sort_order) from ship.form_fields where project_id = 'federal-campus-master-plan')
    = (select array_agg(g * 10) from generate_series(1, cardinality((select fed_fields_reversed from ids))) g),
  'M-18 sort_order is renumbered 10, 20, 30, ...');

select ship.reorder_field_options((select opt_field from ids), (select opts_reversed from ids));
select pg_temp.ok(
  (select array_agg(id order by sort_order) from ship.form_field_options where field_id = (select opt_field from ids))
    = (select opts_reversed from ids),
  'M-18 reorder_field_options applies the new order');

-- Mixing in another project's ids changes nothing and raises.
select pg_temp.throws($q$select ship.reorder_form_fields('federal-campus-master-plan',
                           (select fed_fields_reversed[1:2] || lib_fields[1:1] from ids))$q$,
                      '42501', 'M-18 ids from another project are refused (atomically)');
select pg_temp.throws($q$select ship.reorder_form_fields('federal-campus-master-plan',
                           (select array[fed_fields_reversed[1], fed_fields_reversed[1]] from ids))$q$,
                      '22023', 'M-18 duplicate ids are refused');
reset role;

-- A consultant cannot reorder (RLS: edit access required).
select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select pg_temp.throws($q$select ship.reorder_form_fields('federal-campus-master-plan', (select fed_fields_reversed from ids))$q$,
                      '42501', 'M-18 a consultant cannot reorder the form');
select pg_temp.throws($q$select ship.reorder_field_options((select opt_field from ids), (select opts_reversed from ids))$q$,
                      '42501', 'M-18 a consultant cannot reorder options');
reset role;

rollback;
