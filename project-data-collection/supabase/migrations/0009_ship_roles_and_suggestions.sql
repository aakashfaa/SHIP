-- =====================================================================
-- 0009_ship_roles_and_suggestions.sql
-- SHIP -- per-project roles, the rewritten policy surface, and the
--         suggest-only review workflow.
--
-- This file implements SPEC-v2 s1.5 (R5.1-R5.4) and s4. It is the most
-- security-sensitive migration in the v2 release: it replaces most of
-- the policy surface created by 0002 and widened/narrowed by
-- 0006/0007/0008. Read the whole header before editing anything below.
--
-- SHARED DATABASE RULES (supabase/README.md) STILL APPLY, UNCHANGED
-- -----------------------------------------------------------------
--   * Everything created here lives in schema `ship`. Nothing in
--     public/auth/storage/realtime/extensions.
--   * No `create extension`. Emails stay lowercase `text` + CHECK.
--   * No trigger on auth.users.
--   * Grants go to `authenticated` only. `anon` gets nothing.
--   * Nothing is added to the supabase_realtime publication.
--   * One `begin; ... commit;` for the whole file.
--   * NEVER `alter table ... force row level security` on a ship table:
--     the SECURITY DEFINER helpers below depend on the owner bypassing
--     RLS, and FORCE puts `42P17 infinite recursion` straight back.
--
--
-- 1. TWO DIFFERENT THINGS ARE BOTH CALLED "admin". READ THIS TWICE.
-- ------------------------------------------------------------------
-- This is the thing a future reader is most likely to get wrong, so it
-- is stated first and repeated at every site that depends on it.
--
--   ship.profiles.role = 'admin'   -->  PLATFORM admin.
--       Global, one value for the whole install. It means:
--         "can create projects, and sees/administers EVERY project."
--       It is what ship.is_admin() returns, what 0004's create_project()
--       / update_project() / ensure_invites() gate on, and what
--       app/api/admin/invite/route.ts checks. UNCHANGED by this file.
--       R5.4 keeps it deliberately: somebody has to be able to make a
--       project before any per-project role can exist on it.
--
--   ship.project_roles.role = 'admin'  -->  PROJECT admin.
--       Scoped to one (project_id, email). It means:
--         "full authority ON THIS PROJECT, including managing its
--          members and their roles."
--       It says nothing about other projects and confers no right to
--       create projects.
--
-- Project authority is therefore resolved by ship.project_role(project),
-- NOT by profiles.role. A platform admin is treated as project 'admin'
-- everywhere -- they already saw and wrote everything before this file,
-- and removing that would be a silent, large access regression -- but
-- the converse is false: a project admin is not a platform admin.
--
-- The practical consequence for anyone reading app code: `role ===
-- 'admin'` on a profile is NOT the question "may this person edit this
-- project". That question is `ship.project_role(projectId)`.
--
--
-- 2. THE ROLE MATRIX (SPEC s1.5 R5.1), AS IMPLEMENTED
-- ----------------------------------------------------
--                | own line | others'  | packages | cost/energy | members
--                | items    | items    | & sched. | settings    |
--   -------------+----------+----------+----------+-------------+--------
--   admin        | CRUD     | CRUD     | CRUD     | CRUD        | CRUD
--   editor       | CRUD     | CRUD     | CRUD     | CRUD        | read
--   consultant   | CRUD     | read +   | read     | read        | read
--                |          | SUGGEST  |          |             |
--   viewer       | read     | read     | read     | read        | --
--
--   "packages & schedule" = chunk_projects, chunk_project_items,
--       chunk_phases, phase_dependencies, phase_templates,
--       phase_template_steps, project_timeline_settings.
--   "cost/energy settings" = project_cost_settings,
--       escalation_rate_overrides, project_energy_settings,
--       project_taxonomy_values.
--   "members" = project_members, project_consultants, project_roles.
--
--   ONE DISCREPANCY, RESOLVED DELIBERATELY: the prose table in SPEC
--   s1.5 shows `editor` with *read* on cost settings, while the
--   implementation marker left in 0006 says those write policies
--   "become `editor or admin on this project`". This file follows
--   0006's marker (editor writes cost and energy settings), because an
--   editor who owns "packages & schedule" but cannot set the escalation
--   rate that prices that schedule cannot actually do the job.
--   Narrowing it later is a one-line change per policy: swap
--   my_editable_project_ids() for my_admin_project_ids() in the eight
--   settings/taxonomy write policies below.
--
--   "viewer | members | --" is implemented as a real READ restriction:
--   viewers cannot read project_members / project_consultants /
--   project_roles, other than their own role row, which the client needs
--   in order to render anything at all. R5.3's non-persisting sandbox is
--   a client concern -- a viewer simply holds no write privilege here.
--
--
-- 3. PERFORMANCE: WHY THERE ARE TWO SHAPES OF HELPER, AND WHERE EACH
--    ONE IS ALLOWED. DO NOT "SIMPLIFY" THIS AWAY.
-- ------------------------------------------------------------------
-- This is the reason the helpers below look redundant. They are not.
--
--   (a) SET-RETURNING helpers -- ship.my_project_ids(),
--       ship.my_editable_project_ids(), ship.my_readable_chunk_ids(),
--       and friends -- take NO arguments. Used as
--
--           project_id in (select ship.my_editable_project_ids())
--
--       the subquery references no column of the row being filtered, so
--       it is UNCORRELATED. The planner hoists it into a single InitPlan
--       evaluated ONCE PER STATEMENT whose result is reused for every
--       row: one membership lookup for the whole query.
--
--   (b) BOOLEAN helpers that take a row column as an argument --
--       ship.can_edit_project(project_id) -- are CORRELATED by
--       construction. The argument changes per row, so the planner
--       cannot hoist anything: the function is invoked once for EVERY
--       ROW the executor examines. (`stable` permits caching within a
--       single expression evaluation, not across rows.)
--
--   On ship.line_items -- the biggest table, and the one every screen
--   reads -- (b) is the difference between one membership lookup and
--   one lookup per line item. That is the entire performance story of
--   this file.
--
--   THE RULE, followed without exception below:
--       SELECT / UPDATE / DELETE  USING   -> set-returning form.
--       UPDATE                WITH CHECK  -> set-returning form
--                                            (mirrors its USING; also
--                                             uncorrelated, also hoisted).
--       INSERT                WITH CHECK  -> boolean form.
--
--   Why INSERT is the exception: an INSERT ... WITH CHECK is evaluated
--   against the rows being inserted, which is one row in every path this
--   app has. Materialising the caller's ENTIRE project/chunk/phase id
--   set to answer a question about one known project id is strictly more
--   work than a single indexed lookup. Boolean belongs there, and only
--   there.
--
--   If you are here because you want to collapse these into one helper:
--   don't. Measure first, under impersonation, with
--       explain (analyze, buffers) select * from ship.line_items;
--   and compare the InitPlan / Function Scan counts.
--
--
-- 4. STRUCTURAL RULES THIS FILE FOLLOWS
-- --------------------------------------
--   * Every policy predicate is a SECURITY DEFINER helper with
--     `set search_path = ''`. Mandatory, not cosmetic: an empty path
--     means every name must be schema-qualified, so a caller cannot
--     prepend a schema they control and hijack an unqualified name
--     inside a function running as the (superuser) owner. It is also
--     what stops `42P17 infinite recursion detected in policy` when a
--     policy on ship.project_roles has to read ship.project_roles.
--   * revoke-then-grant on every function, exactly as 0002/0003/0004/0005.
--   * SEPARATE POLICY PER COMMAND. Never `FOR ALL`. A tiered model is
--     read-wide / write-narrow, which is two different predicates by
--     construction; `FOR ALL` forces them to be the same one, and every
--     `FOR ALL` policy in 0002/0007 is dropped here for that reason.
--   * EVERY UPDATE POLICY CARRIES A WITH CHECK MIRRORING ITS USING.
--     Without it a writer can transplant a row into another project by
--     UPDATEing its project_id: USING passes (the row is currently in a
--     project they may write) and the NEW project_id is never validated.
--     That single omission defeats the entire tenant boundary, on every
--     table, which is why it is repeated fifteen times below instead of
--     being factored out.
--   * RLS filters, GRANT authorises, and BOTH are required. A permissive
--     policy without a grant still yields "permission denied for table".
--
-- Re-runnable: `create table if not exists`, `create or replace
-- function`, `drop policy if exists` + `create policy`, and a backfill
-- guarded by `on conflict do nothing`.
-- =====================================================================

begin;

-- =====================================================================
-- SECTION 1 -- ship.project_roles
-- =====================================================================

-- ---------------------------------------------------------------------
-- KEYED ON EMAIL, NOT ON profiles.id -- the same deliberate choice
-- 0001 documents for ship.project_members, for the same reason: a
-- project lists the people who will work on it BEFORE they have
-- accounts. An admin sets up the team, ship.ensure_invites() puts those
-- addresses on the allowlist, and only later (possibly never) does each
-- person sign up and get a ship.profiles row. A FK to profiles(id) would
-- make it impossible to assign a role to a person who has not signed in
-- yet, which is precisely the moment you want to assign it.
--
-- Corollary, and it is the important one: a role row is NOT proof that a
-- SHIP user exists. Every helper below therefore ANDs the lookup with
-- ship.is_active_user(), so a role granted to an address with no active
-- profile grants nothing until that person actually claims their invite.
--
-- granted_by is an EMAIL, not a uuid FK to profiles. Two reasons:
--   1. Symmetry with the key -- the granter may themselves be listed
--      before having an account.
--   2. 0002's profiles_select policy lets a non-platform-admin read only
--      their OWN profile row. A uuid here would be unresolvable in the
--      client for every non-admin: the UI would render a bare uuid next
--      to the grantee's address. The email is the displayable value.
-- ---------------------------------------------------------------------
create table if not exists ship.project_roles (
  project_id  text not null references ship.projects(id) on delete cascade,
  email       text not null check (email = lower(email) and email <> ''),
  role        text not null check (role in ('admin','editor','consultant','viewer')),
  granted_by  text check (granted_by is null or granted_by = lower(granted_by)),
  granted_at  timestamptz not null default now(),
  primary key (project_id, email)
);

comment on table ship.project_roles is
  'Per-project authority (SPEC R5.1). PROJECT admin here is not the same thing as the PLATFORM admin in ship.profiles.role -- see the 0009 header. Keyed on email, like project_members, because a project lists people before they have accounts.';

comment on column ship.project_roles.role is
  'admin = full authority on THIS project incl. members/roles. editor = everything except managing members. consultant = own line items + suggestions on others. viewer = read only.';

-- The PK already indexes (project_id, email) and therefore project_id.
-- This index serves the other direction, which is the hot one: every
-- set-returning helper below starts from `where email = current_email()`
-- to build the caller's project set. It is load bearing -- do not drop
-- it. (Exactly the same argument 0001 makes for project_members_email_idx.)
create index if not exists project_roles_email_idx on ship.project_roles (email);

-- =====================================================================
-- SECTION 2 -- Backfill from project_members
--
-- WHY EVERY EXISTING MEMBER BECOMES 'editor' AND NOT 'consultant'
-- ---------------------------------------------------------------
-- 'consultant' looks like the natural mapping: project_members carries a
-- consultant_type, the people in it are consultants, and the spec has a
-- role with that exact name. It is the wrong choice, and choosing it
-- would be a silent access regression on every live project.
--
-- What a project member can do TODAY, before this file runs:
--   * 0002 chunk_projects_write / chunk_project_items_write /
--     project_timeline_settings_write are all
--     `using (ship.can_read_project(...))` -- ANY member may create,
--     edit and delete packages and timeline settings.
--   * 0007 chunk_phases_write / phase_dependencies_write /
--     phase_templates_write / phase_template_steps_write are the same,
--     and 0007's own marker says so: "consultants are routed to the
--     Chunking and Timeline tabs, so an admin-only write policy hands
--     them a UI that silently fails on every drag."
--
-- Under the new matrix 'consultant' is READ-ONLY on packages and
-- schedule. Mapping today's members to 'consultant' would therefore take
-- away, with no announcement and no UI affordance to restore it, a
-- capability every one of them has right now and is actively routed to.
-- Their Timeline tab would keep rendering and start failing on every
-- drag -- the exact failure mode 0007 refused to ship.
--
-- 'editor' is the role whose permissions equal what a member holds
-- today: CRUD on line items and on packages/schedule, read on members.
-- (It is in fact slightly wider on cost settings, which were
-- platform-admin-only under 0006. That widening is bounded, visible, and
-- goes to people already trusted with the schedule those settings price;
-- the alternative -- a bespoke fifth role that exists only to describe
-- the 2026 state of three policies -- is worse.)
--
-- THE PRINCIPLE, which applies to every future migration of this kind:
--   Preserving current behaviour is the safe migration.
--   Tightening is a deliberate act an admin performs afterwards, on a
--   project they are looking at, with a UI that tells them what changed.
--   A migration that quietly demotes live users is indistinguishable
--   from an outage to the people it demotes.
--
-- Platform admins (profiles.role = 'admin') become project 'admin' on
-- every project they are a member of. They do not need the row -- the
-- helpers below treat a platform admin as project admin everywhere --
-- but materialising it makes the members screen tell the truth about who
-- holds authority instead of showing an empty roster.
--
-- "Platform admin" is read from ship.profiles when there is a profile
-- and from ship.pending_invites when there is not. An admin who has been
-- invited but has never signed in has no profiles row yet -- profiles
-- are minted by ship.claim_invite() on first sign-in (README, "How a
-- user becomes a SHIP user") -- and pending_invites.role is exactly the
-- value claim_invite() will stamp on them when they do. Reading only
-- profiles would silently backfill that person as 'editor' on projects
-- they are meant to administer.
--
-- `on conflict do nothing` makes the backfill re-runnable and, more
-- importantly, makes it NEVER overwrite a role somebody has already
-- deliberately set. Re-running this file after an admin has demoted
-- someone to 'viewer' must not silently promote them back to 'editor'.
-- =====================================================================
insert into ship.project_roles (project_id, email, role, granted_by, granted_at)
select
  m.project_id,
  m.email,
  case when coalesce(p.role, pi.role) = 'admin' then 'admin' else 'editor' end,
  null,
  now()
from (select distinct project_id, email from ship.project_members) m
left join ship.profiles       p  on p.email  = m.email
left join ship.pending_invites pi on pi.email = m.email
on conflict (project_id, email) do nothing;

-- =====================================================================
-- SECTION 3 -- Role resolution
-- =====================================================================

-- ---------------------------------------------------------------------
-- ship.project_role(project) -- THE authority function. Everything else
-- in this file is a projection of it.
--
-- Resolution order, and each step is load bearing:
--   1. Not an active SHIP user      -> null. This is the isolation
--      boundary against the other project sharing this database
--      (README: "SHIP isolation comes entirely from ship.profiles
--      membership + RLS"). It is checked FIRST so that a stray
--      project_roles row for an address that never claimed an invite
--      grants nothing.
--   2. Platform admin               -> 'admin' on every project.
--   3. An explicit project_roles row -> that role. Always wins over 4,
--      which is what makes 'viewer' expressible for somebody who is also
--      a discipline member.
--   4. A project_members row with no role row -> 'consultant'.
--
-- WHY STEP 4 EXISTS, and why it is 'consultant' rather than null:
--   Section 2 backfills every member that exists the moment this file
--   runs, so step 4 is only ever reached by a member added AFTERWARDS
--   whose role row has not been written -- 0004's update_project() adds
--   project_members rows and knows nothing about project_roles, and the
--   v2 client is what will start writing both.
--   Returning null there would mean a newly added consultant signs in,
--   sees the project, and silently cannot create the line items they
--   were added to create. Returning 'consultant' means the least
--   privilege that still lets a discipline member do their actual job:
--   their own line items, plus suggestions on everyone else's. Nothing
--   on the schedule, nothing on settings.
--   This is intentionally NOT the same mapping as the backfill, and the
--   difference is the point: the backfill's job is to not remove access
--   anyone already has, while the fallback's job is to be the safest
--   useful default for access nobody has been granted yet.
-- ---------------------------------------------------------------------
create or replace function ship.project_role(p_project_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_project_id is null            then null
    when not ship.is_active_user()       then null
    when ship.is_admin()                 then 'admin'
    else coalesce(
      (select r.role
         from ship.project_roles r
        where r.project_id = p_project_id
          and r.email = ship.current_email()),
      (select 'consultant'
         from ship.project_members m
        where m.project_id = p_project_id
          and m.email = ship.current_email()
        limit 1)
    )
  end
$$;

comment on function ship.project_role(text) is
  'The caller role on one project: admin | editor | consultant | viewer | null. PLATFORM admins (profiles.role) resolve to project admin everywhere. A project_members row with no project_roles row falls back to consultant. See the 0009 header.';

-- ---------------------------------------------------------------------
-- Boolean helpers. INSERT ... WITH CHECK ONLY -- see header section 3.
-- Each is a thin projection of project_role() so there is exactly one
-- place where the matrix is encoded.
-- `coalesce(... , false)` because project_role() returns null for an
-- outsider and `null in (...)` is null, which a policy treats as false
-- anyway; being explicit stops anyone reading this from having to
-- remember that.
-- ---------------------------------------------------------------------
create or replace function ship.is_project_admin(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(ship.project_role(p_project_id) = 'admin', false)
$$;

create or replace function ship.can_edit_project(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(ship.project_role(p_project_id) in ('admin','editor'), false)
$$;

-- "contributor" = may create/edit their OWN line items, and may file
-- suggestions against other people's. admin, editor, consultant -- every
-- role except viewer.
create or replace function ship.can_contribute_project(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(ship.project_role(p_project_id) in ('admin','editor','consultant'), false)
$$;

-- ---------------------------------------------------------------------
-- ship.can_read_project() is REDEFINED here, not left as 0002 wrote it.
--
-- 0002 defined it as `is_admin() or is_member()`, i.e. purely
-- project_members. After this file a person can hold a project_roles row
-- WITHOUT a project_members row -- a 'viewer' from the client side, who
-- has no discipline and therefore nowhere to live in project_members
-- (its PK includes consultant_type). Under the old definition such a
-- viewer would be granted a role and then see nothing.
--
-- Redefining it as "project_role() is not null" keeps every remaining
-- caller consistent with the new model. The only caller outside this
-- file is ship.can_access_phase() in 0007, which inherits the fix.
-- ---------------------------------------------------------------------
create or replace function ship.can_read_project(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ship.project_role(p_project_id) is not null
$$;

-- ---------------------------------------------------------------------
-- Set-returning helpers. SELECT/UPDATE/DELETE USING (and UPDATE WITH
-- CHECK) ONLY -- see header section 3. No arguments, by design: that is
-- what makes `x in (select ship.my_...())` uncorrelated and hoistable
-- into a single InitPlan per statement.
-- ---------------------------------------------------------------------

-- Everything the caller may READ. Platform admin -> every project.
create or replace function ship.my_project_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
    from ship.projects p
   where ship.is_admin()
  union
  select r.project_id
    from ship.project_roles r
   where ship.is_active_user()
     and r.email = ship.current_email()
  union
  select m.project_id
    from ship.project_members m
   where ship.is_active_user()
     and m.email = ship.current_email()
$$;

-- Everything the caller may WRITE wholesale: packages, schedule,
-- settings, and other people's line items. role in (admin, editor).
--
-- NOTE what is deliberately absent: a project_members arm. A member with
-- no explicit role row resolves to 'consultant' (see project_role), and
-- consultants do not edit the schedule. Adding a members arm here would
-- re-open exactly what the matrix closes.
create or replace function ship.my_editable_project_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
    from ship.projects p
   where ship.is_admin()
  union
  select r.project_id
    from ship.project_roles r
   where ship.is_active_user()
     and r.email = ship.current_email()
     and r.role in ('admin','editor')
$$;

-- Where the caller may manage members and roles. role = admin.
create or replace function ship.my_admin_project_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
    from ship.projects p
   where ship.is_admin()
  union
  select r.project_id
    from ship.project_roles r
   where ship.is_active_user()
     and r.email = ship.current_email()
     and r.role = 'admin'
$$;

-- Where the caller may CRUD their OWN line items and file suggestions.
-- role in (admin, editor, consultant) -- everyone except viewer.
--
-- The third arm is the project_members fallback from project_role(),
-- expressed in set form. The `not exists` is essential and is the one
-- subtle line in this function: WITHOUT it, somebody explicitly demoted
-- to 'viewer' who still has a project_members row (the normal case -- a
-- viewer is usually a consultant who was demoted, and demotion writes a
-- role row without deleting their discipline row) would be handed
-- contributor rights straight back through the fallback arm. An explicit
-- role row must always win, exactly as it does in project_role().
create or replace function ship.my_contributor_project_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
    from ship.projects p
   where ship.is_admin()
  union
  select r.project_id
    from ship.project_roles r
   where ship.is_active_user()
     and r.email = ship.current_email()
     and r.role in ('admin','editor','consultant')
  union
  select m.project_id
    from ship.project_members m
   where ship.is_active_user()
     and m.email = ship.current_email()
     and not exists (
       select 1
         from ship.project_roles r2
        where r2.project_id = m.project_id
          and r2.email = ship.current_email()
     )
$$;

-- ---------------------------------------------------------------------
-- Chunk / phase / template id sets.
--
-- chunk_project_items, chunk_phases and phase_template_steps are keyed
-- by a parent id, not by project_id, so their policies cannot use the
-- project-id sets directly. 0002/0007 solved that with the per-row
-- boolean ship.can_access_chunk(chunk_project_id), which by header
-- section 3 (b) runs once per row. These sets restore the single-InitPlan
-- property for those tables too: one pass over chunk_projects per
-- statement instead of one lookup per chunk item.
-- ---------------------------------------------------------------------
create or replace function ship.my_readable_chunk_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
    from ship.chunk_projects c
   where c.project_id in (select ship.my_project_ids())
$$;

create or replace function ship.my_editable_chunk_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
    from ship.chunk_projects c
   where c.project_id in (select ship.my_editable_project_ids())
$$;

create or replace function ship.my_readable_phase_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ph.id
    from ship.chunk_phases ph
   where ph.chunk_project_id in (select ship.my_readable_chunk_ids())
$$;

create or replace function ship.my_editable_phase_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ph.id
    from ship.chunk_phases ph
   where ph.chunk_project_id in (select ship.my_editable_chunk_ids())
$$;

-- Built-in templates (project_id is null) are readable by every active
-- SHIP user, exactly as 0007 had it.
create or replace function ship.my_readable_template_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
    from ship.phase_templates t
   where (t.project_id is null and ship.is_active_user())
      or t.project_id in (select ship.my_project_ids())
$$;

-- `project_id is not null` is what stops a member from editing or
-- creating a BUILT-IN template, which would publish it to every user of
-- the database. Carried over from 0007 unchanged; only the authority
-- test is narrowed from member to editor.
create or replace function ship.my_editable_template_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
    from ship.phase_templates t
   where t.project_id is not null
     and t.project_id in (select ship.my_editable_project_ids())
$$;

-- Boolean forms of the three above. INSERT ... WITH CHECK only.
create or replace function ship.can_edit_chunk(p_chunk_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ship.can_edit_project((
    select c.project_id from ship.chunk_projects c where c.id = p_chunk_project_id
  ))
$$;

create or replace function ship.can_edit_phase(p_phase_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ship.can_edit_project(ship.phase_project_id(p_phase_id))
$$;

create or replace function ship.can_edit_template(p_template_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select t.project_id is not null and ship.can_edit_project(t.project_id)
      from ship.phase_templates t
     where t.id = p_template_id
  ), false)
$$;

-- Resolves a line item to its project WITHOUT re-entering line_items'
-- own policy (this function is the definer, so the lookup bypasses RLS
-- on line_items). Same trick as 0002's can_access_chunk and 0007's
-- phase_project_id. Used by the suggestions INSERT policy to pin a
-- suggestion to the project its target actually lives in.
create or replace function ship.line_item_project_id(p_line_item_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select li.project_id from ship.line_items li where li.id = p_line_item_id
$$;

revoke all on function ship.project_role(text)                from public;
revoke all on function ship.is_project_admin(text)            from public;
revoke all on function ship.can_edit_project(text)            from public;
revoke all on function ship.can_contribute_project(text)      from public;
revoke all on function ship.can_read_project(text)            from public;
revoke all on function ship.my_project_ids()                  from public;
revoke all on function ship.my_editable_project_ids()         from public;
revoke all on function ship.my_admin_project_ids()            from public;
revoke all on function ship.my_contributor_project_ids()      from public;
revoke all on function ship.my_readable_chunk_ids()           from public;
revoke all on function ship.my_editable_chunk_ids()           from public;
revoke all on function ship.my_readable_phase_ids()           from public;
revoke all on function ship.my_editable_phase_ids()           from public;
revoke all on function ship.my_readable_template_ids()        from public;
revoke all on function ship.my_editable_template_ids()        from public;
revoke all on function ship.can_edit_chunk(uuid)              from public;
revoke all on function ship.can_edit_phase(uuid)              from public;
revoke all on function ship.can_edit_template(uuid)           from public;
revoke all on function ship.line_item_project_id(uuid)        from public;

grant execute on function ship.project_role(text)             to authenticated;
grant execute on function ship.is_project_admin(text)         to authenticated;
grant execute on function ship.can_edit_project(text)         to authenticated;
grant execute on function ship.can_contribute_project(text)   to authenticated;
grant execute on function ship.can_read_project(text)         to authenticated;
grant execute on function ship.my_project_ids()               to authenticated;
grant execute on function ship.my_editable_project_ids()      to authenticated;
grant execute on function ship.my_admin_project_ids()         to authenticated;
grant execute on function ship.my_contributor_project_ids()   to authenticated;
grant execute on function ship.my_readable_chunk_ids()        to authenticated;
grant execute on function ship.my_editable_chunk_ids()        to authenticated;
grant execute on function ship.my_readable_phase_ids()        to authenticated;
grant execute on function ship.my_editable_phase_ids()        to authenticated;
grant execute on function ship.my_readable_template_ids()     to authenticated;
grant execute on function ship.my_editable_template_ids()     to authenticated;
grant execute on function ship.can_edit_chunk(uuid)           to authenticated;
grant execute on function ship.can_edit_phase(uuid)           to authenticated;
grant execute on function ship.can_edit_template(uuid)        to authenticated;
grant execute on function ship.line_item_project_id(uuid)     to authenticated;

-- =====================================================================
-- SECTION 4 -- ship.suggestions  (SPEC R5.2)
--
--   "we talked about suggestions as well. So they can comment on stuff
--    that other consultants are doing, but not edit it directly."
--                                                          -- Megan
--
-- A suggestion is a PROPOSED patch, not a write. A consultant records
-- what they would have changed; an admin or editor applies or rejects
-- it. The patch is applied by ship.apply_suggestion() (section 8) and
-- by nothing else.
-- =====================================================================
create table if not exists ship.suggestions (
  id                uuid primary key default gen_random_uuid(),
  project_id        text not null references ship.projects(id) on delete cascade,
  -- Deliberately generic, deliberately constrained to one value today.
  -- The CHECK is the allowlist: adding 'chunk_phases' later is a
  -- migration that must also extend apply_suggestion's column allowlist,
  -- and the CHECK is what forces that to be a conscious edit rather than
  -- a client sending an unexpected string.
  target_table      text not null check (target_table in ('line_items')),
  target_id         uuid not null,
  -- No FK on target_id: it is polymorphic by design (target_table
  -- chooses the relation). The consequence is that deleting a line item
  -- leaves its suggestions behind. That is SAFE, not sloppy:
  -- apply_suggestion scopes its UPDATE to (id, project_id) and raises
  -- when it matches nothing, so a dangling suggestion fails loudly on
  -- review instead of writing anywhere. Deleting the PROJECT does
  -- cascade, via project_id above.
  patch             jsonb not null default '{}'::jsonb
                      check (jsonb_typeof(patch) = 'object'),
  note              text not null default '',
  status            text not null default 'pending'
                      check (status in ('pending','accepted','rejected')),
  created_by_email  text not null
                      check (created_by_email = lower(created_by_email) and created_by_email <> ''),
  created_at        timestamptz not null default now(),
  -- Emails, not uuids, for the same reason as project_roles.granted_by:
  -- 0002's profiles_select policy lets a non-platform-admin read only
  -- their own profile row, so a uuid reviewer is unresolvable in the
  -- client for exactly the consultant who most wants to know who
  -- rejected their suggestion.
  reviewed_by       text check (reviewed_by is null or reviewed_by = lower(reviewed_by)),
  reviewed_at       timestamptz,
  review_note       text not null default '',
  -- A decided suggestion must say who decided it and when. Without this
  -- a row could sit in 'rejected' with no accountability, and the audit
  -- trail is the entire point of routing an edit through review.
  constraint suggestions_reviewer_required_ck check (
    status = 'pending'
    or (reviewed_by is not null and reviewed_at is not null)
  ),
  -- The mirror: a pending row must NOT carry a reviewer. Stops a client
  -- from pre-stamping itself as the reviewer and then having
  -- apply_suggestion appear to confirm it.
  constraint suggestions_pending_unreviewed_ck check (
    status <> 'pending'
    or (reviewed_by is null and reviewed_at is null)
  )
);

comment on table ship.suggestions is
  'Proposed changes from consultants to line items they do not own (SPEC R5.2). Applied only by ship.apply_suggestion(); never by a direct UPDATE -- authenticated holds no UPDATE privilege on status.';

-- The review queue: "pending suggestions on this project".
create index if not exists suggestions_project_status_idx
  on ship.suggestions (project_id, status);

-- "my suggestions", the consultant-side list.
create index if not exists suggestions_created_by_email_idx
  on ship.suggestions (created_by_email);

-- "suggestions on this line item", shown next to the row being reviewed.
create index if not exists suggestions_target_idx
  on ship.suggestions (target_table, target_id);

-- ---------------------------------------------------------------------
-- ship.suggestable_line_item_columns()
--
-- THE COLUMN ALLOWLIST. A patch may touch these and nothing else.
--
-- This exists as a function rather than an inline array so the client
-- can render exactly the fields it is allowed to propose (one source of
-- truth, no drift between the form and the RPC that rejects it).
--
-- WHAT IS ABSENT IS THE POINT. Each exclusion is a live attack or a live
-- corruption, not tidiness:
--   id, project_id  -- the tenant boundary. A patch that could set
--                      project_id would move another project's row into
--                      the attacker's project, or the reverse.
--   user_email      -- ownership. line_items_update keys "your own item"
--                      off user_email; a patch that could rewrite it is
--                      a privilege escalation dressed as an edit.
--   item_number     -- assigned by ship.fill_item_number() from the
--                      race-safe counters in 0003. A hand-written value
--                      desynchronises the counter and the NEXT real
--                      insert dies on the unique (project_id,
--                      item_number) constraint.
--   consultant_type,
--   discipline      -- feed the item_number prefix (0003's
--                      discipline_prefix). Changing the discipline of a
--                      numbered item makes its number lie.
--   company_name    -- attribution, same class as user_email.
--   ecc_amount      -- derived. 0006's sync_line_item_ecc() trigger
--                      recomputes it from estimated_first_cost on every
--                      write, so a patched value would be silently
--                      discarded -- worse than refused, because the
--                      reviewer would believe it applied.
--   created_at, updated_at -- bookkeeping.
--
-- Everything listed IS a judgement about the work, which is exactly what
-- a consultant reviewing a colleague's item has an opinion about.
-- The four taxonomy-constrained columns stay in: 0008's
-- check_line_item_taxonomy trigger validates them against the project
-- vocabulary on write, so a bad value fails the apply loudly.
-- ---------------------------------------------------------------------
create or replace function ship.suggestable_line_item_columns()
returns text[]
language sql
immutable
as $$
  select array[
    'name',
    'short_description',
    'category',
    'timeline_priority',
    'building_area_impacted',
    'building_level_impacted',
    'operational_impact',
    'benefit_to_users',
    'benefit_to_public',
    'relative_first_cost',
    'estimated_first_cost',
    'relative_operation_cost_impact',
    'relative_operational_energy_usage',
    'electrification_eo594',
    'addressing_resiliency_sustainability',
    'addressing_deferred_maintenance',
    'code_life_safety_improvement',
    'accessibility_improvement',
    'historic_impact',
    'potential_synergies',
    'supporting_notes',
    'annual_energy_savings',
    'annual_cost_savings',
    'energy_notes'
  ]::text[]
$$;

comment on function ship.suggestable_line_item_columns() is
  'The only ship.line_items columns a suggestion patch may touch. Read by ship.apply_suggestion() and by the client that builds the suggest form. See the 0009 header for why each absent column is absent.';

revoke all    on function ship.suggestable_line_item_columns() from public;
grant execute on function ship.suggestable_line_item_columns() to authenticated;

-- =====================================================================
-- SECTION 5 -- Grants and RLS for the two new tables
--
-- RLS filters, GRANT authorises, both required (0002's opening note).
-- `anon` gets nothing, here as everywhere.
-- =====================================================================
grant select, insert, update, delete on ship.project_roles to authenticated;

alter table ship.project_roles enable row level security;
alter table ship.suggestions   enable row level security;

-- ---------------------------------------------------------------------
-- suggestions: a COLUMN-LEVEL update grant, and it is the strongest
-- control in this file.
--
-- `authenticated` may UPDATE only (patch, note). It holds NO update
-- privilege on `status`, `reviewed_by`, `reviewed_at` or `review_note`,
-- so a consultant cannot self-approve by PATCHing their own row to
-- status='accepted' -- not because a policy says no, but because the
-- privilege does not exist. Privilege beats policy: a policy mistake is
-- one predicate away from being wrong, while a missing column privilege
-- fails closed no matter what the policies say.
--
-- This is the same mechanism 0002 uses to stop self-escalation on
-- ship.profiles (`grant update (name)` and nothing else).
--
-- Status transitions therefore happen in exactly one place:
-- ship.apply_suggestion() / ship.reject_suggestion(), which are
-- SECURITY DEFINER and run as the owner, bypassing the column grant --
-- which is precisely why their internal authorisation checks are not
-- optional decoration. See section 8.
-- ---------------------------------------------------------------------
grant select, insert, delete on ship.suggestions to authenticated;
grant update (patch, note)   on ship.suggestions to authenticated;

-- =====================================================================
-- SECTION 6 -- The rewritten policy surface
--
-- Every policy below replaces one flagged in 0002, 0006, 0007 or 0008.
-- The markers in those files ('>>> 0009 WIDENS THIS' /
-- '>>> 0009 NARROWS THIS') point here.
--
-- Read the drops as the real change log: every `*_admin_all` and
-- `*_write` policy is a `FOR ALL` that this file replaces with one
-- policy per command, because a tiered model reads wider than it
-- writes and `FOR ALL` cannot express that.
-- =====================================================================

-- ---------------------------------------------------------------------
-- projects
--
-- INSERT stays ship.is_admin() -- PLATFORM admin. R5.4: creating a
-- project is the one authority that cannot come from a per-project role,
-- because the project does not exist yet to hold one.
--
-- UPDATE/DELETE widen from platform admin (0002's projects_admin_all) to
-- PROJECT admin. Platform admins are a subset of project admins here
-- (project_role() resolves them to 'admin' everywhere), so nobody loses
-- anything.
-- ---------------------------------------------------------------------
drop policy if exists projects_select    on ship.projects;
drop policy if exists projects_admin_all on ship.projects;
drop policy if exists projects_insert    on ship.projects;
drop policy if exists projects_update    on ship.projects;
drop policy if exists projects_delete    on ship.projects;

create policy projects_select on ship.projects
  for select to authenticated
  using (id in (select ship.my_project_ids()));

create policy projects_insert on ship.projects
  for insert to authenticated
  with check (ship.is_admin());

create policy projects_update on ship.projects
  for update to authenticated
  using      (id in (select ship.my_admin_project_ids()))
  with check (id in (select ship.my_admin_project_ids()));

create policy projects_delete on ship.projects
  for delete to authenticated
  using (id in (select ship.my_admin_project_ids()));

-- ---------------------------------------------------------------------
-- project_consultants / project_members -- the "members" column of the
-- matrix.
--
-- SELECT is my_contributor_project_ids(), NOT my_project_ids(): the
-- matrix gives `viewer` no access to members at all, and this is where
-- that is enforced. A viewer is typically a client stakeholder; the
-- roster of consultant email addresses is not theirs to have.
--
-- WRITE is project admin only. `editor` reads members and does not
-- manage them -- managing who is on a project is the one thing that
-- distinguishes the two roles.
-- ---------------------------------------------------------------------
drop policy if exists project_consultants_select    on ship.project_consultants;
drop policy if exists project_consultants_admin_all on ship.project_consultants;
drop policy if exists project_consultants_insert    on ship.project_consultants;
drop policy if exists project_consultants_update    on ship.project_consultants;
drop policy if exists project_consultants_delete    on ship.project_consultants;

create policy project_consultants_select on ship.project_consultants
  for select to authenticated
  using (project_id in (select ship.my_contributor_project_ids()));

create policy project_consultants_insert on ship.project_consultants
  for insert to authenticated
  with check (ship.is_project_admin(project_id));

create policy project_consultants_update on ship.project_consultants
  for update to authenticated
  using      (project_id in (select ship.my_admin_project_ids()))
  with check (project_id in (select ship.my_admin_project_ids()));

create policy project_consultants_delete on ship.project_consultants
  for delete to authenticated
  using (project_id in (select ship.my_admin_project_ids()));

drop policy if exists project_members_select    on ship.project_members;
drop policy if exists project_members_admin_all on ship.project_members;
drop policy if exists project_members_insert    on ship.project_members;
drop policy if exists project_members_update    on ship.project_members;
drop policy if exists project_members_delete    on ship.project_members;

create policy project_members_select on ship.project_members
  for select to authenticated
  using (project_id in (select ship.my_contributor_project_ids()));

create policy project_members_insert on ship.project_members
  for insert to authenticated
  with check (ship.is_project_admin(project_id));

create policy project_members_update on ship.project_members
  for update to authenticated
  using      (project_id in (select ship.my_admin_project_ids()))
  with check (project_id in (select ship.my_admin_project_ids()));

create policy project_members_delete on ship.project_members
  for delete to authenticated
  using (project_id in (select ship.my_admin_project_ids()));

-- ---------------------------------------------------------------------
-- project_roles -- the table that grants authority, so its own policies
-- are the ones an attacker cares about most.
--
-- SELECT: contributors see the whole roster (they need to know who to
-- send a suggestion to); a viewer sees ONLY THEIR OWN row. That last
-- clause is not a courtesy -- the client has to be able to read its own
-- role to render the right UI at all, and without it a viewer would load
-- an app that cannot tell it is a viewer.
--
-- INSERT/UPDATE/DELETE: project admin only, checked against the row's
-- OWN project_id. Three properties fall out of that, all of them
-- required:
--   * An editor/consultant/viewer cannot grant themselves anything --
--     they match no write policy at all.
--   * A project admin cannot grant themselves a role on a DIFFERENT
--     project: the INSERT WITH CHECK is evaluated on the new row's
--     project_id, which they are not admin of.
--   * A project admin cannot transplant an existing grant into another
--     project, because the UPDATE WITH CHECK re-tests the NEW
--     project_id. (This is the transplant bug from the header, and on
--     this table it would be an authority-forging bug, not just a
--     tenancy leak.)
--
-- No recursion despite a policy on project_roles reading project_roles:
-- my_contributor_project_ids() and friends are SECURITY DEFINER and run
-- as the owner, which bypasses this table's RLS. That is the whole trick
-- 0002 documents, applied to the one table where it matters most.
-- ---------------------------------------------------------------------
drop policy if exists project_roles_select on ship.project_roles;
drop policy if exists project_roles_insert on ship.project_roles;
drop policy if exists project_roles_update on ship.project_roles;
drop policy if exists project_roles_delete on ship.project_roles;

create policy project_roles_select on ship.project_roles
  for select to authenticated
  using (
    project_id in (select ship.my_contributor_project_ids())
    or (ship.is_active_user() and email = ship.current_email())
  );

create policy project_roles_insert on ship.project_roles
  for insert to authenticated
  with check (ship.is_project_admin(project_id));

create policy project_roles_update on ship.project_roles
  for update to authenticated
  using      (project_id in (select ship.my_admin_project_ids()))
  with check (project_id in (select ship.my_admin_project_ids()));

create policy project_roles_delete on ship.project_roles
  for delete to authenticated
  using (project_id in (select ship.my_admin_project_ids()));

-- ---------------------------------------------------------------------
-- line_items -- the biggest table, and the one the header's performance
-- note is about. Every predicate here is the set-returning form.
--
-- Verified against the UI, as 0002 did, not guessed:
--   components/project-workspace/MasterViewTab.tsx  reads ALL items in
--     the project -> SELECT stays project-wide for every role, viewer
--     included.
--   components/project-workspace/AddDataTab.tsx     reads the caller's
--     own items -> that is the editing surface for a consultant.
--
-- The matrix, line by line:
--   admin/editor -- CRUD anything in the project
--                   (my_editable_project_ids).
--   consultant   -- CRUD only rows where user_email is theirs
--                   (my_contributor_project_ids + the user_email test);
--                   for everyone else's rows they get SELECT and
--                   ship.suggestions.
--   viewer       -- SELECT only: they appear in my_project_ids but in
--                   neither of the other two sets, so no write policy
--                   matches and their UPDATE quietly affects 0 rows.
--
-- INSERT is the one place using the boolean helpers, per the header:
-- one row, one known project id, so a targeted lookup beats
-- materialising the whole id set.
-- ---------------------------------------------------------------------
drop policy if exists line_items_select on ship.line_items;
drop policy if exists line_items_insert on ship.line_items;
drop policy if exists line_items_update on ship.line_items;
drop policy if exists line_items_delete on ship.line_items;

create policy line_items_select on ship.line_items
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy line_items_insert on ship.line_items
  for insert to authenticated
  with check (
    ship.can_edit_project(project_id)
    or (ship.can_contribute_project(project_id) and user_email = ship.current_email())
  );

create policy line_items_update on ship.line_items
  for update to authenticated
  using (
    project_id in (select ship.my_editable_project_ids())
    or (user_email = ship.current_email()
        and project_id in (select ship.my_contributor_project_ids()))
  )
  -- The mirror. Without it a consultant could reassign their own item to
  -- another project (or to another user_email) in a single PATCH: USING
  -- passes on the row as it stands today and the new values are never
  -- tested.
  with check (
    project_id in (select ship.my_editable_project_ids())
    or (user_email = ship.current_email()
        and project_id in (select ship.my_contributor_project_ids()))
  );

create policy line_items_delete on ship.line_items
  for delete to authenticated
  using (
    project_id in (select ship.my_editable_project_ids())
    or (user_email = ship.current_email()
        and project_id in (select ship.my_contributor_project_ids()))
  );

-- ---------------------------------------------------------------------
-- chunk_projects / chunk_project_items -- "packages", admin+editor
-- write, everyone reads.
--
-- This NARROWS 0002's chunk_projects_write / chunk_project_items_write,
-- which let any project member write. That narrowing is the whole
-- reason section 2 backfills existing members as 'editor': done the
-- other way round it would have taken the Chunking tab away from every
-- consultant who uses it today.
-- ---------------------------------------------------------------------
drop policy if exists chunk_projects_select on ship.chunk_projects;
drop policy if exists chunk_projects_write  on ship.chunk_projects;
drop policy if exists chunk_projects_insert on ship.chunk_projects;
drop policy if exists chunk_projects_update on ship.chunk_projects;
drop policy if exists chunk_projects_delete on ship.chunk_projects;

create policy chunk_projects_select on ship.chunk_projects
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy chunk_projects_insert on ship.chunk_projects
  for insert to authenticated
  with check (ship.can_edit_project(project_id));

create policy chunk_projects_update on ship.chunk_projects
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy chunk_projects_delete on ship.chunk_projects
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

drop policy if exists chunk_project_items_select on ship.chunk_project_items;
drop policy if exists chunk_project_items_write  on ship.chunk_project_items;
drop policy if exists chunk_project_items_insert on ship.chunk_project_items;
drop policy if exists chunk_project_items_update on ship.chunk_project_items;
drop policy if exists chunk_project_items_delete on ship.chunk_project_items;

create policy chunk_project_items_select on ship.chunk_project_items
  for select to authenticated
  using (chunk_project_id in (select ship.my_readable_chunk_ids()));

create policy chunk_project_items_insert on ship.chunk_project_items
  for insert to authenticated
  with check (ship.can_edit_chunk(chunk_project_id));

create policy chunk_project_items_update on ship.chunk_project_items
  for update to authenticated
  using      (chunk_project_id in (select ship.my_editable_chunk_ids()))
  with check (chunk_project_id in (select ship.my_editable_chunk_ids()));

create policy chunk_project_items_delete on ship.chunk_project_items
  for delete to authenticated
  using (chunk_project_id in (select ship.my_editable_chunk_ids()));

-- ---------------------------------------------------------------------
-- project_timeline_settings -- schedule configuration, same tier as
-- packages.
-- ---------------------------------------------------------------------
drop policy if exists project_timeline_settings_select on ship.project_timeline_settings;
drop policy if exists project_timeline_settings_write  on ship.project_timeline_settings;
drop policy if exists project_timeline_settings_insert on ship.project_timeline_settings;
drop policy if exists project_timeline_settings_update on ship.project_timeline_settings;
drop policy if exists project_timeline_settings_delete on ship.project_timeline_settings;

create policy project_timeline_settings_select on ship.project_timeline_settings
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy project_timeline_settings_insert on ship.project_timeline_settings
  for insert to authenticated
  with check (ship.can_edit_project(project_id));

create policy project_timeline_settings_update on ship.project_timeline_settings
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy project_timeline_settings_delete on ship.project_timeline_settings
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

-- ---------------------------------------------------------------------
-- project_cost_settings / escalation_rate_overrides /
-- project_energy_settings -- 0006's ">>> 0009 WIDENS THIS" marker.
--
-- Write goes from PLATFORM admin only to project admin + editor, as
-- that marker specifies. Read stays project-wide: 0006's reasoning is
-- untouched -- "consultants need to see the factors to understand the
-- numbers they are being shown; hiding them would make the tool feel
-- like it was lying" -- and it applies to viewers too.
-- ---------------------------------------------------------------------
drop policy if exists project_cost_settings_select on ship.project_cost_settings;
drop policy if exists project_cost_settings_insert on ship.project_cost_settings;
drop policy if exists project_cost_settings_update on ship.project_cost_settings;
drop policy if exists project_cost_settings_delete on ship.project_cost_settings;

create policy project_cost_settings_select on ship.project_cost_settings
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy project_cost_settings_insert on ship.project_cost_settings
  for insert to authenticated
  with check (ship.can_edit_project(project_id));

create policy project_cost_settings_update on ship.project_cost_settings
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy project_cost_settings_delete on ship.project_cost_settings
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

drop policy if exists escalation_rate_overrides_select on ship.escalation_rate_overrides;
drop policy if exists escalation_rate_overrides_insert on ship.escalation_rate_overrides;
drop policy if exists escalation_rate_overrides_update on ship.escalation_rate_overrides;
drop policy if exists escalation_rate_overrides_delete on ship.escalation_rate_overrides;

create policy escalation_rate_overrides_select on ship.escalation_rate_overrides
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy escalation_rate_overrides_insert on ship.escalation_rate_overrides
  for insert to authenticated
  with check (ship.can_edit_project(project_id));

create policy escalation_rate_overrides_update on ship.escalation_rate_overrides
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy escalation_rate_overrides_delete on ship.escalation_rate_overrides
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

drop policy if exists project_energy_settings_select on ship.project_energy_settings;
drop policy if exists project_energy_settings_insert on ship.project_energy_settings;
drop policy if exists project_energy_settings_update on ship.project_energy_settings;
drop policy if exists project_energy_settings_delete on ship.project_energy_settings;

create policy project_energy_settings_select on ship.project_energy_settings
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy project_energy_settings_insert on ship.project_energy_settings
  for insert to authenticated
  with check (ship.can_edit_project(project_id));

create policy project_energy_settings_update on ship.project_energy_settings
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy project_energy_settings_delete on ship.project_energy_settings
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

-- ---------------------------------------------------------------------
-- project_taxonomy_values -- 0008's ">>> 0009 WIDENS THIS" marker.
-- Per-project vocabulary is project configuration, so it lands in the
-- same tier as the cost settings: everyone reads (you cannot fill in the
-- form without the vocabulary), admin+editor write.
-- ---------------------------------------------------------------------
drop policy if exists project_taxonomy_values_select on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_insert on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_update on ship.project_taxonomy_values;
drop policy if exists project_taxonomy_values_delete on ship.project_taxonomy_values;

create policy project_taxonomy_values_select on ship.project_taxonomy_values
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy project_taxonomy_values_insert on ship.project_taxonomy_values
  for insert to authenticated
  with check (ship.can_edit_project(project_id));

create policy project_taxonomy_values_update on ship.project_taxonomy_values
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy project_taxonomy_values_delete on ship.project_taxonomy_values
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

-- ---------------------------------------------------------------------
-- phase_templates / phase_template_steps -- 0007's
-- ">>> 0009 NARROWS THIS" marker.
--
-- `project_id is not null` is carried over from 0007 unchanged and for
-- 0007's reason: it is what stops anyone creating or converting a
-- template into a BUILT-IN, which would publish it to every user of the
-- database. Only the authority test changes, from member to editor.
-- ---------------------------------------------------------------------
drop policy if exists phase_templates_select on ship.phase_templates;
drop policy if exists phase_templates_write  on ship.phase_templates;
drop policy if exists phase_templates_insert on ship.phase_templates;
drop policy if exists phase_templates_update on ship.phase_templates;
drop policy if exists phase_templates_delete on ship.phase_templates;

create policy phase_templates_select on ship.phase_templates
  for select to authenticated
  using (
    (project_id is null and ship.is_active_user())
    or project_id in (select ship.my_project_ids())
  );

create policy phase_templates_insert on ship.phase_templates
  for insert to authenticated
  with check (project_id is not null and ship.can_edit_project(project_id));

create policy phase_templates_update on ship.phase_templates
  for update to authenticated
  using      (id in (select ship.my_editable_template_ids()))
  with check (project_id is not null
              and project_id in (select ship.my_editable_project_ids()));

create policy phase_templates_delete on ship.phase_templates
  for delete to authenticated
  using (id in (select ship.my_editable_template_ids()));

drop policy if exists phase_template_steps_select on ship.phase_template_steps;
drop policy if exists phase_template_steps_write  on ship.phase_template_steps;
drop policy if exists phase_template_steps_insert on ship.phase_template_steps;
drop policy if exists phase_template_steps_update on ship.phase_template_steps;
drop policy if exists phase_template_steps_delete on ship.phase_template_steps;

create policy phase_template_steps_select on ship.phase_template_steps
  for select to authenticated
  using (template_id in (select ship.my_readable_template_ids()));

create policy phase_template_steps_insert on ship.phase_template_steps
  for insert to authenticated
  with check (ship.can_edit_template(template_id));

create policy phase_template_steps_update on ship.phase_template_steps
  for update to authenticated
  using      (template_id in (select ship.my_editable_template_ids()))
  with check (template_id in (select ship.my_editable_template_ids()));

create policy phase_template_steps_delete on ship.phase_template_steps
  for delete to authenticated
  using (template_id in (select ship.my_editable_template_ids()));

-- ---------------------------------------------------------------------
-- chunk_phases -- the sub-task level from 0007, and the table the
-- Timeline tab drags. Read for everyone on the project, write for
-- admin+editor. This is the concrete meaning of "packages & schedule:
-- read" for a consultant.
-- ---------------------------------------------------------------------
drop policy if exists chunk_phases_select on ship.chunk_phases;
drop policy if exists chunk_phases_write  on ship.chunk_phases;
drop policy if exists chunk_phases_insert on ship.chunk_phases;
drop policy if exists chunk_phases_update on ship.chunk_phases;
drop policy if exists chunk_phases_delete on ship.chunk_phases;

create policy chunk_phases_select on ship.chunk_phases
  for select to authenticated
  using (chunk_project_id in (select ship.my_readable_chunk_ids()));

create policy chunk_phases_insert on ship.chunk_phases
  for insert to authenticated
  with check (ship.can_edit_chunk(chunk_project_id));

create policy chunk_phases_update on ship.chunk_phases
  for update to authenticated
  using      (chunk_project_id in (select ship.my_editable_chunk_ids()))
  with check (chunk_project_id in (select ship.my_editable_chunk_ids()));

create policy chunk_phases_delete on ship.chunk_phases
  for delete to authenticated
  using (chunk_project_id in (select ship.my_editable_chunk_ids()));

-- ---------------------------------------------------------------------
-- phase_dependencies
--
-- BOTH ENDPOINTS ARE CHECKED, not just the denormalised project_id --
-- 0007's reasoning, kept verbatim in effect: 0007's
-- sync_phase_dependency_project trigger already refuses cross-project
-- links, but a policy that trusted project_id alone would be relying on
-- a TRIGGER for a SECURITY boundary. The endpoint tests make the policy
-- self-sufficient.
--
-- The endpoint tests are the set-returning form
-- (my_editable_phase_ids()) rather than 0007's per-row
-- can_access_phase(), so a dependency-heavy schedule costs one InitPlan
-- instead of two function calls per edge.
-- ---------------------------------------------------------------------
drop policy if exists phase_dependencies_select on ship.phase_dependencies;
drop policy if exists phase_dependencies_write  on ship.phase_dependencies;
drop policy if exists phase_dependencies_insert on ship.phase_dependencies;
drop policy if exists phase_dependencies_update on ship.phase_dependencies;
drop policy if exists phase_dependencies_delete on ship.phase_dependencies;

create policy phase_dependencies_select on ship.phase_dependencies
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy phase_dependencies_insert on ship.phase_dependencies
  for insert to authenticated
  with check (
    ship.can_edit_project(project_id)
    and ship.can_edit_phase(predecessor_phase_id)
    and ship.can_edit_phase(successor_phase_id)
  );

create policy phase_dependencies_update on ship.phase_dependencies
  for update to authenticated
  using (
    project_id in (select ship.my_editable_project_ids())
    and predecessor_phase_id in (select ship.my_editable_phase_ids())
    and successor_phase_id   in (select ship.my_editable_phase_ids())
  )
  with check (
    project_id in (select ship.my_editable_project_ids())
    and predecessor_phase_id in (select ship.my_editable_phase_ids())
    and successor_phase_id   in (select ship.my_editable_phase_ids())
  );

create policy phase_dependencies_delete on ship.phase_dependencies
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

-- =====================================================================
-- SECTION 7 -- suggestions policies
--
-- Who sees what:
--   admin/editor -- every suggestion on their projects. This is the
--                   review queue.
--   consultant   -- their OWN suggestions, at any status. "Any status"
--                   is deliberate: a consultant who cannot see that
--                   their suggestion was rejected, and the reviewer note
--                   saying why, has been given a write-only feedback
--                   channel, which is worse than no feedback channel.
--                   They can only MODIFY their own while still pending.
--   viewer       -- nothing: they are in neither set and cannot create
--                   suggestions either.
--
-- INSERT forces three things in one predicate:
--   created_by_email = the caller  -- nobody files a suggestion under
--                                     somebody else's name.
--   status = 'pending'             -- with the column grant in section 5
--                                     this is belt and braces, and it is
--                                     the belt: a consultant cannot
--                                     insert a row that is already
--                                     'accepted' and then have
--                                     apply_suggestion refuse to touch
--                                     it while the UI shows it applied.
--   the target row is really in this project -- otherwise a consultant
--                                     could file a suggestion naming a
--                                     target_id from a project they
--                                     cannot see, and the reviewer's
--                                     screen would show them a foreign
--                                     row. apply_suggestion re-checks
--                                     this (section 8); this is the
--                                     outer of the two locks.
-- =====================================================================
drop policy if exists suggestions_select on ship.suggestions;
drop policy if exists suggestions_insert on ship.suggestions;
drop policy if exists suggestions_update on ship.suggestions;
drop policy if exists suggestions_delete on ship.suggestions;

create policy suggestions_select on ship.suggestions
  for select to authenticated
  using (
    project_id in (select ship.my_editable_project_ids())
    or (created_by_email = ship.current_email()
        and project_id in (select ship.my_project_ids()))
  );

create policy suggestions_insert on ship.suggestions
  for insert to authenticated
  with check (
    ship.can_contribute_project(project_id)
    and created_by_email = ship.current_email()
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and target_table = 'line_items'
    and ship.line_item_project_id(target_id) = project_id
  );

-- Only (patch, note) are updatable at all -- see the column grant in
-- section 5 -- so this policy governs which ROW may be re-drafted, and
-- the privilege system governs which COLUMNS. Re-drafting stops at
-- review: once a suggestion is accepted or rejected the record of what
-- was proposed must not be editable, or the audit trail is fiction.
create policy suggestions_update on ship.suggestions
  for update to authenticated
  using (
    created_by_email = ship.current_email()
    and status = 'pending'
    and project_id in (select ship.my_project_ids())
  )
  with check (
    created_by_email = ship.current_email()
    and status = 'pending'
    and project_id in (select ship.my_project_ids())
  );

-- An author may withdraw a pending suggestion; a reviewer may clear
-- anything off their project's queue.
create policy suggestions_delete on ship.suggestions
  for delete to authenticated
  using (
    project_id in (select ship.my_editable_project_ids())
    or (created_by_email = ship.current_email()
        and status = 'pending'
        and project_id in (select ship.my_project_ids()))
  );

-- =====================================================================
-- SECTION 8 -- ship.apply_suggestion() / ship.reject_suggestion()
--
-- WHY THESE LIVE IN `ship` AND NOT IN THE APP
-- --------------------------------------------
-- The client calls them over PostgREST (/rest/v1/rpc/apply_suggestion),
-- so the authorisation check below runs on every call by construction.
-- An equivalent implemented in a Next.js route handler would be one
-- forgotten `await requireEditor()` away from being an open endpoint,
-- and would additionally need the service-role key -- which bypasses RLS
-- entirely -- to do the write. Putting the logic here means the only
-- thing holding elevated privilege is 40 lines of SQL that cannot be
-- called without passing its own check.
--
-- These functions are SECURITY DEFINER: they run as the owner and
-- therefore BYPASS RLS on ship.suggestions and ship.line_items. Every
-- guard below is consequently load bearing. In particular the UPDATE's
-- `where id = ... and project_id = ...` is not belt-and-braces: with RLS
-- out of the picture it IS the tenant boundary, and target_id is
-- attacker-supplied.
-- =====================================================================

create or replace function ship.apply_suggestion(
  p_suggestion_id uuid,
  p_review_note   text default ''
)
returns ship.line_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sug      ship.suggestions;
  v_row      ship.line_items;
  v_patch    jsonb := '{}'::jsonb;
  v_key      text;
  v_reviewer text;
  v_allowed  text[] := ship.suggestable_line_item_columns();
begin
  v_reviewer := ship.current_email();
  if v_reviewer is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- LOCK FIRST, VALIDATE SECOND.
  -- `for update` is what makes a double-click idempotent: the second
  -- call blocks here until the first commits, then reads status =
  -- 'accepted' and is refused below. Without the lock both calls would
  -- read 'pending' and both would apply the patch -- twice.
  select * into v_sug
    from ship.suggestions s
   where s.id = p_suggestion_id
   for update;

  if not found then
    raise exception 'suggestion % not found', p_suggestion_id
      using errcode = 'P0002';
  end if;

  -- AUTHORISATION. RLS is bypassed in here, so this is the only thing
  -- standing between any authenticated caller and somebody else's data.
  if not ship.can_edit_project(v_sug.project_id) then
    raise exception 'not permitted to review suggestions on project %', v_sug.project_id
      using errcode = '42501';
  end if;

  if v_sug.status <> 'pending' then
    raise exception 'suggestion % is already %', p_suggestion_id, v_sug.status
      using errcode = '22023';
  end if;

  if v_sug.target_table <> 'line_items' then
    raise exception 'unsupported suggestion target_table %', v_sug.target_table
      using errcode = '22023';
  end if;

  -- COLUMN ALLOWLIST.
  -- The patch never chooses its own columns. Every key is tested against
  -- ship.suggestable_line_item_columns() and an unknown key ABORTS --
  -- it is not skipped. Skipping would mean the reviewer sees "applied"
  -- for a patch that was partly discarded, which is the worst outcome
  -- available: a silent, believed-successful partial write.
  -- (The static SET list below is the second, independent expression of
  -- the same allowlist. There is no dynamic SQL in this function at all.)
  for v_key in select jsonb_object_keys(v_sug.patch) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'suggestion patch may not modify ship.line_items.%', v_key
        using errcode = '42501';
    end if;
    v_patch := v_patch || jsonb_build_object(v_key, v_sug.patch -> v_key);
  end loop;

  -- THE TENANT BOUNDARY. target_id came from the client when the
  -- suggestion was filed; the `and li.project_id = v_sug.project_id` is
  -- what stops a crafted target_id from reaching a row in a project the
  -- author could not see. The suggestions INSERT policy checks the same
  -- thing at write time; this is the check that actually guards the
  -- write, because RLS is not helping in here.
  select * into v_row
    from ship.line_items li
   where li.id = v_sug.target_id
     and li.project_id = v_sug.project_id
   for update;

  if not found then
    raise exception 'suggestion % targets a row that is not in project %',
      p_suggestion_id, v_sug.project_id
      using errcode = 'P0002';
  end if;

  -- jsonb_populate_record, not per-key text assignment: it casts each
  -- value to the column's REAL type. potential_synergies comes back a
  -- text[], annual_energy_savings a numeric, and a patch carrying
  -- garbage for either fails HERE with a type error instead of being
  -- silently stringified into the table.
  v_row := jsonb_populate_record(v_row, v_patch);

  update ship.line_items li set
      name                                 = v_row.name,
      short_description                    = v_row.short_description,
      category                             = v_row.category,
      timeline_priority                    = v_row.timeline_priority,
      building_area_impacted               = v_row.building_area_impacted,
      building_level_impacted              = v_row.building_level_impacted,
      operational_impact                   = v_row.operational_impact,
      benefit_to_users                     = v_row.benefit_to_users,
      benefit_to_public                    = v_row.benefit_to_public,
      relative_first_cost                  = v_row.relative_first_cost,
      estimated_first_cost                 = v_row.estimated_first_cost,
      relative_operation_cost_impact       = v_row.relative_operation_cost_impact,
      relative_operational_energy_usage    = v_row.relative_operational_energy_usage,
      electrification_eo594                = v_row.electrification_eo594,
      addressing_resiliency_sustainability = v_row.addressing_resiliency_sustainability,
      addressing_deferred_maintenance      = v_row.addressing_deferred_maintenance,
      code_life_safety_improvement         = v_row.code_life_safety_improvement,
      accessibility_improvement            = v_row.accessibility_improvement,
      historic_impact                      = v_row.historic_impact,
      potential_synergies                  = v_row.potential_synergies,
      supporting_notes                     = v_row.supporting_notes,
      annual_energy_savings                = v_row.annual_energy_savings,
      annual_cost_savings                  = v_row.annual_cost_savings,
      energy_notes                         = v_row.energy_notes,
      updated_at                           = now()
   where li.id = v_sug.target_id
     and li.project_id = v_sug.project_id
  returning * into v_row;
  -- ecc_amount is NOT in that list on purpose: 0006's
  -- line_items_cc_sync_ecc trigger recomputes it from the (allowlisted)
  -- estimated_first_cost as part of this very statement, and 0008's
  -- line_items_dd_check_taxonomy trigger validates the four taxonomy
  -- columns against the project vocabulary. A suggestion proposing a
  -- value outside that vocabulary fails right here, loudly, which is
  -- correct -- it was never a valid edit.

  update ship.suggestions s set
      status      = 'accepted',
      reviewed_by = v_reviewer,
      reviewed_at = now(),
      review_note = coalesce(p_review_note, '')
   where s.id = p_suggestion_id;

  return v_row;
end;
$$;

comment on function ship.apply_suggestion(uuid, text) is
  'Reviewer accepts a suggestion: locks it, verifies the caller may edit the project, enforces the column allowlist, applies the patch to the target row scoped by (id, project_id), and flips status. SECURITY DEFINER -- its internal checks are the only authorisation there is.';

create or replace function ship.reject_suggestion(
  p_suggestion_id uuid,
  p_review_note   text default ''
)
returns ship.suggestions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sug      ship.suggestions;
  v_reviewer text;
begin
  v_reviewer := ship.current_email();
  if v_reviewer is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- Same lock-first discipline as apply_suggestion, for the same reason:
  -- two reviewers hitting Reject and Accept at the same moment must
  -- serialise, and the loser must be told the row already moved rather
  -- than silently overwriting the winner.
  select * into v_sug
    from ship.suggestions s
   where s.id = p_suggestion_id
   for update;

  if not found then
    raise exception 'suggestion % not found', p_suggestion_id
      using errcode = 'P0002';
  end if;

  if not ship.can_edit_project(v_sug.project_id) then
    raise exception 'not permitted to review suggestions on project %', v_sug.project_id
      using errcode = '42501';
  end if;

  if v_sug.status <> 'pending' then
    raise exception 'suggestion % is already %', p_suggestion_id, v_sug.status
      using errcode = '22023';
  end if;

  update ship.suggestions s set
      status      = 'rejected',
      reviewed_by = v_reviewer,
      reviewed_at = now(),
      review_note = coalesce(p_review_note, '')
   where s.id = p_suggestion_id
  returning * into v_sug;

  return v_sug;
end;
$$;

comment on function ship.reject_suggestion(uuid, text) is
  'Reviewer rejects a suggestion. Same lock and same authorisation check as ship.apply_suggestion(); writes no line item.';

revoke all on function ship.apply_suggestion(uuid, text)  from public;
revoke all on function ship.reject_suggestion(uuid, text) from public;

grant execute on function ship.apply_suggestion(uuid, text)  to authenticated;
grant execute on function ship.reject_suggestion(uuid, text) to authenticated;

commit;

-- =====================================================================
-- ROLLBACK
--
-- Order matters: policies first, then functions (Postgres refuses to
-- drop a function a policy still references -- which is the correct
-- order-of-operations guard, not an obstacle), then tables.
--
-- This block restores the 0002 / 0006 / 0007 / 0008 policies verbatim,
-- so the database ends up exactly where it was before 0009. It does NOT
-- restore data: dropping ship.project_roles discards every role anyone
-- has been granted, and dropping ship.suggestions discards the review
-- history. Both are recoverable only from a backup. If either matters,
-- copy them out first:
--   create table ship._project_roles_backup as select * from ship.project_roles;
--   create table ship._suggestions_backup   as select * from ship.suggestions;
--
-- begin;
--
-- -- 1. Drop every policy 0009 created.
-- drop policy if exists projects_select    on ship.projects;
-- drop policy if exists projects_insert    on ship.projects;
-- drop policy if exists projects_update    on ship.projects;
-- drop policy if exists projects_delete    on ship.projects;
-- drop policy if exists project_consultants_select on ship.project_consultants;
-- drop policy if exists project_consultants_insert on ship.project_consultants;
-- drop policy if exists project_consultants_update on ship.project_consultants;
-- drop policy if exists project_consultants_delete on ship.project_consultants;
-- drop policy if exists project_members_select on ship.project_members;
-- drop policy if exists project_members_insert on ship.project_members;
-- drop policy if exists project_members_update on ship.project_members;
-- drop policy if exists project_members_delete on ship.project_members;
-- drop policy if exists project_roles_select on ship.project_roles;
-- drop policy if exists project_roles_insert on ship.project_roles;
-- drop policy if exists project_roles_update on ship.project_roles;
-- drop policy if exists project_roles_delete on ship.project_roles;
-- drop policy if exists line_items_select on ship.line_items;
-- drop policy if exists line_items_insert on ship.line_items;
-- drop policy if exists line_items_update on ship.line_items;
-- drop policy if exists line_items_delete on ship.line_items;
-- drop policy if exists chunk_projects_select on ship.chunk_projects;
-- drop policy if exists chunk_projects_insert on ship.chunk_projects;
-- drop policy if exists chunk_projects_update on ship.chunk_projects;
-- drop policy if exists chunk_projects_delete on ship.chunk_projects;
-- drop policy if exists chunk_project_items_select on ship.chunk_project_items;
-- drop policy if exists chunk_project_items_insert on ship.chunk_project_items;
-- drop policy if exists chunk_project_items_update on ship.chunk_project_items;
-- drop policy if exists chunk_project_items_delete on ship.chunk_project_items;
-- drop policy if exists project_timeline_settings_select on ship.project_timeline_settings;
-- drop policy if exists project_timeline_settings_insert on ship.project_timeline_settings;
-- drop policy if exists project_timeline_settings_update on ship.project_timeline_settings;
-- drop policy if exists project_timeline_settings_delete on ship.project_timeline_settings;
-- drop policy if exists project_cost_settings_insert on ship.project_cost_settings;
-- drop policy if exists project_cost_settings_update on ship.project_cost_settings;
-- drop policy if exists project_cost_settings_delete on ship.project_cost_settings;
-- drop policy if exists project_cost_settings_select on ship.project_cost_settings;
-- drop policy if exists escalation_rate_overrides_select on ship.escalation_rate_overrides;
-- drop policy if exists escalation_rate_overrides_insert on ship.escalation_rate_overrides;
-- drop policy if exists escalation_rate_overrides_update on ship.escalation_rate_overrides;
-- drop policy if exists escalation_rate_overrides_delete on ship.escalation_rate_overrides;
-- drop policy if exists project_energy_settings_select on ship.project_energy_settings;
-- drop policy if exists project_energy_settings_insert on ship.project_energy_settings;
-- drop policy if exists project_energy_settings_update on ship.project_energy_settings;
-- drop policy if exists project_energy_settings_delete on ship.project_energy_settings;
-- drop policy if exists project_taxonomy_values_select on ship.project_taxonomy_values;
-- drop policy if exists project_taxonomy_values_insert on ship.project_taxonomy_values;
-- drop policy if exists project_taxonomy_values_update on ship.project_taxonomy_values;
-- drop policy if exists project_taxonomy_values_delete on ship.project_taxonomy_values;
-- drop policy if exists phase_templates_select on ship.phase_templates;
-- drop policy if exists phase_templates_insert on ship.phase_templates;
-- drop policy if exists phase_templates_update on ship.phase_templates;
-- drop policy if exists phase_templates_delete on ship.phase_templates;
-- drop policy if exists phase_template_steps_select on ship.phase_template_steps;
-- drop policy if exists phase_template_steps_insert on ship.phase_template_steps;
-- drop policy if exists phase_template_steps_update on ship.phase_template_steps;
-- drop policy if exists phase_template_steps_delete on ship.phase_template_steps;
-- drop policy if exists chunk_phases_select on ship.chunk_phases;
-- drop policy if exists chunk_phases_insert on ship.chunk_phases;
-- drop policy if exists chunk_phases_update on ship.chunk_phases;
-- drop policy if exists chunk_phases_delete on ship.chunk_phases;
-- drop policy if exists phase_dependencies_select on ship.phase_dependencies;
-- drop policy if exists phase_dependencies_insert on ship.phase_dependencies;
-- drop policy if exists phase_dependencies_update on ship.phase_dependencies;
-- drop policy if exists phase_dependencies_delete on ship.phase_dependencies;
-- drop policy if exists suggestions_select on ship.suggestions;
-- drop policy if exists suggestions_insert on ship.suggestions;
-- drop policy if exists suggestions_update on ship.suggestions;
-- drop policy if exists suggestions_delete on ship.suggestions;
--
-- -- 2. Restore ship.can_read_project() to its 0002 definition. This MUST
-- --    come before the project_role() drop below, and before the
-- --    re-created policies use it.
-- create or replace function ship.can_read_project(p_project_id text)
-- returns boolean language sql stable security definer set search_path = ''
-- as $fn$ select ship.is_admin() or ship.is_member(p_project_id) $fn$;
--
-- -- 3. Re-create the 0002 policies.
-- create policy projects_select on ship.projects
--   for select to authenticated using (ship.can_read_project(id));
-- create policy projects_admin_all on ship.projects
--   for all to authenticated using (ship.is_admin()) with check (ship.is_admin());
-- create policy project_consultants_select on ship.project_consultants
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy project_consultants_admin_all on ship.project_consultants
--   for all to authenticated using (ship.is_admin()) with check (ship.is_admin());
-- create policy project_members_select on ship.project_members
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy project_members_admin_all on ship.project_members
--   for all to authenticated using (ship.is_admin()) with check (ship.is_admin());
-- create policy line_items_select on ship.line_items
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy line_items_insert on ship.line_items
--   for insert to authenticated with check (
--     ship.can_read_project(project_id)
--     and (ship.is_admin() or user_email = ship.current_email()));
-- create policy line_items_update on ship.line_items
--   for update to authenticated
--   using (ship.is_admin() or (user_email = ship.current_email() and ship.is_member(project_id)))
--   with check (ship.can_read_project(project_id)
--     and (ship.is_admin() or user_email = ship.current_email()));
-- create policy line_items_delete on ship.line_items
--   for delete to authenticated
--   using (ship.is_admin() or (user_email = ship.current_email() and ship.is_member(project_id)));
-- create policy chunk_projects_select on ship.chunk_projects
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy chunk_projects_write on ship.chunk_projects
--   for all to authenticated using (ship.can_read_project(project_id))
--   with check (ship.can_read_project(project_id));
-- create policy chunk_project_items_select on ship.chunk_project_items
--   for select to authenticated using (ship.can_access_chunk(chunk_project_id));
-- create policy chunk_project_items_write on ship.chunk_project_items
--   for all to authenticated using (ship.can_access_chunk(chunk_project_id))
--   with check (ship.can_access_chunk(chunk_project_id));
-- create policy project_timeline_settings_select on ship.project_timeline_settings
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy project_timeline_settings_write on ship.project_timeline_settings
--   for all to authenticated using (ship.can_read_project(project_id))
--   with check (ship.can_read_project(project_id));
--
-- -- 4. Re-create the 0006 policies (x3 tables, identical shape).
-- create policy project_cost_settings_select on ship.project_cost_settings
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy project_cost_settings_insert on ship.project_cost_settings
--   for insert to authenticated with check (ship.is_admin());
-- create policy project_cost_settings_update on ship.project_cost_settings
--   for update to authenticated using (ship.is_admin()) with check (ship.is_admin());
-- create policy project_cost_settings_delete on ship.project_cost_settings
--   for delete to authenticated using (ship.is_admin());
-- create policy escalation_rate_overrides_select on ship.escalation_rate_overrides
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy escalation_rate_overrides_insert on ship.escalation_rate_overrides
--   for insert to authenticated with check (ship.is_admin());
-- create policy escalation_rate_overrides_update on ship.escalation_rate_overrides
--   for update to authenticated using (ship.is_admin()) with check (ship.is_admin());
-- create policy escalation_rate_overrides_delete on ship.escalation_rate_overrides
--   for delete to authenticated using (ship.is_admin());
-- create policy project_energy_settings_select on ship.project_energy_settings
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy project_energy_settings_insert on ship.project_energy_settings
--   for insert to authenticated with check (ship.is_admin());
-- create policy project_energy_settings_update on ship.project_energy_settings
--   for update to authenticated using (ship.is_admin()) with check (ship.is_admin());
-- create policy project_energy_settings_delete on ship.project_energy_settings
--   for delete to authenticated using (ship.is_admin());
--
-- -- 5. Re-create the 0007 policies.
-- create policy phase_templates_select on ship.phase_templates
--   for select to authenticated
--   using ((project_id is null and ship.is_active_user()) or ship.can_read_project(project_id));
-- create policy phase_templates_write on ship.phase_templates
--   for all to authenticated
--   using      (project_id is not null and ship.can_read_project(project_id))
--   with check (project_id is not null and ship.can_read_project(project_id));
-- create policy phase_template_steps_select on ship.phase_template_steps
--   for select to authenticated
--   using (exists (select 1 from ship.phase_templates t where t.id = template_id
--                   and ((t.project_id is null and ship.is_active_user())
--                        or ship.can_read_project(t.project_id))));
-- create policy phase_template_steps_write on ship.phase_template_steps
--   for all to authenticated
--   using (exists (select 1 from ship.phase_templates t where t.id = template_id
--                   and t.project_id is not null and ship.can_read_project(t.project_id)))
--   with check (exists (select 1 from ship.phase_templates t where t.id = template_id
--                   and t.project_id is not null and ship.can_read_project(t.project_id)));
-- create policy chunk_phases_select on ship.chunk_phases
--   for select to authenticated using (ship.can_access_chunk(chunk_project_id));
-- create policy chunk_phases_write on ship.chunk_phases
--   for all to authenticated using (ship.can_access_chunk(chunk_project_id))
--   with check (ship.can_access_chunk(chunk_project_id));
-- create policy phase_dependencies_select on ship.phase_dependencies
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy phase_dependencies_write on ship.phase_dependencies
--   for all to authenticated
--   using (ship.can_read_project(project_id)
--          and ship.can_access_phase(predecessor_phase_id)
--          and ship.can_access_phase(successor_phase_id))
--   with check (ship.can_read_project(project_id)
--          and ship.can_access_phase(predecessor_phase_id)
--          and ship.can_access_phase(successor_phase_id));
--
-- -- 6. Re-create the 0008 policies.
-- create policy project_taxonomy_values_select on ship.project_taxonomy_values
--   for select to authenticated using (ship.can_read_project(project_id));
-- create policy project_taxonomy_values_insert on ship.project_taxonomy_values
--   for insert to authenticated with check (ship.is_admin());
-- create policy project_taxonomy_values_update on ship.project_taxonomy_values
--   for update to authenticated using (ship.is_admin()) with check (ship.is_admin());
-- create policy project_taxonomy_values_delete on ship.project_taxonomy_values
--   for delete to authenticated using (ship.is_admin());
--
-- -- 7. Drop 0009's functions (no policy references them any more).
-- drop function if exists ship.apply_suggestion(uuid, text);
-- drop function if exists ship.reject_suggestion(uuid, text);
-- drop function if exists ship.suggestable_line_item_columns();
-- drop function if exists ship.line_item_project_id(uuid);
-- drop function if exists ship.can_edit_template(uuid);
-- drop function if exists ship.can_edit_phase(uuid);
-- drop function if exists ship.can_edit_chunk(uuid);
-- drop function if exists ship.my_editable_template_ids();
-- drop function if exists ship.my_readable_template_ids();
-- drop function if exists ship.my_editable_phase_ids();
-- drop function if exists ship.my_readable_phase_ids();
-- drop function if exists ship.my_editable_chunk_ids();
-- drop function if exists ship.my_readable_chunk_ids();
-- drop function if exists ship.my_contributor_project_ids();
-- drop function if exists ship.my_admin_project_ids();
-- drop function if exists ship.my_editable_project_ids();
-- drop function if exists ship.my_project_ids();
-- drop function if exists ship.can_contribute_project(text);
-- drop function if exists ship.can_edit_project(text);
-- drop function if exists ship.is_project_admin(text);
-- drop function if exists ship.project_role(text);
--
-- -- 8. Drop 0009's tables.
-- drop table if exists ship.suggestions;
-- drop table if exists ship.project_roles;
--
-- commit;
--
-- =====================================================================
-- HOW TO VERIFY
--
-- The SQL editor (and a superuser psql session) BYPASSES RLS entirely,
-- so a query that "works" there proves nothing about the policies. Every
-- check below must be run under impersonation:
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims =
--       '{"sub":"<auth.users id>","email":"<their email>","role":"authenticated"}';
--     ...
--   rollback;
--
-- Always `set local` inside begin/rollback so the identity cannot leak
-- into the next statement.
--
-- Locally: `npm run db:reset` applies migrations to an EMPTY database
-- and loads supabase/seeds/*.sql afterwards, so section 2's backfill
-- sees no rows. Re-run this file after the reset to exercise it against
-- the seeded data (it is re-runnable, and `on conflict do nothing` makes
-- the second pass a no-op):
--   MSYS_NO_PATHCONV=1 docker exec -i supabase_db_project-data-collection \
--     psql -U postgres -d postgres -f - < supabase/migrations/0009_ship_roles_and_suggestions.sql
-- Profiles are minted by ship.claim_invite() on first sign-in, so you
-- must call it under impersonation before any helper returns anything.
--
-- -- 1. The backfill did what section 2 says it did: every member is an
-- --    editor, every platform admin is a project admin, nobody is a
-- --    consultant or a viewer yet.
-- select role, count(*) from ship.project_roles group by role order by role;
--
-- -- 2. Nobody lost access. Expect 0 rows -- every project member still
-- --    resolves to a role that can write the schedule, which is what
-- --    they could do before this migration:
-- select m.project_id, m.email
--   from (select distinct project_id, email from ship.project_members) m
--   left join ship.project_roles r
--     on r.project_id = m.project_id and r.email = m.email
--  where coalesce(r.role, 'consultant') not in ('admin','editor');
--
-- -- 3. THE MATRIX. Run for one identity of each role on one project.
-- --    The four negative cases are the point; a "0 rows" UPDATE is a
-- --    pass, not a no-op.
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<viewer>","role":"authenticated"}';
--   select ship.project_role('<project>');                 -- viewer
--   select count(*) from ship.line_items;                  -- all of them: read is wide
--   update ship.line_items set name = 'x'
--    where item_number = '<one they OWN>';                 -- UPDATE 0  <- viewer is read-only
--   select count(*) from ship.project_members;             -- 0         <- members are invisible
-- rollback;
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<consultant>","role":"authenticated"}';
--   update ship.line_items set name = 'x' where item_number = '<theirs>';    -- UPDATE 1
--   update ship.line_items set name = 'x' where item_number = '<not theirs>';-- UPDATE 0
--   insert into ship.chunk_phases (chunk_project_id, name, kind, sort_order,
--                                  pct_of_tpc, start_slot, duration_slots)
--   select id, 'nope', 'construction', 99, 0, 0, 1
--     from ship.chunk_projects limit 1;
--   -- expected: ERROR 42501 new row violates row-level security policy
--   --           for table "chunk_phases"   <- the schedule is read-only
-- rollback;
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<editor>","role":"authenticated"}';
--   update ship.line_items set name = 'x' where item_number = '<not theirs>'; -- UPDATE 1
--   update ship.project_cost_settings set tpc_factor = 1.42;                  -- UPDATE 1
--   insert into ship.project_members (project_id, email, consultant_type)
--     values ('<project>','intruder@example.com','Civil');
--   -- expected: ERROR 42501  <- editors read members, they do not manage them
--   update ship.line_items set project_id = '<another project>'
--    where item_number = '<theirs>';
--   -- expected: ERROR 42501 new row violates row-level security policy
--   --           for table "line_items"   <- THE TRANSPLANT TEST. If this
--   --           succeeds, a WITH CHECK is missing and the tenant boundary
--   --           is gone.
-- rollback;
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<project admin>","role":"authenticated"}';
--   select ship.is_admin(),                                  -- f  <- NOT a platform admin
--          ship.is_project_admin('<project>');               -- t
--   insert into ship.project_roles (project_id, email, role)
--     values ('<a project they do NOT administer>','them@x.com','admin');
--   -- expected: ERROR 42501  <- no self-grant across projects
--   insert into ship.projects (id, name) values ('rogue','Rogue');
--   -- expected: ERROR 42501  <- project creation is PLATFORM admin only
-- rollback;
--
-- -- 4. THE SUGGESTION ROUND TRIP. Each step is a separate committed
-- --    transaction, since the reviewer must see what the author wrote.
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<consultant>","role":"authenticated"}';
--   insert into ship.suggestions (project_id, target_table, target_id, patch, note, created_by_email)
--   values ('<project>','line_items','<an item they do NOT own>',
--           '{"name":"better name","estimated_first_cost":"2.5m"}'::jsonb,
--           'why', ship.current_email());
-- commit;
--
-- begin;   -- the author cannot approve their own work, two different ways
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<consultant>","role":"authenticated"}';
--   select ship.apply_suggestion('<id>', 'self approved');
--   -- expected: ERROR 42501 not permitted to review suggestions on project ...
--   update ship.suggestions set status = 'accepted' where id = '<id>';
--   -- expected: ERROR permission denied for table suggestions
--   --           <- the COLUMN grant, not a policy. Stronger.
-- rollback;
--
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<editor or admin>","role":"authenticated"}';
--   select * from ship.apply_suggestion('<id>', 'Agreed.');
-- commit;
--
-- select item_number, name, estimated_first_cost, ecc_amount
--   from ship.line_items where id = '<target>';
-- -- expected: the patched name, and ecc_amount RECOMPUTED to 2500000 by
-- -- 0006's line_items_cc_sync_ecc trigger -- proof the patch went through
-- -- a real UPDATE and not a text splat.
--
-- begin;   -- the double-click test
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"...","email":"<editor or admin>","role":"authenticated"}';
--   select ship.apply_suggestion('<id>', 'again');
--   -- expected: ERROR 22023 suggestion <id> is already accepted
-- rollback;
--
-- -- 5. THE COLUMN ALLOWLIST. File a suggestion whose patch names
-- --    user_email or project_id, then try to apply it:
-- --    expected: ERROR 42501 suggestion patch may not modify
-- --              ship.line_items.user_email
-- --    and nothing is written -- the patch is all-or-nothing.
--
-- -- 6. THE PERFORMANCE CLAIM in header section 3. Under impersonation:
-- explain (analyze, costs off, timing off, summary off)
--   select id from ship.line_items where project_id = '<project>';
-- -- expected, and this is the shape to protect:
-- --   Index Scan using line_items_project_id_user_email_idx on line_items
-- --     Filter: (ANY (project_id = (hashed SubPlan 1).col1))
-- --     SubPlan 1
-- --       ->  ProjectSet (actual rows=1 loops=1)
-- -- "hashed SubPlan ... loops=1" is the InitPlan: the membership set was
-- -- built ONCE for the whole statement. If a future edit replaces the
-- -- set-returning helper with a boolean one, the predicate moves into the
-- -- Filter as `ship.can_read_project(project_id)` and is evaluated once
-- -- per row instead.
-- =====================================================================
