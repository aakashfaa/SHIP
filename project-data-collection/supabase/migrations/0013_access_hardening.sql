-- =====================================================================
-- 0013_access_hardening.sql
-- SHIP -- who may change a project's roster, who gets in, and how a
-- removed member actually loses access.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0012: everything in `ship`, no extensions,
-- no trigger on auth.users, one transaction. Additive only -- 0001-0012
-- are never edited; anything they defined that changes here is
-- redefined here in full.
--
-- WHAT THIS FIXES (pre-launch audit master IDs)
-- ---------------------------------------------
-- M-04  Removing someone from the roster did not revoke access.
--       update_project() rebuilt project_members but never touched
--       project_roles, and project_role() reads project_roles FIRST. So a
--       viewer/editor/consultant dropped in Settings kept reading (and
--       writing) the project. update_project() now deletes the
--       project_roles row of every email that WAS on the roster and no
--       longer is. Explicit grants for people who were never on the
--       roster (an editor or project admin added directly to
--       project_roles) are deliberately kept: the roster is the list of
--       consultant firms, and dropping a firm is not a statement about
--       the client's own staff.
--
-- M-15  Settings is shown to project admins (project_role = 'admin',
--       spec R5.1 "members: CRUD"), but update_project() checked
--       ship.is_admin() -- PLATFORM admin -- so every project-admin save
--       failed. Per decision D-8 it now allows platform admin OR
--       project_role(p_project_id) = 'admin'. A project admin can rename
--       THEIR project and edit its roster; nothing else.
--
--       Also: pending_invites.role is what claim_invite() stamps onto
--       ship.profiles.role, i.e. it is the PLATFORM-admin bit. Until now
--       anything that could write an invite row could mint a platform
--       admin. A trigger now refuses an admin invite unless the inviter
--       (invited_by) is an active platform admin, and pending_invites
--       gains a nullable project_id recording which project an invite
--       came from (informational; membership still lives in
--       project_members).
--
-- M-16  claim_invite() granted a profile to whoever authenticated first
--       with an invited address. With email confirmation off that was
--       anyone who typed the address into sign-up. It now requires
--       auth.users.email_confirmed_at, i.e. proof of mailbox control.
--       It is also safe to call twice concurrently (first sign-in fires
--       it from more than one place): the profile insert is
--       ON CONFLICT DO NOTHING followed by a re-read, so the loser gets
--       the winner's profile instead of a raw 23505.
--
-- D-7   ship.project_access_notices: when an invite is for an address
--       that ALREADY has an account, the server mails a plain "you've
--       been added to <Project>" link (no token) and records a notice
--       here. The app shows it as a toast on next sign-in and marks it
--       seen. The server (service role) writes; a user can only read and
--       mark-seen their own.
--
-- ALSO
-- ----
-- * update_project() takes p_expected_updated_at (default null). When
--   given, the save is refused with 40001 if projects.updated_at moved
--   since the caller loaded it -- two admins editing Settings at once no
--   longer silently drop each other's roster changes. Compared at
--   millisecond precision because the value round-trips through a JS
--   Date, which cannot hold Postgres's microseconds.
-- * A consultant entry whose `emails` is null or not an array is treated
--   as no emails instead of crashing the save with "cannot extract
--   elements from a scalar".
-- * service_role gets USAGE on `ship` plus the table access the invite
--   route needs. Without it every service-role call into `ship`
--   (the invite route's pending_invites upsert) failed with
--   "permission denied for schema ship". service_role is the server-only
--   key; it never reaches a browser, and every route using it does its
--   own authorisation (lib/supabase/admin.ts).
--
-- CONTRACT (other workstreams code against these exact signatures)
--   ship.update_project(p_project_id text, p_name text,
--                       p_consultants jsonb default '[]',
--                       p_expected_updated_at timestamptz default null)
--     returns jsonb { project_id, invited_emails }
--   ship.claim_invite() returns ship.profiles
--     raises 42501 with HINT 'email_not_confirmed' for an unconfirmed
--     address, 42501 'not on the SHIP invite list' for an uninvited one.
--   ship.project_access_notices(id uuid pk, email text, project_id text,
--                               created_at timestamptz, seen_at timestamptz)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. service_role access to the schema.
-- ---------------------------------------------------------------------
grant usage on schema ship to service_role;
grant select on all tables in schema ship to service_role;

-- ---------------------------------------------------------------------
-- 2. pending_invites: project scoping + platform-admin minting guard.
-- ---------------------------------------------------------------------
alter table ship.pending_invites
  add column if not exists project_id text
    references ship.projects(id) on delete set null;

create index if not exists pending_invites_project_id_idx
  on ship.pending_invites (project_id);

comment on column ship.pending_invites.project_id is
  'The project this invite was sent from, when it came from a project roster. Informational: access is granted by project_members / project_roles, not by this column. NULL for platform-level invites.';

comment on column ship.pending_invites.role is
  'The PLATFORM role claim_invite() stamps onto ship.profiles. ''admin'' = platform admin. Only an active platform admin may create or raise an invite to ''admin'' (see ship.guard_pending_invite_role).';

grant insert, update, delete on ship.pending_invites to service_role;

-- True when p_uid is an active PLATFORM admin. Internal helper for the
-- trigger below; not exposed to clients.
create or replace function ship.uid_is_platform_admin(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from ship.profiles p
     where p.id = p_uid and p.is_active and p.role = 'admin'
  )
$$;

revoke all on function ship.uid_is_platform_admin(uuid) from public, anon, authenticated;

-- invited_by IS NULL means "written by SQL / a seed / a server process
-- with no signed-in user", which is trusted. Anything carrying a user id
-- is held to that user's platform role:
--   * INSERT role='admin' by a non-platform-admin          -> refused
--   * UPDATE raising role to 'admin' by a non-platform-admin -> refused
--   * UPDATE lowering an existing 'admin' invite by a non-platform-admin
--     -> the old role is silently kept. This is the "project admin
--     re-invites someone who happens to be a platform admin" case: the
--     route forces role='consultant' for project admins, and an upsert
--     must not demote the platform admin as a side effect.
create or replace function ship.guard_pending_invite_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trusted boolean;
begin
  v_trusted := new.invited_by is null or ship.uid_is_platform_admin(new.invited_by);

  if v_trusted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'admin' then
      raise exception 'pending_invites: only a platform admin can invite a platform admin'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.role is distinct from old.role then
    if new.role = 'admin' then
      raise exception 'pending_invites: only a platform admin can invite a platform admin'
        using errcode = '42501';
    end if;
    new.role := old.role;
  end if;

  return new;
end;
$$;

revoke all on function ship.guard_pending_invite_role() from public, anon, authenticated;

drop trigger if exists pending_invites_guard_role on ship.pending_invites;
create trigger pending_invites_guard_role
  before insert or update on ship.pending_invites
  for each row execute function ship.guard_pending_invite_role();

-- ---------------------------------------------------------------------
-- 3. project_access_notices (D-7).
-- ---------------------------------------------------------------------
create table if not exists ship.project_access_notices (
  id         uuid primary key default gen_random_uuid(),
  email      text not null check (email = lower(email) and email <> ''),
  project_id text not null references ship.projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  seen_at    timestamptz
);

comment on table ship.project_access_notices is
  'One row per "you were added to <project>" event for a person who already had an account (decision D-7). Written by the server with the service role; the recipient reads it and sets seen_at. No token or link lives here.';

create index if not exists project_access_notices_email_unseen_idx
  on ship.project_access_notices (email) where seen_at is null;

alter table ship.project_access_notices enable row level security;

-- New tables inherit the default ACL, which in this database grants
-- anon/authenticated everything. Start from nothing, then grant narrowly.
revoke all on ship.project_access_notices from public, anon, authenticated;

grant select on ship.project_access_notices to authenticated;
grant update (seen_at) on ship.project_access_notices to authenticated;
grant select, insert, update, delete on ship.project_access_notices to service_role;

drop policy if exists project_access_notices_select_own on ship.project_access_notices;
create policy project_access_notices_select_own
  on ship.project_access_notices
  for select to authenticated
  using (email = ship.current_email());

drop policy if exists project_access_notices_update_own on ship.project_access_notices;
create policy project_access_notices_update_own
  on ship.project_access_notices
  for update to authenticated
  using (email = ship.current_email())
  with check (email = ship.current_email());

-- No INSERT/DELETE policy for authenticated: only the service role
-- (which bypasses RLS) creates notices.

-- ---------------------------------------------------------------------
-- 4. update_project() -- D-8 authority, M-04 revocation, stale-write
--    guard. The old 3-argument version is dropped, not overloaded: with
--    a defaulted 4th argument, a 3-named-argument RPC call would match
--    both and fail as ambiguous.
-- ---------------------------------------------------------------------
drop function if exists ship.update_project(text, text, jsonb);
drop function if exists ship.update_project(text, text, jsonb, timestamptz);

create or replace function ship.update_project(
  p_project_id          text,
  p_name                text,
  p_consultants         jsonb default '[]'::jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller      text := ship.current_email();
  v_current_ts  timestamptz;
  v_consultants jsonb := coalesce(p_consultants, '[]'::jsonb);
  v_old_roster  text[];
  v_new_roster  text[];
  v_invited     text[];
begin
  if not (ship.is_admin() or ship.is_project_admin(p_project_id)) then
    raise exception 'ship.update_project: you must be an admin of project % to change it', p_project_id
      using errcode = '42501';
  end if;

  if jsonb_typeof(v_consultants) <> 'array' then
    raise exception 'ship.update_project: p_consultants must be a JSON array'
      using errcode = '22023';
  end if;

  -- Lock the project row first: two concurrent saves serialise here, and
  -- the stale check below sees the winner's updated_at.
  select p.updated_at into v_current_ts
    from ship.projects p
   where p.id = p_project_id
     for update;

  if not found then
    raise exception 'ship.update_project: no such project %', p_project_id
      using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null
     and date_trunc('milliseconds', v_current_ts)
         <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'ship.update_project: this project was changed by someone else since you opened it'
      using errcode = '40001',
            hint = 'Reload the settings and re-apply your changes.';
  end if;

  update ship.projects
     set name       = coalesce(nullif(btrim(p_name), ''), name),
         updated_at = now()
   where id = p_project_id;

  -- Who was on the roster BEFORE this save. Used for M-04 below.
  select coalesce(array_agg(distinct pm.email), '{}'::text[])
    into v_old_roster
    from ship.project_members pm
   where pm.project_id = p_project_id;

  -- Whole-array replace, as before.
  delete from ship.project_consultants where project_id = p_project_id;
  delete from ship.project_members     where project_id = p_project_id;

  insert into ship.project_consultants (project_id, consultant_type, org_name)
  select p_project_id,
         c ->> 'type',
         coalesce(c ->> 'orgName', '')
    from jsonb_array_elements(v_consultants) as c
   where coalesce(c ->> 'type', '') <> ''
  on conflict (project_id, consultant_type)
    do update set org_name = excluded.org_name;

  -- A null / non-array `emails` is "no emails", not a crash.
  insert into ship.project_members (project_id, email, consultant_type)
  select distinct
         p_project_id,
         lower(btrim(e.value #>> '{}')),
         c ->> 'type'
    from jsonb_array_elements(v_consultants) as c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c -> 'emails') = 'array' then c -> 'emails' else '[]'::jsonb end
    ) as e
   where coalesce(c ->> 'type', '') <> ''
     and jsonb_typeof(e.value) = 'string'
     and btrim(coalesce(e.value #>> '{}', '')) <> ''
  on conflict do nothing;

  select coalesce(array_agg(distinct pm.email), '{}'::text[])
    into v_new_roster
    from ship.project_members pm
   where pm.project_id = p_project_id;

  -- M-04: revoke the explicit role of everyone who was dropped from the
  -- roster. Only emails that WERE on the roster are touched, so grants
  -- made outside the roster survive. The caller's own row is never
  -- removed here, so a project admin cannot lock themselves out of the
  -- project with a Settings save.
  delete from ship.project_roles r
   where r.project_id = p_project_id
     and r.email = any (v_old_roster)
     and not (r.email = any (v_new_roster))
     and r.email is distinct from v_caller;

  -- Allowlist the new roster. Inlined rather than calling
  -- ensure_invites(), which is platform-admin-only. Always role
  -- 'consultant' -- a roster save can never mint a platform admin -- and
  -- ON CONFLICT DO NOTHING so an existing invite (including an admin one)
  -- keeps its role. RETURNING yields only rows genuinely inserted, which
  -- is the exact set the caller should mail (see 0004's quota note).
  with inserted as (
    insert into ship.pending_invites (email, name, role, invited_by, project_id)
    select e,
           initcap(regexp_replace(split_part(e, '@', 1), '[._-]+', ' ', 'g')),
           'consultant',
           auth.uid(),
           p_project_id
      from unnest(v_new_roster) as e
    on conflict (email) do nothing
    returning email
  )
  select coalesce(array_agg(distinct i.email), '{}'::text[])
    into v_invited
    from inserted i;

  return jsonb_build_object(
    'project_id',     p_project_id,
    'invited_emails', to_jsonb(coalesce(v_invited, '{}'::text[]))
  );
end;
$$;

revoke all on function ship.update_project(text, text, jsonb, timestamptz) from public, anon;
grant execute on function ship.update_project(text, text, jsonb, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 5. claim_invite() -- confirmed email required; concurrency-safe.
-- ---------------------------------------------------------------------
create or replace function ship.claim_invite()
returns ship.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid;
  v_email     text;
  v_confirmed timestamptz;
  v_invite    ship.pending_invites;
  v_profile   ship.profiles;
begin
  v_uid   := auth.uid();
  v_email := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));

  if v_uid is null or v_email is null then
    raise exception 'ship.claim_invite: no authenticated user'
      using errcode = '42501';
  end if;

  -- Already a SHIP user: idempotent, return the profile.
  select * into v_profile from ship.profiles p where p.id = v_uid;
  if found then
    return v_profile;
  end if;

  -- Proof of mailbox control. Read from auth.users (not the JWT) so a
  -- token minted before confirmation cannot be replayed afterwards to
  -- skip it, and vice versa.
  select u.email_confirmed_at into v_confirmed
    from auth.users u
   where u.id = v_uid;

  if v_confirmed is null then
    raise exception 'ship.claim_invite: confirm your email address before joining SHIP'
      using errcode = '42501',
            hint = 'email_not_confirmed';
  end if;

  select * into v_invite
    from ship.pending_invites pi
   where pi.email = v_email
     for update;

  if not found then
    raise exception 'ship.claim_invite: % is not on the SHIP invite list', v_email
      using errcode = '42501';
  end if;

  -- Two concurrent first-sign-in calls both get past the `found` check
  -- above; the FOR UPDATE on the invite serialises them, and the loser's
  -- insert is a no-op instead of a 23505.
  insert into ship.profiles (id, email, name, role)
  values (
    v_uid,
    v_email,
    coalesce(
      nullif(btrim(v_invite.name), ''),
      initcap(regexp_replace(split_part(v_email, '@', 1), '[._-]+', ' ', 'g'))
    ),
    coalesce(v_invite.role, 'consultant')
  )
  on conflict do nothing;

  select * into v_profile from ship.profiles p where p.id = v_uid;

  if not found then
    -- The only way to get here is a profile that already holds this
    -- email under a DIFFERENT auth user id.
    raise exception 'ship.claim_invite: another SHIP account already uses %', v_email
      using errcode = '23505';
  end if;

  update ship.pending_invites
     set accepted_at = coalesce(accepted_at, now())
   where email = v_email;

  return v_profile;
end;
$$;

revoke all on function ship.claim_invite() from public, anon;
grant execute on function ship.claim_invite() to authenticated;

commit;
