-- =====================================================================
-- 0021_project_view_settings.sql tests
-- Run: node supabase/tests/run.mjs 0021
-- federal-campus-master-plan roles (seed 002): consultant2 = project
-- admin (not platform), planning = editor, consultant1 = consultant,
-- electrical = viewer.
-- =====================================================================
begin;

select pg_temp.ok(not exists (select 1 from ship.projects where view_settings is null or jsonb_typeof(view_settings) <> 'object'),
                  '0021 every project has an object view_settings');

-- consultant2 (project admin of federal) has no seeded auth account.
select pg_temp.make_user('consultant2@gmail.com');
select pg_temp.login('consultant2@gmail.com');  set local role authenticated; select ship.claim_invite() is not null; reset role;
select pg_temp.login('consultant1@gmail.com');  set local role authenticated; select ship.claim_invite() is not null; reset role;
select pg_temp.login('planning@atlasmech.com'); set local role authenticated; select ship.claim_invite() is not null; reset role;
select pg_temp.login('electrical@voltworks.com'); set local role authenticated; select ship.claim_invite() is not null; reset role;

-- ---------------------------------------------------------------------
-- Project admin (not platform admin) can save; the stored value returns.
-- ---------------------------------------------------------------------
select pg_temp.login('consultant2@gmail.com');
set local role authenticated;
select pg_temp.ok(ship.project_role('federal-campus-master-plan') = 'admin' and not ship.is_admin(),
                  'baseline: consultant2 is a project (not platform) admin of federal');
select pg_temp.ok(ship.update_project_view_settings('federal-campus-master-plan',
                    '{"masterView":{"hiddenColumns":["cost"]},"timeline":{"costBreakdown":"quarter"},"chunking":null}'::jsonb)
                    -> 'masterView' = '{"hiddenColumns":["cost"]}'::jsonb,
                  '0021 a project admin can save and gets the stored value back');
-- Merge, not replace: saving one view keeps the others.
select pg_temp.ok(ship.update_project_view_settings('federal-campus-master-plan',
                    '{"chunking":{"hiddenColumns":["_total"]}}'::jsonb)
                    = '{"masterView":{"hiddenColumns":["cost"]},"chunking":{"hiddenColumns":["_total"]},"timeline":{"costBreakdown":"quarter"}}'::jsonb,
                  '0021 saving chunking keeps masterView and timeline');
select pg_temp.ok(ship.update_project_view_settings('federal-campus-master-plan',
                    '{"masterView":{"hiddenColumns":["notes"]}}'::jsonb)
                    = '{"masterView":{"hiddenColumns":["notes"]},"chunking":{"hiddenColumns":["_total"]},"timeline":{"costBreakdown":"quarter"}}'::jsonb,
                  '0021 saving masterView replaces only masterView');
select pg_temp.ok(ship.update_project_view_settings('federal-campus-master-plan',
                    '{"chunking":null}'::jsonb) ? 'chunking' = false,
                  '0021 a null value removes that view');
select pg_temp.ok(ship.update_project_view_settings('federal-campus-master-plan',
                    '{"masterView":{"hiddenColumns":["cost"]}}'::jsonb) -> 'masterView' = '{"hiddenColumns":["cost"]}'::jsonb,
                  '0021 back to the seeded test value');
select pg_temp.throws($q$select ship.update_project_view_settings('federal-campus-master-plan', '[]'::jsonb)$q$,
                      '22023', '0021 an array is refused');
select pg_temp.throws($q$select ship.update_project_view_settings('federal-campus-master-plan', null)$q$,
                      '22023', '0021 null is refused');
select pg_temp.throws($q$select ship.update_project_view_settings('federal-campus-master-plan',
                         jsonb_build_object('pad', repeat('x', 40000)))$q$,
                      '22023', '0021 an oversized object is refused', 'too large');
-- Direct UPDATE of the column is closed even for a project admin.
select pg_temp.throws($q$update ship.projects set view_settings = '{"x":1}'::jsonb where id = 'federal-campus-master-plan'$q$,
                      '42501', '0021 project admin cannot write view_settings with a direct UPDATE');
-- ... while the pre-0021 columns stay writable for them.
update ship.projects set name = name where id = 'federal-campus-master-plan';
select pg_temp.ok(true, '0021 project admin can still UPDATE name directly (column grant kept)');
reset role;

-- ---------------------------------------------------------------------
-- Editor, consultant, viewer: may read, may not save.
-- ---------------------------------------------------------------------
select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$select ship.update_project_view_settings('federal-campus-master-plan', '{}'::jsonb)$q$,
                      '42501', '0021 an editor cannot save display settings');
select pg_temp.ok((select view_settings #>> '{timeline,costBreakdown}' from ship.projects where id = 'federal-campus-master-plan') = 'quarter',
                  '0021 an editor reads the saved value');
reset role;

select pg_temp.login('consultant1@gmail.com');
set local role authenticated;
select pg_temp.ok(ship.project_role('federal-campus-master-plan') = 'consultant', 'baseline: consultant1 is a consultant on federal');
select pg_temp.throws($q$select ship.update_project_view_settings('federal-campus-master-plan', '{}'::jsonb)$q$,
                      '42501', '0021 a consultant cannot save display settings');
select pg_temp.ok((select view_settings #>> '{timeline,costBreakdown}' from ship.projects where id = 'federal-campus-master-plan') = 'quarter',
                  '0021 a consultant reads the saved value');
reset role;

select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok(ship.project_role('federal-campus-master-plan') = 'viewer', 'baseline: electrical is a viewer on federal');
select pg_temp.throws($q$select ship.update_project_view_settings('federal-campus-master-plan', '{}'::jsonb)$q$,
                      '42501', '0021 a viewer cannot save display settings');
select pg_temp.throws($q$update ship.projects set view_settings = '{}'::jsonb where id = 'federal-campus-master-plan'$q$,
                      '42501', '0021 a viewer cannot write view_settings with a direct UPDATE');
select pg_temp.ok((select view_settings #>> '{masterView,hiddenColumns,0}' from ship.projects where id = 'federal-campus-master-plan') = 'cost',
                  '0021 a viewer reads the saved value');
reset role;

-- ---------------------------------------------------------------------
-- Platform admin can save anywhere; unknown project is P0002.
-- ---------------------------------------------------------------------
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select pg_temp.ok(ship.update_project_view_settings('federal-campus-master-plan', '{}'::jsonb)
                    #>> '{timeline,costBreakdown}' = 'quarter',
                  '0021 a platform admin can save; an empty object changes nothing');
select pg_temp.ok(ship.update_project_view_settings('federal-campus-master-plan',
                    '{"masterView":null,"timeline":null}'::jsonb) = '{}'::jsonb,
                  '0021 nulls reset every view to the app defaults');
select pg_temp.throws($q$select ship.update_project_view_settings('no-such-project-0021', '{}'::jsonb)$q$,
                      'P0002', '0021 an unknown project is P0002');
reset role;

-- Grants per 0005: authenticated only.
select pg_temp.ok(not has_function_privilege('anon', 'ship.update_project_view_settings(text, jsonb)', 'execute')
                  and has_function_privilege('authenticated', 'ship.update_project_view_settings(text, jsonb)', 'execute'),
                  '0021 RPC is executable by authenticated, not anon');
select pg_temp.ok(not has_column_privilege('authenticated', 'ship.projects', 'view_settings', 'update'),
                  '0021 authenticated has no UPDATE privilege on view_settings');

rollback;
