-- =====================================================================
-- 0013_access_hardening.sql tests  (M-04, M-15, M-16, D-7, D-8)
-- Run: node supabase/tests/run.mjs 0013
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- M-16: claim_invite needs a confirmed email; safe to call twice.
-- Seed users other than admin have never signed in, so they have no
-- ship.profiles row yet -- claiming for them is the first test.
-- ---------------------------------------------------------------------
select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok((ship.claim_invite()).email = 'electrical@voltworks.com',
                  'M-16 a confirmed, invited user can claim');
select pg_temp.ok((ship.claim_invite()).email = 'electrical@voltworks.com',
                  'M-16 claim_invite is idempotent (second call returns the same profile)');
reset role;

select pg_temp.login('consultant1@gmail.com');  set local role authenticated; select ship.claim_invite() is not null as claimed; reset role;
-- consultant2 (project admin of federal) has no seeded auth account.
select pg_temp.make_user('consultant2@gmail.com');
select pg_temp.login('consultant2@gmail.com');  set local role authenticated; select ship.claim_invite() is not null as claimed; reset role;
select pg_temp.login('planning@atlasmech.com'); set local role authenticated; select ship.claim_invite() is not null as claimed; reset role;

-- An invited address whose owner has NOT confirmed the mailbox.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000013a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'landscape@fieldoffice.com', null, now(), now());

select pg_temp.login('landscape@fieldoffice.com');
set local role authenticated;
select pg_temp.throws('select ship.claim_invite()', '42501',
                      'M-16 an unconfirmed address cannot claim its invite (invite hijack closed)',
                      'confirm your email');
reset role;
select pg_temp.ok(not exists (select 1 from ship.profiles where email = 'landscape@fieldoffice.com'),
                  'M-16 no profile was created for the unconfirmed address');

update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000013a1';
select pg_temp.login('landscape@fieldoffice.com');
set local role authenticated;
select pg_temp.ok((ship.claim_invite()).role = 'consultant',
                  'M-16 after confirming, the same address claims as consultant');
reset role;

-- An address that is not invited at all.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000013a2', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'stranger-0013@example.com', now(), now(), now());
select pg_temp.login('stranger-0013@example.com');
set local role authenticated;
select pg_temp.throws('select ship.claim_invite()', '42501',
                      'M-16 an uninvited (confirmed) user is still refused', 'not on the SHIP invite list');
reset role;

-- ---------------------------------------------------------------------
-- M-15 / D-8: who may call update_project.
-- consultant2 is a PROJECT admin of federal (project_roles) but not a
-- platform admin; planning is an editor; electrical a viewer.
-- ---------------------------------------------------------------------
create temp table roster_without_electrical on commit drop as
select coalesce(jsonb_agg(jsonb_build_object(
         'type', pc.consultant_type,
         'orgName', pc.org_name,
         'emails', coalesce((select jsonb_agg(pm.email order by pm.email)
                               from ship.project_members pm
                              where pm.project_id = pc.project_id
                                and pm.consultant_type = pc.consultant_type
                                and pm.email <> 'electrical@voltworks.com'), '[]'::jsonb))), '[]'::jsonb) as j
  from ship.project_consultants pc
 where pc.project_id = 'federal-campus-master-plan';
grant select on roster_without_electrical to authenticated;

-- Baseline: electrical (viewer, on the roster) can read federal.
select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok(ship.project_role('federal-campus-master-plan') = 'viewer',
                  'baseline: electrical is a viewer on federal');
select pg_temp.ok((select count(*) from ship.line_items where project_id = 'federal-campus-master-plan') > 0,
                  'baseline: electrical can see federal line items');
reset role;

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
select pg_temp.throws($q$select ship.update_project('federal-campus-master-plan', 'Renamed by editor', (select j from roster_without_electrical))$q$,
                      '42501', 'D-8 an editor cannot change the roster');
reset role;

select pg_temp.login('consultant2@gmail.com');
set local role authenticated;
select pg_temp.throws($q$select ship.update_project('school-modernization', 'Hijack', '[]'::jsonb)$q$,
                      '42501', 'D-8 a project admin cannot change a project they are not admin of');

select pg_temp.throws($q$select ship.update_project('federal-campus-master-plan', null, (select j from roster_without_electrical), '2000-01-01'::timestamptz)$q$,
                      '40001', 'stale p_expected_updated_at is refused with 40001');
reset role;

-- Remember the current version so the project admin can pass it.
create temp table fed_version on commit drop as
select updated_at from ship.projects where id = 'federal-campus-master-plan';
grant select on fed_version to authenticated;

select pg_temp.login('consultant2@gmail.com');
set local role authenticated;
select pg_temp.ok(
  (ship.update_project('federal-campus-master-plan', 'Federal Campus (renamed by project admin)',
                       (select j from roster_without_electrical),
                       (select updated_at from fed_version)) ->> 'project_id') = 'federal-campus-master-plan',
  'D-8/M-15 a project admin can rename + edit the roster of their own project (with a current version)');
reset role;

select pg_temp.ok((select name from ship.projects where id = 'federal-campus-master-plan')
                    = 'Federal Campus (renamed by project admin)', 'D-8 the rename persisted');

-- ---------------------------------------------------------------------
-- M-04: the removed roster member lost access; explicit non-roster grants kept.
-- ---------------------------------------------------------------------
select pg_temp.ok(not exists (select 1 from ship.project_roles
                               where project_id = 'federal-campus-master-plan'
                                 and email = 'electrical@voltworks.com'),
                  'M-04 the removed member''s project_roles row was deleted');
select pg_temp.ok(exists (select 1 from ship.project_roles
                           where project_id = 'federal-campus-master-plan'
                             and email = 'consultant1@gmail.com' and role = 'consultant'),
                  'M-04 an explicit grant for someone never on the roster (consultant1) is kept');
select pg_temp.ok(exists (select 1 from ship.project_roles
                           where project_id = 'federal-campus-master-plan'
                             and email = 'consultant2@gmail.com' and role = 'admin'),
                  'M-04 the calling project admin keeps their own admin row');

select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok(ship.project_role('federal-campus-master-plan') is null,
                  'M-04 removed member: project_role() is now null');
select pg_temp.ok((select count(*) from ship.line_items where project_id = 'federal-campus-master-plan') = 0,
                  'M-04 removed member: federal line items are no longer visible');
select pg_temp.ok((select count(*) from ship.projects where id = 'federal-campus-master-plan') = 0,
                  'M-04 removed member: the project itself is no longer visible');
reset role;

-- Malformed emails (null / scalar) no longer crash the save.
select pg_temp.login('admin@gmail.com');
set local role authenticated;
select pg_temp.ok(
  (ship.update_project('library-renovation', null,
     '[{"type":"Architecture","orgName":"X","emails":null},{"type":"Civil","orgName":"Y","emails":"oops"}]'::jsonb)
   ->> 'project_id') = 'library-renovation',
  'SEC-12 null / scalar emails are treated as "no emails" instead of raising 22023');

-- New roster emails are allowlisted as consultant, scoped to the project.
select pg_temp.ok(
  (ship.update_project('library-renovation', null,
     '[{"type":"Architecture","orgName":"X","emails":["New.Person-0013@Example.com"]}]'::jsonb)
   -> 'invited_emails') = '["new.person-0013@example.com"]'::jsonb,
  'update_project returns exactly the newly invited emails (lower-cased)');
reset role;
select pg_temp.ok(exists (select 1 from ship.pending_invites
                           where email = 'new.person-0013@example.com'
                             and role = 'consultant' and project_id = 'library-renovation'),
                  'D-8 roster invites are role=consultant with project_id set');

-- ---------------------------------------------------------------------
-- D-8: only a platform admin can mint a platform-admin invite.
-- (Simulates the invite route: service role writing with invited_by.)
-- ---------------------------------------------------------------------
create temp table uids on commit drop as select email, id from auth.users;
grant select on uids to service_role, authenticated;
set local role service_role;
select pg_temp.ok((select count(*) from ship.pending_invites) > 0,
                  'service_role can read ship.pending_invites (was "permission denied for schema ship")');

select pg_temp.throws($q$
  insert into ship.pending_invites (email, role, invited_by, project_id)
  values ('minted-admin-0013@example.com', 'admin',
          (select id from uids where email = 'consultant2@gmail.com'), 'federal-campus-master-plan')$q$,
  '42501', 'D-8 a project admin''s invite cannot be role=admin', 'only a platform admin');

select pg_temp.throws($q$
  update ship.pending_invites
     set role = 'admin', invited_by = (select id from uids where email = 'consultant2@gmail.com')
   where email = 'consultant1@gmail.com'$q$,
  '42501', 'D-8 a project admin cannot raise an existing invite to admin', 'only a platform admin');

insert into ship.pending_invites (email, role, invited_by)
values ('real-admin-0013@example.com', 'admin', (select id from uids where email = 'admin@gmail.com'));
select pg_temp.ok(exists (select 1 from ship.pending_invites where email = 'real-admin-0013@example.com' and role = 'admin'),
                  'D-8 a platform admin CAN invite a platform admin');

-- A project admin re-inviting the platform admin (upsert with role
-- consultant) must not demote them.
insert into ship.pending_invites (email, role, invited_by, project_id)
values ('admin@gmail.com', 'consultant', (select id from uids where email = 'consultant2@gmail.com'), 'federal-campus-master-plan')
on conflict (email) do update set role = excluded.role, invited_by = excluded.invited_by, project_id = excluded.project_id;
select pg_temp.ok((select role from ship.pending_invites where email = 'admin@gmail.com') = 'admin',
                  'D-8 a project-admin upsert does not demote an existing admin invite');

-- ---------------------------------------------------------------------
-- D-7: project_access_notices.
-- ---------------------------------------------------------------------
insert into ship.project_access_notices (email, project_id)
values ('electrical@voltworks.com', 'school-modernization'),
       ('planning@atlasmech.com',   'school-modernization');
select pg_temp.ok(true, 'D-7 service_role can insert notices');
reset role;

select pg_temp.login('electrical@voltworks.com');
set local role authenticated;
select pg_temp.ok((select count(*) from ship.project_access_notices) = 1,
                  'D-7 a user sees only their own notices');
select pg_temp.ok((select email from ship.project_access_notices) = 'electrical@voltworks.com',
                  'D-7 ... and it is theirs');
update ship.project_access_notices set seen_at = now();
select pg_temp.ok((select seen_at is not null from ship.project_access_notices),
                  'D-7 a user can mark their notice seen');
select pg_temp.throws($q$update ship.project_access_notices set email = 'planning@atlasmech.com'$q$,
                      '42501', 'D-7 a user cannot change anything but seen_at');
select pg_temp.throws($q$insert into ship.project_access_notices (email, project_id) values ('electrical@voltworks.com', 'library-renovation')$q$,
                      '42501', 'D-7 a user cannot create notices');
select pg_temp.throws($q$delete from ship.project_access_notices$q$,
                      '42501', 'D-7 a user cannot delete notices');
reset role;

select pg_temp.login('planning@atlasmech.com');
set local role authenticated;
update ship.project_access_notices set seen_at = now() where email = 'electrical@voltworks.com';
reset role;
select pg_temp.ok((select count(*) from ship.project_access_notices where email = 'planning@atlasmech.com' and seen_at is null) = 1,
                  'D-7 one user cannot mark another''s notice seen');

rollback;
