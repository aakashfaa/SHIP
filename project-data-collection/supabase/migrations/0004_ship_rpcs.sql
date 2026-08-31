-- =====================================================================
-- 0004_ship_rpcs.sql
-- SHIP -- the four RPCs that replace the multi-step writes in
-- lib/store.ts, plus the invite gate.
--
--   ship.ensure_invites(text[], text)   <- ensureConsultantUsers()
--   ship.create_project(text, jsonb)    <- createProject()
--   ship.update_project(text,text,jsonb)<- updateProject() / SettingsTab
--   ship.claim_invite()                 <- the signup gate (new)
--
-- WHO WAS NEWLY INVITED IS A FACT THE DATABASE REPORTS.
-- ensure_invites() returns the emails whose pending_invites row it
-- actually created, and create/update_project pass that straight back to
-- the client as `invited_emails`. The client must NOT re-derive it from
-- the project's member list: /api/admin/invite calls
-- auth.admin.inviteUserByEmail() per address, and this Supabase project
-- shares its ~2-4 emails/hour project-wide mailer quota with an unrelated
-- production app. Re-mailing every existing member on every Save would
-- starve that app's password resets.
--
-- All four are SECURITY DEFINER with `set search_path = ''` (see the
-- long note at the top of 0002 for why the empty search_path is not
-- optional), and all four gate on ship.is_admin() -- except
-- claim_invite(), which is what a brand-new user calls before they have
-- any role at all.
--
-- Because they are SECURITY DEFINER they run as the owner and bypass RLS,
-- so the admin check inside each function IS the authorisation. Do not
-- add a new function to this file without one.
--
-- Re-runnable: every function is `create or replace`, and the three whose
-- return type is part of their contract (ensure_invites, create_project,
-- update_project) are preceded by an explicit
-- `drop function if exists ... (<exact arg list>)`. Postgres refuses to
-- change a function's return type in place ("cannot change return type of
-- existing function"), so the drop is what makes this file replayable over
-- an older deployment of itself.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- ship.slugify(text)
-- Exact port of slugify() at lib/store.ts:19-26, including the
-- `slugify(name) || 'new-project'` fallback at line 118. Note it does NOT
-- strip leading/trailing hyphens -- matching the TS, because the slug is
-- a stored primary key and quietly changing the rule would orphan URLs.
--
-- Internal: revoked from public and NOT granted to authenticated.
-- create_project() calls it as the definer.
-- ---------------------------------------------------------------------
create or replace function ship.slugify(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(btrim(coalesce(p_value, ''))), '[^a-z0-9[:space:]-]', '', 'g'),
          '[[:space:]]+', '-', 'g'),
        '-+', '-', 'g'),
      ''),
    'new-project')
$$;

revoke all on function ship.slugify(text) from public;

-- ---------------------------------------------------------------------
-- ship.ensure_invites(p_emails text[], p_role text default 'consultant')
--
-- 1:1 replacement for ensureConsultantUsers() (lib/store.ts:83-110).
-- The TS version invented a localStorage user with a default password;
-- this version adds the email to the allowlist and stops there. No
-- password is ever created or stored -- the real auth.users row is
-- created by Supabase self-signup, and ship.claim_invite() then turns it
-- into a SHIP user.
--
-- `on conflict do nothing` means an existing invite keeps its original
-- role, so re-running create/update_project can never demote an admin.
--
-- Returns the emails of the invites it ACTUALLY CREATED, as text[].
-- The mechanism is `insert ... on conflict (email) do nothing returning
-- email`: RETURNING only yields rows that were genuinely inserted, so an
-- address that was already invited conflicts, is skipped, and is
-- correctly absent from the result. That array is what the caller feeds
-- to the invite mailer -- see the quota note at the top of this file.
-- An empty array (every address already known) is the normal, expected
-- result of re-saving an unchanged project, and means "send no email".
-- ---------------------------------------------------------------------
drop function if exists ship.ensure_invites(text[], text);

create or replace function ship.ensure_invites(
  p_emails text[],
  p_role   text default 'consultant'
)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created text[];
begin
  if not ship.is_admin() then
    raise exception 'ship.ensure_invites: admin role required'
      using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('admin', 'consultant') then
    raise exception 'ship.ensure_invites: invalid role %', p_role
      using errcode = '22023';
  end if;

  with cleaned as (
    select distinct lower(btrim(e)) as email
      from unnest(coalesce(p_emails, '{}'::text[])) as e
     where btrim(coalesce(e, '')) <> ''
  ),
  inserted as (
    insert into ship.pending_invites (email, name, role, invited_by)
    select c.email,
           -- "jane.doe@x.com" -> "Jane Doe", as the TS did
           initcap(regexp_replace(split_part(c.email, '@', 1), '[._-]+', ' ', 'g')),
           p_role,
           auth.uid()
      from cleaned c
    on conflict (email) do nothing
    returning email
  )
  select coalesce(array_agg(i.email), '{}'::text[])
    into v_created
    from inserted i;

  return coalesce(v_created, '{}'::text[]);
end;
$$;

-- ---------------------------------------------------------------------
-- ship.create_project(p_name text, p_consultants jsonb) returns jsonb
--
-- p_consultants is the ProjectConsultant[] the form already builds:
--   [{"type":"Mechanical","orgName":"Atlas MEP","emails":["a@b.com"]}]
--
-- Returns exactly:
--   { "project_id": "some-slug", "invited_emails": ["a@b.com"] }
--
-- project_id is the FINAL slug, which may differ from slugify(p_name) if
-- it collided -- the caller should route to that, not to its own guess.
-- invited_emails is only the addresses ensure_invites() newly created a
-- row for, never the whole member list; it is the exact set the caller
-- should mail. It is `[]` when everyone was already invited.
--
-- Everything below happens in the caller's transaction, so a failure
-- anywhere leaves no half-built project. That is the main thing this
-- buys over the four sequential client-side writes it replaces.
-- ---------------------------------------------------------------------
drop function if exists ship.create_project(text, jsonb);

create or replace function ship.create_project(
  p_name        text,
  p_consultants jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base     text;
  v_slug     text;
  v_n        integer := 1;
  v_emails   text[];
  v_invited  text[] := '{}'::text[];
  v_distinct text[];
begin
  if not ship.is_admin() then
    raise exception 'ship.create_project: admin role required'
      using errcode = '42501';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'ship.create_project: name is required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_consultants, '[]'::jsonb)) <> 'array' then
    raise exception 'ship.create_project: p_consultants must be a JSON array'
      using errcode = '22023';
  end if;

  v_base := ship.slugify(p_name);
  v_slug := v_base;

  -- Slug collision retry: 'boston-library-renovation', then '-2', '-3'...
  -- A `select ... where not exists` pre-check would be a race; letting
  -- the unique index reject the insert and retrying is not.
  loop
    begin
      insert into ship.projects (id, name, created_by)
      values (v_slug, btrim(p_name), auth.uid());
      exit;
    exception when unique_violation then
      v_n := v_n + 1;
      if v_n > 500 then
        raise exception 'ship.create_project: could not allocate a unique slug for %', p_name
          using errcode = '55000';
      end if;
      v_slug := v_base || '-' || v_n::text;
    end;
  end loop;

  insert into ship.project_consultants (project_id, consultant_type, org_name)
  select v_slug,
         c ->> 'type',
         coalesce(c ->> 'orgName', '')
    from jsonb_array_elements(coalesce(p_consultants, '[]'::jsonb)) as c
   where coalesce(c ->> 'type', '') <> ''
  on conflict (project_id, consultant_type)
    do update set org_name = excluded.org_name;

  -- One row per (email, consultant_type). This is both the consultant's
  -- email list AND the RLS membership grant.
  insert into ship.project_members (project_id, email, consultant_type)
  select distinct
         v_slug,
         lower(btrim(e.value #>> '{}')),
         c ->> 'type'
    from jsonb_array_elements(coalesce(p_consultants, '[]'::jsonb)) as c
    cross join lateral jsonb_array_elements(coalesce(c -> 'emails', '[]'::jsonb)) as e
   where coalesce(c ->> 'type', '') <> ''
     and btrim(coalesce(e.value #>> '{}', '')) <> ''
  on conflict do nothing;

  select coalesce(array_agg(distinct pm.email), '{}'::text[])
    into v_emails
    from ship.project_members pm
   where pm.project_id = v_slug;

  -- Accumulate rather than assign: every ensure_invites() call in this
  -- function contributes to the one `invited_emails` array we hand back,
  -- so adding a second call later cannot silently drop the first's result.
  v_invited := v_invited
            || coalesce(ship.ensure_invites(v_emails, 'consultant'), '{}'::text[]);

  -- Seed the per-project singletons so the first chunk is PP10 and the
  -- Timeline tab has settings to read. See the counter-semantics note in
  -- 0003: next_value is the NEXT number, so the default of 10 is exactly
  -- right here and must NOT be pre-decremented.
  insert into ship.chunk_number_counters (project_id)
  values (v_slug)
  on conflict (project_id) do nothing;

  insert into ship.project_timeline_settings (project_id)
  values (v_slug)
  on conflict (project_id) do nothing;

  -- Collapse the accumulator to one distinct array. array_agg over an
  -- empty input is NULL, hence the coalesce -- `invited_emails` must be
  -- `[]`, never `null`, so the client can trust `.length`.
  select coalesce(array_agg(distinct e), '{}'::text[])
    into v_distinct
    from unnest(v_invited) as e;

  return jsonb_build_object(
    'project_id',     v_slug,
    'invited_emails', to_jsonb(v_distinct)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- ship.update_project(p_project_id text, p_name text, p_consultants jsonb)
--
-- Mirrors SettingsTab's whole-array replace semantics: the client sends
-- the complete consultant list and it becomes the truth. The delete and
-- the re-insert are in one transaction, so there is no window where a
-- consultant loses access to a project mid-save.
--
-- Removing a consultant here does NOT delete their line items --
-- line_items.user_email has no FK by design. They stop being able to read
-- the project; the data stays.
--
-- Returns exactly:
--   { "project_id": "some-slug", "invited_emails": ["a@b.com"] }
--
-- invited_emails is the addresses this call newly added to the allowlist,
-- NOT the project's members. Pressing Save on an unchanged Settings tab
-- must yield `[]` and send zero mail -- that is the whole point of this
-- return shape. See the mailer-quota note at the top of the file.
-- ---------------------------------------------------------------------
drop function if exists ship.update_project(text, text, jsonb);

create or replace function ship.update_project(
  p_project_id  text,
  p_name        text,
  p_consultants jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emails   text[];
  v_invited  text[] := '{}'::text[];
  v_distinct text[];
begin
  if not ship.is_admin() then
    raise exception 'ship.update_project: admin role required'
      using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_consultants, '[]'::jsonb)) <> 'array' then
    raise exception 'ship.update_project: p_consultants must be a JSON array'
      using errcode = '22023';
  end if;

  update ship.projects
     set name       = coalesce(nullif(btrim(p_name), ''), name),
         updated_at = now()
   where id = p_project_id;

  -- FOUND is set by the UPDATE above; a missing project must not silently
  -- succeed and then wipe nothing.
  if not found then
    raise exception 'ship.update_project: no such project %', p_project_id
      using errcode = 'P0002';
  end if;

  -- Whole-array replace.
  delete from ship.project_consultants where project_id = p_project_id;
  delete from ship.project_members     where project_id = p_project_id;

  insert into ship.project_consultants (project_id, consultant_type, org_name)
  select p_project_id,
         c ->> 'type',
         coalesce(c ->> 'orgName', '')
    from jsonb_array_elements(coalesce(p_consultants, '[]'::jsonb)) as c
   where coalesce(c ->> 'type', '') <> ''
  on conflict (project_id, consultant_type)
    do update set org_name = excluded.org_name;

  insert into ship.project_members (project_id, email, consultant_type)
  select distinct
         p_project_id,
         lower(btrim(e.value #>> '{}')),
         c ->> 'type'
    from jsonb_array_elements(coalesce(p_consultants, '[]'::jsonb)) as c
    cross join lateral jsonb_array_elements(coalesce(c -> 'emails', '[]'::jsonb)) as e
   where coalesce(c ->> 'type', '') <> ''
     and btrim(coalesce(e.value #>> '{}', '')) <> ''
  on conflict do nothing;

  select coalesce(array_agg(distinct pm.email), '{}'::text[])
    into v_emails
    from ship.project_members pm
   where pm.project_id = p_project_id;

  -- Accumulate rather than assign -- see the matching note in
  -- create_project(). Note the delete-and-reinsert above does NOT touch
  -- ship.pending_invites, so a member removed and re-added later still
  -- conflicts here and is correctly NOT re-mailed.
  v_invited := v_invited
            || coalesce(ship.ensure_invites(v_emails, 'consultant'), '{}'::text[]);

  select coalesce(array_agg(distinct e), '{}'::text[])
    into v_distinct
    from unnest(v_invited) as e;

  return jsonb_build_object(
    'project_id',     p_project_id,
    'invited_emails', to_jsonb(v_distinct)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- ship.claim_invite() returns ship.profiles
--
-- THE GATE. This is the only way a ship.profiles row is ever created --
-- there is deliberately no trigger on auth.users (see 0001), because such
-- a trigger would run inside the OTHER project's signup transaction on
-- this shared database.
--
-- The client calls this once, right after sign-in:
--   const { data, error } = await supabase.rpc('claim_invite')
--   if (error) -> the user authenticated but is not a SHIP user; sign
--                 them out and show "you have not been invited".
--
-- A user of the other project who signs in has no pending_invites row,
-- gets 42501 here, gets no profile, and therefore -- via every RLS
-- helper in 0002 -- sees exactly nothing.
--
-- Idempotent: calling it again just returns the existing profile.
-- ---------------------------------------------------------------------
create or replace function ship.claim_invite()
returns ship.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid;
  v_email   text;
  v_invite  ship.pending_invites;
  v_profile ship.profiles;
begin
  v_uid   := auth.uid();
  v_email := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));

  if v_uid is null or v_email is null then
    raise exception 'ship.claim_invite: no authenticated user'
      using errcode = '42501';
  end if;

  select * into v_profile from ship.profiles p where p.id = v_uid;
  if found then
    return v_profile;
  end if;

  select * into v_invite
    from ship.pending_invites pi
   where pi.email = v_email
     for update;

  if not found then
    raise exception 'ship.claim_invite: % is not on the SHIP invite list', v_email
      using errcode = '42501';
  end if;

  insert into ship.profiles (id, email, name, role)
  values (
    v_uid,
    v_email,
    coalesce(
      nullif(btrim(v_invite.name), ''),
      -- default: the email local-part, tidied
      initcap(regexp_replace(split_part(v_email, '@', 1), '[._-]+', ' ', 'g'))
    ),
    coalesce(v_invite.role, 'consultant')
  )
  returning * into v_profile;

  update ship.pending_invites
     set accepted_at = coalesce(accepted_at, now())
   where email = v_email;

  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges
-- Postgres grants EXECUTE to PUBLIC by default, which would expose these
-- to `anon` as well. Revoke first, then grant narrowly.
-- ---------------------------------------------------------------------
revoke all on function ship.ensure_invites(text[], text)       from public;
revoke all on function ship.create_project(text, jsonb)        from public;
revoke all on function ship.update_project(text, text, jsonb)  from public;
revoke all on function ship.claim_invite()                     from public;

grant execute on function ship.ensure_invites(text[], text)      to authenticated;
grant execute on function ship.create_project(text, jsonb)       to authenticated;
grant execute on function ship.update_project(text, text, jsonb) to authenticated;
grant execute on function ship.claim_invite()                    to authenticated;

commit;
