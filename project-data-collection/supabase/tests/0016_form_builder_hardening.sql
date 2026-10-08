-- =====================================================================
-- 0016_form_builder_hardening.sql tests  (M-14, M-37)
-- Run: node supabase/tests/run.mjs 0016
-- =====================================================================
begin;

select pg_temp.login('planning@atlasmech.com'); set local role authenticated; select ship.claim_invite(); reset role;

-- ---------------------------------------------------------------------
-- M-14: an editor cannot mint built-in / column fields.
-- (The audit's exact live repro: key user_email and no_such_column.)
-- ---------------------------------------------------------------------
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$insert into ship.form_fields (project_id, key, label, input_type, storage, is_builtin)
                         values ('federal-campus-master-plan', 'user_email', 'Owner', 'text', 'column', true)$q$,
                      '23514', 'M-14 editor cannot insert a built-in on user_email (not an editable column)');
select pg_temp.throws($q$insert into ship.form_fields (project_id, key, label, input_type, storage, is_builtin)
                         values ('federal-campus-master-plan', 'no_such_column', 'X', 'text', 'column', true)$q$,
                      '23514', 'M-14 editor cannot insert a built-in on a nonexistent column');
select pg_temp.throws($q$insert into ship.form_fields (project_id, key, label, input_type, storage, is_builtin)
                         values ('federal-campus-master-plan', 'supporting_notes', 'Squat', 'number', 'column', true)$q$,
                      '42501', 'M-14 editor cannot insert a built-in even on a real column key (RLS: seeder only)');

insert into ship.form_fields (project_id, key, label, input_type)
values ('federal-campus-master-plan', 'ws1_custom', 'WS1 custom', 'text');
select pg_temp.ok(exists (select 1 from ship.form_fields where key = 'ws1_custom' and storage = 'custom' and not is_builtin),
                  'M-14 editors can still add custom fields');

select pg_temp.throws($q$update ship.form_fields set is_builtin = true
                          where project_id = 'federal-campus-master-plan' and key = 'ws1_custom'$q$,
                      '42501', 'M-14 a custom field cannot be promoted to built-in', 'cannot become a built-in');
select pg_temp.throws($q$delete from ship.form_fields where project_id = 'federal-campus-master-plan' and key = 'name'$q$,
                      '42501', 'built-in fields are still undeletable through the API', 'cannot be deleted');
delete from ship.form_fields where project_id = 'federal-campus-master-plan' and key = 'ws1_custom';
select pg_temp.ok(not exists (select 1 from ship.form_fields where key = 'ws1_custom'),
                  'custom fields can still be deleted');
reset role;

-- Even the table owner (no RLS) cannot create a column field on a
-- non-column key: the allowlist trigger is independent of RLS.
select pg_temp.throws($q$insert into ship.form_fields (project_id, key, label, input_type, storage, is_builtin)
                         values ('federal-campus-master-plan', 'no_such_column', 'X', 'text', 'column', true)$q$,
                      '23514', 'M-14 column-backed keys are validated against the allowlist for everyone',
                      'is not a line item column');

select pg_temp.ok(not exists (select 1 from ship.form_fields
                               where storage = 'column'
                                 and not (key = any (ship.suggestable_line_item_columns()))),
                  'M-14 no forged column fields remain in the database');

-- A forged built-in that predates 0016 is now deletable (simulate one by
-- stepping around the triggers, the way such a row was created).
alter table ship.form_fields disable trigger form_fields_check_column_key;
insert into ship.form_fields (project_id, key, label, input_type, storage, is_builtin)
values ('federal-campus-master-plan', 'forged_legacy', 'Forged', 'text', 'column', true);
alter table ship.form_fields enable trigger form_fields_check_column_key;
select pg_temp.login('admin@gmail.com');
set local role authenticated;
delete from ship.form_fields where project_id = 'federal-campus-master-plan' and key = 'forged_legacy';
select pg_temp.ok(not exists (select 1 from ship.form_fields where key = 'forged_legacy'),
                  'M-14 a legacy forged built-in can be deleted through the API');
reset role;

-- ---------------------------------------------------------------------
-- M-37: deleting a project cascades through its built-in form fields.
-- ---------------------------------------------------------------------
create temp table probe_project (id text) on commit drop;
grant select, insert on probe_project to authenticated;

select pg_temp.login('admin@gmail.com');
set local role authenticated;
insert into probe_project
select ship.create_project('WS1 delete probe', '[]'::jsonb) ->> 'project_id';
select ship.seed_default_taxonomy((select id from probe_project));
select ship.seed_default_form((select id from probe_project));
select pg_temp.ok((select count(*) from ship.form_fields where project_id = (select id from probe_project) and is_builtin) > 0,
                  'setup: the probe project has built-in fields');
delete from ship.projects where id = (select id from probe_project);
select pg_temp.ok(not exists (select 1 from ship.projects where id = (select id from probe_project)),
                  'M-37 a project with built-in form fields can be deleted');
reset role;
select pg_temp.ok(not exists (select 1 from ship.form_fields where project_id = (select id from probe_project)),
                  'M-37 its form fields went with it');

rollback;
