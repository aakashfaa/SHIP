-- =====================================================================
-- 0002_ship_rls.sql
-- SHIP -- privilege grants, RLS helper functions, RLS policies.
--
-- TWO THINGS ARE REQUIRED, NOT ONE
-- --------------------------------
-- RLS is a FILTER, not a GRANT. `enable row level security` + a permissive
-- policy still yields "permission denied for table" unless the role also
-- holds the table privilege. So every readable/writable table below gets
-- BOTH a `grant` and a policy.
--
-- Only `authenticated` is ever granted anything. `anon` gets nothing --
-- SHIP has no anonymous surface, and `anon` is shared with the other
-- project on this database.
--
-- THREE TABLES GET NO GRANTS AT ALL:
--   ship.item_number_counters
--   ship.chunk_number_counters
--   ship.pending_invites
-- They are reachable only through the SECURITY DEFINER functions in
-- 0003/0004. RLS is still enabled on them as defence in depth.
--
-- WHY EVERY POLICY PREDICATE IS A SECURITY DEFINER FUNCTION
-- ---------------------------------------------------------
-- A policy on ship.profiles that reads ship.profiles inline re-enters its
-- own policy and fails with:
--     42P17 infinite recursion detected in policy for relation "profiles"
-- A SECURITY DEFINER function runs as its OWNER, and a table's owner
-- bypasses that table's RLS, so the inner query never re-enters the
-- policy. Same trick breaks the profiles -> project_members ->
-- project_members loop.
--
-- Every helper carries `set search_path = ''`. That is mandatory, not
-- cosmetic: without it a caller can prepend a schema they control to
-- search_path and hijack an unqualified name inside a function that runs
-- as a superuser-owned definer. The empty path means EVERY name must be
-- schema-qualified -- including `auth.uid()` and `auth.jwt()`.
-- (pg_catalog is always implicitly searched, so `lower`, `exists`, and
-- the operators still resolve.)
--
-- DO NOT `alter table ... force row level security` on these tables.
-- FORCE makes the owner subject to RLS too, which would put the recursion
-- straight back -- the definer helpers depend on owner bypass.
--
-- Re-runnable: `create or replace function`, and every policy is
-- `drop policy if exists` + `create policy` (there is no
-- `create policy if not exists` in Postgres).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Schema usage
-- ---------------------------------------------------------------------
grant usage on schema ship to authenticated;
-- Explicitly NOT granted to anon:
--   grant usage on schema ship to anon;   <-- never do this

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

-- The signed-in auth.users id, hardened behind an empty search_path.
-- Reads a GUC, touches no table, so it can never recurse.
create or replace function ship.current_uid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;

-- The signed-in user's email, lowercased. This is the join key for
-- project_members.email and line_items.user_email, neither of which has
-- an FK to profiles.
create or replace function ship.current_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''))
$$;

-- Is the caller a SHIP user at all? This -- not auth.users -- is the
-- isolation boundary against the other project sharing this database.
create or replace function ship.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from ship.profiles p
    where p.id = auth.uid()
      and p.is_active
  )
$$;

create or replace function ship.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from ship.profiles p
    where p.id = auth.uid()
      and p.is_active
      and p.role = 'admin'
  )
$$;

-- Membership by EMAIL, not by profile id -- project_members is populated
-- from the consultant email lists before those people have accounts.
create or replace function ship.is_member(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ship.is_active_user()
     and exists (
       select 1
       from ship.project_members m
       where m.project_id = p_project_id
         and m.email = ship.current_email()
     )
$$;

create or replace function ship.can_read_project(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ship.is_admin() or ship.is_member(p_project_id)
$$;

-- Resolves a chunk to its project WITHOUT re-entering chunk_projects'
-- own policy -- this function is the definer, so the lookup below
-- bypasses RLS on chunk_projects.
create or replace function ship.can_access_chunk(p_chunk_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ship.can_read_project((
    select c.project_id
    from ship.chunk_projects c
    where c.id = p_chunk_project_id
  ))
$$;

revoke all on function ship.current_uid()              from public;
revoke all on function ship.current_email()            from public;
revoke all on function ship.is_active_user()           from public;
revoke all on function ship.is_admin()                 from public;
revoke all on function ship.is_member(text)            from public;
revoke all on function ship.can_read_project(text)     from public;
revoke all on function ship.can_access_chunk(uuid)     from public;

grant execute on function ship.current_uid()           to authenticated;
grant execute on function ship.current_email()         to authenticated;
grant execute on function ship.is_active_user()        to authenticated;
grant execute on function ship.is_admin()              to authenticated;
grant execute on function ship.is_member(text)         to authenticated;
grant execute on function ship.can_read_project(text)  to authenticated;
grant execute on function ship.can_access_chunk(uuid)  to authenticated;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere (including the three ungranted tables)
-- ---------------------------------------------------------------------
alter table ship.profiles                  enable row level security;
alter table ship.projects                  enable row level security;
alter table ship.project_consultants       enable row level security;
alter table ship.project_members           enable row level security;
alter table ship.line_items                enable row level security;
alter table ship.chunk_projects            enable row level security;
alter table ship.chunk_project_items       enable row level security;
alter table ship.project_timeline_settings enable row level security;
alter table ship.item_number_counters      enable row level security;
alter table ship.chunk_number_counters     enable row level security;
alter table ship.pending_invites           enable row level security;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

-- profiles: SELECT plus a COLUMN-LEVEL update on `name` only. This is
-- what stops a consultant from self-escalating by PATCHing their own
-- role -- the privilege simply is not held, regardless of policy.
grant select            on ship.profiles to authenticated;
grant update (name)     on ship.profiles to authenticated;
-- NOTE the consequence: an admin cannot flip someone's role over
-- PostgREST either, because the `authenticated` role holds no privilege
-- on profiles.role at all. Role changes are a service_role / SQL editor
-- operation by design. If that becomes a product requirement, widen the
-- grant to `grant update (name, role, is_active)` -- the
-- profiles_admin_all policy below already permits it.

grant select, insert, update, delete on ship.projects                  to authenticated;
grant select, insert, update, delete on ship.project_consultants       to authenticated;
grant select, insert, update, delete on ship.project_members           to authenticated;
grant select, insert, update, delete on ship.line_items                to authenticated;
grant select, insert, update, delete on ship.chunk_projects            to authenticated;
grant select, insert, update, delete on ship.chunk_project_items       to authenticated;
grant select, insert, update, delete on ship.project_timeline_settings to authenticated;

-- Deliberately absent -- SECURITY DEFINER access only:
--   ship.item_number_counters
--   ship.chunk_number_counters
--   ship.pending_invites

-- ---------------------------------------------------------------------
-- profiles policies
-- No INSERT policy for `authenticated`, and no insert grant: rows are
-- created exclusively by ship.claim_invite() (0004).
-- ---------------------------------------------------------------------
drop policy if exists profiles_select      on ship.profiles;
drop policy if exists profiles_update_self on ship.profiles;
drop policy if exists profiles_admin_all   on ship.profiles;

create policy profiles_select on ship.profiles
  for select to authenticated
  using (ship.is_admin() or id = ship.current_uid());

create policy profiles_update_self on ship.profiles
  for update to authenticated
  using      (id = ship.current_uid())
  with check (id = ship.current_uid());

create policy profiles_admin_all on ship.profiles
  for all to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

-- ---------------------------------------------------------------------
-- projects / project_consultants / project_members
-- Read: anyone who can read the project. Write: admins only.
-- ---------------------------------------------------------------------
drop policy if exists projects_select    on ship.projects;
drop policy if exists projects_admin_all on ship.projects;

create policy projects_select on ship.projects
  for select to authenticated
  using (ship.can_read_project(id));

create policy projects_admin_all on ship.projects
  for all to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

drop policy if exists project_consultants_select    on ship.project_consultants;
drop policy if exists project_consultants_admin_all on ship.project_consultants;

create policy project_consultants_select on ship.project_consultants
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy project_consultants_admin_all on ship.project_consultants
  for all to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

drop policy if exists project_members_select    on ship.project_members;
drop policy if exists project_members_admin_all on ship.project_members;

create policy project_members_select on ship.project_members
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy project_members_admin_all on ship.project_members
  for all to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

-- ---------------------------------------------------------------------
-- line_items -- "read everything in the project, write only your own"
--
-- Verified against the UI, not guessed:
--   components/project-workspace/MasterViewTab.tsx:83
--     getLineItemsForProject(projectId)            -> ALL items, so a
--     consultant must be able to SELECT rows owned by other consultants.
--   components/project-workspace/AddDataTab.tsx:226
--     getLineItemsForProjectUser(projectId, email) -> own items only,
--     which is the editing surface.
-- ---------------------------------------------------------------------
drop policy if exists line_items_select on ship.line_items;
drop policy if exists line_items_insert on ship.line_items;
drop policy if exists line_items_update on ship.line_items;
drop policy if exists line_items_delete on ship.line_items;

create policy line_items_select on ship.line_items
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy line_items_insert on ship.line_items
  for insert to authenticated
  with check (
    ship.can_read_project(project_id)
    and (ship.is_admin() or user_email = ship.current_email())
  );

create policy line_items_update on ship.line_items
  for update to authenticated
  using (
    ship.is_admin()
    or (user_email = ship.current_email() and ship.is_member(project_id))
  )
  with check (
    ship.can_read_project(project_id)
    and (ship.is_admin() or user_email = ship.current_email())
  );

create policy line_items_delete on ship.line_items
  for delete to authenticated
  using (
    ship.is_admin()
    or (user_email = ship.current_email() and ship.is_member(project_id))
  );

-- ---------------------------------------------------------------------
-- chunk_projects / chunk_project_items / project_timeline_settings
--
-- Read AND write are both `can_read_project(...)`, i.e. any project
-- member may chunk. That is deliberate: consultants are routed to the
-- Chunking and Timeline tabs by
-- components/project-workspace/ProjectDashboardShell.tsx:49-54, so an
-- admin-only write policy would give them a read-only UI that silently
-- fails on every drag.
--
-- >>> IF CHUNKING EVER BECOMES ADMIN-ONLY, THESE THREE POLICIES ARE THE
-- >>> ONLY THING TO CHANGE: swap `ship.can_read_project(...)` for
-- >>> `ship.is_admin()` in the USING and WITH CHECK of the *_write
-- >>> policies below, and leave the *_select policies alone.
-- ---------------------------------------------------------------------
drop policy if exists chunk_projects_select on ship.chunk_projects;
drop policy if exists chunk_projects_write  on ship.chunk_projects;

create policy chunk_projects_select on ship.chunk_projects
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy chunk_projects_write on ship.chunk_projects
  for all to authenticated
  using      (ship.can_read_project(project_id))
  with check (ship.can_read_project(project_id));

drop policy if exists chunk_project_items_select on ship.chunk_project_items;
drop policy if exists chunk_project_items_write  on ship.chunk_project_items;

create policy chunk_project_items_select on ship.chunk_project_items
  for select to authenticated
  using (ship.can_access_chunk(chunk_project_id));

create policy chunk_project_items_write on ship.chunk_project_items
  for all to authenticated
  using      (ship.can_access_chunk(chunk_project_id))
  with check (ship.can_access_chunk(chunk_project_id));

drop policy if exists project_timeline_settings_select on ship.project_timeline_settings;
drop policy if exists project_timeline_settings_write  on ship.project_timeline_settings;

create policy project_timeline_settings_select on ship.project_timeline_settings
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy project_timeline_settings_write on ship.project_timeline_settings
  for all to authenticated
  using      (ship.can_read_project(project_id))
  with check (ship.can_read_project(project_id));

-- ---------------------------------------------------------------------
-- item_number_counters / chunk_number_counters / pending_invites
--
-- RLS is enabled and NO policy is defined, which denies everything to
-- every non-owner role. Combined with the absence of any grant, that is
-- two independent locks. The SECURITY DEFINER functions in 0003/0004 run
-- as the owner and bypass both.
-- ---------------------------------------------------------------------

commit;

-- =====================================================================
-- HOW TO VERIFY (paste into the Supabase SQL editor, uncommented)
--
-- The SQL editor runs as a superuser, which bypasses RLS entirely, so a
-- query that "works" there proves nothing. Impersonate instead. Always
-- inside an explicit transaction with `set local`, so the settings are
-- discarded on rollback.
--
-- -- 1. Find two real ids to impersonate:
-- --    select id, email, role from ship.profiles order by role;
--
-- -- 2. A CONSULTANT on federal-campus-master-plan.
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"00000000-0000-0000-0000-000000000000","email":"planning@atlasmech.com","role":"authenticated"}';
--
--   select ship.current_email();                    -- planning@atlasmech.com
--   select ship.is_active_user(), ship.is_admin();  -- t, f
--   select ship.can_read_project('federal-campus-master-plan');  -- t
--   select ship.can_read_project('library-renovation');          -- f
--
--   select id, name from ship.projects;             -- ONLY their projects
--   select count(*) from ship.line_items;           -- ALL items in their projects
--   -- writes to somebody else's item must fail with 42501:
--   update ship.line_items set name = 'nope' where user_email <> ship.current_email();
--   -- expected: 0 rows (silently filtered by the USING clause)
--   -- privilege escalation must be refused:
--   update ship.profiles set role = 'admin' where id = ship.current_uid();
--   -- expected: ERROR 42501 permission denied for table profiles
-- rollback;
--
-- -- 3. AN OUTSIDER -- a user of the OTHER project on this database.
-- --    They authenticate fine, but have no ship.profiles row.
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"11111111-1111-1111-1111-111111111111","email":"someone@otherproject.test","role":"authenticated"}';
--
--   select ship.is_active_user();          -- f
--   select count(*) from ship.projects;    -- 0
--   select count(*) from ship.line_items;  -- 0
--   select count(*) from ship.profiles;    -- 0
--   select * from ship.pending_invites;    -- ERROR 42501 permission denied
--   select ship.claim_invite();            -- ERROR 42501 not on the invite list
-- rollback;
--
-- -- 4. AN ADMIN.
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"22222222-2222-2222-2222-222222222222","email":"admin@gmail.com","role":"authenticated"}';
--   select ship.is_admin();                -- t
--   select count(*) from ship.projects;    -- all 3
-- rollback;
--
-- NOTE: `set local role authenticated` requires the outer session to be
-- allowed to SET ROLE to it (the SQL editor's postgres role is).
-- =====================================================================
