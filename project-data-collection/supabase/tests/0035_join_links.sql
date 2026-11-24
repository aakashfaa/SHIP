-- =====================================================================
-- 0035_join_links.sql tests
-- Run: node supabase/tests/run.mjs 0035
--
--   * ship.join_links is service-role only (anon/authenticated: nothing).
--   * claim_invite, open sign-up: a confirmed user who is not invited gets
--     a plain consultant profile and sees no projects.
--   * an invited user still gets the invite's role and name.
--   * an unconfirmed user is still refused.
--   * password_set_at: ship.password_evidence_at() (the backfill rule), the
--     backfill UPDATE, claim_invite stamping it, ship.mark_password_set().
-- =====================================================================
begin;

-- Re-runnable: applying the migration again over itself is a no-op.
-- @include supabase/migrations/0035_join_links.sql

-- A link row to try to read (inserted as postgres, rolled back).
insert into ship.join_links (project_id, email, token_hash)
select p.id, 't35-target@example.com', repeat('a', 64)
  from ship.projects p order by p.id limit 1;

-- ---------------------------------------------------------------------
-- Clients can neither read nor write join_links.
-- ---------------------------------------------------------------------
grant execute on function pg_temp.throws(text, text, text, text) to anon;
set local role anon;
select pg_temp.throws('select count(*) from ship.join_links', '42501',
                      '0035 anon cannot read join_links');
select pg_temp.throws($q$insert into ship.join_links (project_id, email, token_hash)
                         values ('x', 'a@b.com', 'h1')$q$, '42501',
                      '0035 anon cannot insert join_links');
reset role;

select pg_temp.login('admin@gmail.com');
set local role authenticated;
select pg_temp.throws('select count(*) from ship.join_links', '42501',
                      '0035 an authenticated user (even a platform admin) cannot read join_links');
select pg_temp.throws($q$update ship.join_links set used_at = null$q$, '42501',
                      '0035 an authenticated user cannot update join_links');
select pg_temp.throws($q$delete from ship.join_links$q$, '42501',
                      '0035 an authenticated user cannot delete join_links');
select pg_temp.throws($q$insert into ship.join_links (project_id, email, token_hash)
                         values ('x', 'a@b.com', 'h2')$q$, '42501',
                      '0035 an authenticated user cannot insert join_links');
reset role;

select pg_temp.ok(
  (select relrowsecurity from pg_class where oid = 'ship.join_links'::regclass),
  '0035 RLS is on for join_links');
select pg_temp.ok(
  not exists (select 1 from pg_policies where schemaname = 'ship' and tablename = 'join_links'),
  '0035 join_links has no policies');

select pg_temp.throws($q$insert into ship.join_links (project_id, email, token_hash)
                         select id, ' Mixed@Case.com', 'h3' from ship.projects limit 1$q$, '23514',
                      '0035 join_links.email must be stored lower-case and trimmed');

select pg_temp.throws($q$insert into ship.join_links (project_id, email, token_hash)
                         select project_id, email, 'h4' from ship.join_links
                          where email = 't35-target@example.com'$q$, '23505',
                      '0035 only one unrevoked link per person per project');
update ship.join_links set revoked_at = now() where email = 't35-target@example.com';
insert into ship.join_links (project_id, email, token_hash)
select p.id, 't35-target@example.com', repeat('b', 64) from ship.projects p order by p.id limit 1;
select pg_temp.ok((select count(*) from ship.join_links where email = 't35-target@example.com') = 2,
                  '0035 a new link can be made once the old one is revoked');

-- ---------------------------------------------------------------------
-- Open sign-up: a confirmed, uninvited user gets a consultant profile.
-- ---------------------------------------------------------------------
select pg_temp.make_user('t35-stranger@example.com');
select pg_temp.login('t35-stranger@example.com');
set local role authenticated;
create temp table t35_claim on commit drop as select (ship.claim_invite()).*;
select pg_temp.ok((select role from t35_claim) = 'consultant',
                  '0035 an uninvited confirmed user gets a consultant profile');
select pg_temp.ok((select name from t35_claim) = 'T35 Stranger',
                  '0035 the profile name defaults from the email');
select pg_temp.ok((ship.claim_invite()).id = (select id from t35_claim),
                  '0035 claim_invite stays idempotent for the self-signed-up user');
select pg_temp.ok(not ship.is_admin(), '0035 the self-signed-up user is not a platform admin');
select pg_temp.ok((select count(*) from ship.projects) = 0,
                  '0035 the self-signed-up user sees no projects');
reset role;
select pg_temp.ok(not exists (select 1 from ship.pending_invites where email = 't35-stranger@example.com'),
                  '0035 open sign-up does not invent an invite row');

-- ---------------------------------------------------------------------
-- Invited users are unchanged: the invite's role and name apply.
-- ---------------------------------------------------------------------
insert into ship.pending_invites (email, name, role)
values ('t35-invited@example.com', 'Invited Person', 'admin');
select pg_temp.make_user('t35-invited@example.com');
select pg_temp.login('t35-invited@example.com');
set local role authenticated;
create temp table t35_invited on commit drop as select (ship.claim_invite()).*;
select pg_temp.ok((select role from t35_invited) = 'admin',
                  '0035 an invited user still gets the invite''s role');
select pg_temp.ok((select name from t35_invited) = 'Invited Person',
                  '0035 an invited user still gets the invite''s name');
reset role;
select pg_temp.ok((select accepted_at is not null from ship.pending_invites
                    where email = 't35-invited@example.com'),
                  '0035 the invite is marked accepted');

-- ---------------------------------------------------------------------
-- Unconfirmed users are still refused, invited or not.
-- ---------------------------------------------------------------------
select pg_temp.make_user('t35-unconfirmed@example.com', false);
select pg_temp.login('t35-unconfirmed@example.com');
set local role authenticated;
select pg_temp.throws('select ship.claim_invite()', '42501',
                      '0035 an unconfirmed, uninvited user is refused', 'confirm your email');
reset role;

insert into ship.pending_invites (email, role) values ('t35-unconf-inv@example.com', 'consultant');
select pg_temp.make_user('t35-unconf-inv@example.com', false);
select pg_temp.login('t35-unconf-inv@example.com');
set local role authenticated;
select pg_temp.throws('select ship.claim_invite()', '42501',
                      '0035 an unconfirmed, invited user is refused', 'confirm your email');
reset role;
select pg_temp.ok(not exists (select 1 from ship.profiles
                               where email in ('t35-unconfirmed@example.com', 't35-unconf-inv@example.com')),
                  '0035 no profile was created for the unconfirmed users');

-- ---------------------------------------------------------------------
-- password_set_at: the evidence rule behind the backfill.
-- ---------------------------------------------------------------------
-- Seeded users were created with passwords: marked.
select pg_temp.ok(not exists (select 1 from ship.profiles
                               where email in ('admin@gmail.com', 'consultant1@gmail.com')
                                 and password_set_at is null),
                  '0035 seeded users are marked as having a password');

create temp table t35_u on commit drop as
select pg_temp.make_user('t35-scanned@example.com')  as scanned,
       pg_temp.make_user('t35-pwlogin@example.com')  as pwlogin,
       pg_temp.make_user('t35-updated@example.com')  as updated,
       pg_temp.make_user('t35-amr@example.com')      as amr,
       pg_temp.make_user('t35-untagged@example.com') as untagged;
update auth.users set raw_user_meta_data = '{"ship_invite": true}'::jsonb
 where email in ('t35-scanned@example.com', 't35-pwlogin@example.com',
                 't35-updated@example.com', 't35-amr@example.com');

-- Every one of them first signs in through an email link (a login with no
-- traits, an 'otp' session), which is all a mail scanner leaves behind.
insert into auth.audit_log_entries (id, payload, created_at)
select gen_random_uuid(),
       json_build_object('action', 'login', 'actor_id', u.id, 'log_type', 'account'),
       now() - interval '2 days'
  from auth.users u where u.email like 't35-%@example.com';
insert into auth.sessions (id, user_id, created_at)
select gen_random_uuid(), u.id, now() - interval '2 days'
  from auth.users u where u.email like 't35-%@example.com';
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
select gen_random_uuid(), s.id, s.created_at, s.created_at, 'otp'
  from auth.sessions s join auth.users u on u.id = s.user_id
 where u.email like 't35-%@example.com';

-- Then the real evidence, one kind per account.
insert into auth.audit_log_entries (id, payload, created_at)
select gen_random_uuid(),
       json_build_object('action', 'login', 'actor_id', pwlogin, 'log_type', 'account',
                         'traits', json_build_object('provider', 'email')),
       now() - interval '1 day'
  from t35_u;
insert into auth.audit_log_entries (id, payload, created_at)
select gen_random_uuid(),
       json_build_object('action', 'user_updated_password', 'actor_id', updated, 'log_type', 'user'),
       now() - interval '1 day'
  from t35_u;
with s as (
  insert into auth.sessions (id, user_id, created_at)
  select gen_random_uuid(), amr, now() - interval '1 day' from t35_u
  returning id, created_at
)
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
select gen_random_uuid(), s.id, s.created_at, s.created_at, 'password' from s;

select pg_temp.ok(ship.password_evidence_at(scanned) is null,
                  '0035 evidence: a tagged account with only email-link sign-ins has none')
  from t35_u;
select pg_temp.ok(ship.password_evidence_at(pwlogin) is not null,
                  '0035 evidence: an audit-log password login counts')
  from t35_u;
select pg_temp.ok(ship.password_evidence_at(updated) is not null,
                  '0035 evidence: an audit-log user_updated_password counts')
  from t35_u;
select pg_temp.ok(ship.password_evidence_at(amr) is not null,
                  '0035 evidence: a session signed in with method password counts')
  from t35_u;
select pg_temp.ok(ship.password_evidence_at(untagged) is not null,
                  '0035 evidence: an account not made by a SHIP invite counts as having a password')
  from t35_u;

-- Profiles with no stamp (as on a pre-0035 database), then the migration
-- again: the backfill fills exactly the right ones.
insert into ship.profiles (id, email, role)
select u.id, u.email, 'consultant' from auth.users u where u.email like 't35-%@example.com'
on conflict (id) do nothing;
update ship.profiles set password_set_at = null where email like 't35-%@example.com';

-- @include supabase/migrations/0035_join_links.sql

select pg_temp.ok((select password_set_at is null from ship.profiles where email = 't35-scanned@example.com'),
                  '0035 backfill: the scanner-confirmed account stays "needs password"');
select pg_temp.ok((select count(*) from ship.profiles
                    where email in ('t35-pwlogin@example.com', 't35-updated@example.com',
                                    't35-amr@example.com', 't35-untagged@example.com')
                      and password_set_at is not null) = 4,
                  '0035 backfill: every account with evidence is marked');
select pg_temp.ok((select password_set_at < now() - interval '20 hours'
                     from ship.profiles where email = 't35-pwlogin@example.com'),
                  '0035 backfill: the stamp is the time of the evidence, not now');

create temp table t35_before on commit drop as
select id, password_set_at from ship.profiles where email like 't35-%@example.com';
-- @include supabase/migrations/0035_join_links.sql
select pg_temp.ok(not exists (select 1 from ship.profiles p join t35_before b on b.id = p.id
                               where p.password_set_at is distinct from b.password_set_at),
                  '0035 backfill: a second run changes nothing');

-- claim_invite stamps a new profile from the same evidence.
select pg_temp.make_user('t35-claim-tagged@example.com');
update auth.users set raw_user_meta_data = '{"ship_invite": true}'::jsonb
 where email = 't35-claim-tagged@example.com';
select pg_temp.login('t35-claim-tagged@example.com');
set local role authenticated;
select ship.claim_invite();
reset role;
select pg_temp.ok((select password_set_at is null from ship.profiles where email = 't35-claim-tagged@example.com'),
                  '0035 claim_invite: a tagged account with no evidence starts unmarked');
select pg_temp.ok((select password_set_at is not null from ship.profiles where email = 't35-stranger@example.com'),
                  '0035 claim_invite: an untagged (self-signed-up) account starts marked');

-- ---------------------------------------------------------------------
-- mark_password_set()
-- ---------------------------------------------------------------------
select pg_temp.login('t35-claim-tagged@example.com');
set local role authenticated;
select pg_temp.ok(ship.mark_password_set(), '0035 mark_password_set returns true for a user with a profile');
reset role;
create temp table t35_mark on commit drop as
select password_set_at from ship.profiles where email = 't35-claim-tagged@example.com';
select pg_temp.ok((select password_set_at is not null from t35_mark),
                  '0035 mark_password_set stamps the caller');
select pg_temp.login('t35-claim-tagged@example.com');
set local role authenticated;
select ship.mark_password_set();
reset role;
select pg_temp.ok((select p.password_set_at = m.password_set_at
                     from ship.profiles p, t35_mark m where p.email = 't35-claim-tagged@example.com'),
                  '0035 mark_password_set keeps the first time');
select pg_temp.ok((select password_set_at is null from ship.profiles where email = 't35-scanned@example.com'),
                  '0035 mark_password_set touches only the caller');

select pg_temp.make_user('t35-noprofile@example.com');
select pg_temp.login('t35-noprofile@example.com');
set local role authenticated;
select pg_temp.ok(not ship.mark_password_set(), '0035 mark_password_set returns false with no profile');
select pg_temp.throws('select ship.password_evidence_at(auth.uid())', '42501',
                      '0035 clients cannot call password_evidence_at');
select pg_temp.throws($q$update ship.profiles set password_set_at = now() where id = auth.uid()$q$, '42501',
                      '0035 clients cannot write password_set_at directly');
reset role;

set local role anon;
select pg_temp.throws('select ship.mark_password_set()', '42501',
                      '0035 anon cannot call mark_password_set');
reset role;

rollback;
