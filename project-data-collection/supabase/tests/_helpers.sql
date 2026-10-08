-- =====================================================================
-- supabase/tests/_helpers.sql
-- Prepended to every test file by supabase/tests/run.mjs. Session-local
-- (pg_temp) helpers only; nothing here persists.
--
-- How a test impersonates a user, exactly the way PostgREST does it:
--
--   reset role;                              -- back to postgres
--   select pg_temp.login('electrical@voltworks.com');
--   set local role authenticated;
--   ... statements now run under RLS as that user ...
--
-- Every test file is ONE transaction ending in ROLLBACK, so tests leave
-- no rows behind and can run against the shared local database at any
-- time, in any order.
-- =====================================================================

\set ON_ERROR_STOP 1
\set QUIET 1
\pset pager off
-- Query results are noise here; PASS/FAIL arrive as NOTICEs on stderr.
\o /dev/null

-- Sets request.jwt.claims (transaction-local) to the auth.users row for
-- p_email. auth.uid() / auth.jwt() / ship.current_email() all read this.
create or replace function pg_temp.login(p_email text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  select u.id into v_id from auth.users u where lower(u.email) = lower(p_email);
  if v_id is null then
    raise exception 'test setup: no auth.users row for % (run npm run db:users)', p_email;
  end if;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_id, 'email', lower(p_email), 'role', 'authenticated')::text,
    true);
  return v_id;
end;
$$;

-- Creates a throwaway auth.users row (inside the test's transaction, so
-- it is rolled back). For invited emails that have no seeded account.
create or replace function pg_temp.make_user(p_email text, p_confirmed boolean default true)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          lower(p_email), case when p_confirmed then now() end, now(), now());
  return v_id;
end;
$$;

-- Assertion: raises (aborting the run) when p_cond is not true.
create or replace function pg_temp.ok(p_cond boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_label using errcode = 'P0001';
  end if;
  raise notice 'PASS: %', p_label;
end;
$$;

-- Runs p_sql and asserts it raises SQLSTATE p_state (and, optionally,
-- that the message contains p_like). Any other outcome aborts the run.
create or replace function pg_temp.throws(p_sql text, p_state text, p_label text, p_like text default null)
returns void
language plpgsql
as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is null then
    raise exception 'FAIL: % -- expected SQLSTATE %, but the statement succeeded', p_label, p_state
      using errcode = 'P0001';
  end if;
  if v_state <> p_state then
    raise exception 'FAIL: % -- expected SQLSTATE %, got % (%)', p_label, p_state, v_state, v_msg
      using errcode = 'P0001';
  end if;
  if p_like is not null and position(p_like in v_msg) = 0 then
    raise exception 'FAIL: % -- message "%" does not contain "%"', p_label, v_msg, p_like
      using errcode = 'P0001';
  end if;
  raise notice 'PASS: % (% %)', p_label, v_state, v_msg;
end;
$$;

-- pg_temp functions are owned by postgres but must be callable after
-- `set local role authenticated`.
grant execute on function pg_temp.login(text) to authenticated;
grant execute on function pg_temp.ok(boolean, text) to authenticated;
grant execute on function pg_temp.throws(text, text, text, text) to authenticated;

\unset QUIET
