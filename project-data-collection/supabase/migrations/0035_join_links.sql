-- =====================================================================
-- 0035_join_links.sql
--
-- 1. ship.join_links: per-person join links an admin copies from Settings
--    and sends by hand (Teams, their own email) when our invite email
--    doesn't arrive or a mail scanner burns its one-time link.
--
--    One row per link. The link carries a random token; only its SHA-256
--    hash is stored, so a database read never yields a usable link.
--    A link:
--      * belongs to ONE email on ONE project's roster,
--      * expires 14 days after it is made,
--      * works once (used_at), and
--      * is revoked when the admin copies a fresh one for the same person.
--    Opening the link does nothing; only submitting the join form uses it,
--    so a scanner that pre-fetches URLs can't burn it.
--
--    Only the service role touches this table (app/api/admin/join-link and
--    app/api/join). RLS is on with no policies: clients see nothing.
--
-- 2. ship.claim_invite(): open sign-up (owner decision 2026-11-24). A
--    confirmed user who is NOT on pending_invites now gets a plain
--    'consultant' profile instead of error 42501. Project access is still
--    granted only by project_members / project_roles, so a self-signed-up
--    user sees no projects until an admin adds them. Invited users are
--    unchanged: their invite's name and role still apply.
--
-- 3. ship.profiles.password_set_at: when this person first set or used a
--    password they chose. Null + an auth account tagged
--    user_metadata.ship_invite = true means SHIP created the account and its
--    owner never chose a password (typically a mail scanner opened the invite
--    link and confirmed the account before the person did). The app then
--    treats them as "needs password": a join link, a Resend from Settings,
--    and Forgot password all offer "choose a password" instead of "sign in"
--    (app/api/join, app/api/admin/invite, app/api/auth/forgot).
--
--    Stamped by ship.mark_password_set() (set-password page, join link,
--    password sign-in), by claim_invite for accounts that already show
--    evidence, and backfilled below from ship.password_evidence_at().
--
-- Re-runnable.
-- =====================================================================

create table if not exists ship.join_links (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null references ship.projects(id) on delete cascade,
  email       text not null check (email = lower(btrim(email)) and email <> ''),
  token_hash  text not null unique,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  used_at     timestamptz,
  revoked_at  timestamptz
);

create index if not exists join_links_project_email_idx
  on ship.join_links (project_id, email);

-- At most one live (unrevoked) link per person per project, so two admins
-- clicking "Copy join link" at the same moment can't both mint a working
-- link (app/api/admin/join-link revokes, then inserts; the loser's insert
-- fails and they try again).
create unique index if not exists join_links_one_live_per_person
  on ship.join_links (project_id, email)
  where revoked_at is null;

comment on table ship.join_links is
  'Per-person join links copied from Settings > Consultants. Token stored as SHA-256 hex; single use; 14-day expiry; a newer link for the same (project, email) revokes older ones. Service role only.';

alter table ship.join_links enable row level security;
revoke all on ship.join_links from public, anon, authenticated;
grant select, insert, update, delete on ship.join_links to service_role;

-- ---------------------------------------------------------------------
-- password_set_at + evidence + mark_password_set
-- ---------------------------------------------------------------------
alter table ship.profiles add column if not exists password_set_at timestamptz;

comment on column ship.profiles.password_set_at is
  'When this person first set or used a password they chose. Null on a ship_invite-tagged account = "needs password" (see 0035).';

-- The earliest evidence that the owner of auth user p_uid chose a password:
--   * auth.audit_log_entries: user_updated_password, or a login whose traits
--     name a provider (GoTrue logs the password grant as
--     {"action":"login","traits":{"provider":"email"}}; a verified email link
--     logs "login" with no traits). Hosted projects may keep this table
--     empty (audit events go to the log stream instead), hence:
--   * auth.mfa_amr_claims: a session whose sign-in method was 'password'.
--   * an account NOT tagged user_metadata.ship_invite: created with a
--     password (sign-up page, seed users) or owned by the other app that
--     shares auth.users. Never "needs password" either way.
-- Null when there is no evidence. Reads auth.*: definer callers only.
create or replace function ship.password_evidence_at(p_uid uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select least(
    (select min(a.created_at)
       from auth.audit_log_entries a
      where a.payload ->> 'actor_id' = p_uid::text
        and (a.payload ->> 'action' = 'user_updated_password'
             or (a.payload ->> 'action' = 'login'
                 and (a.payload -> 'traits' ->> 'provider') in ('email', 'phone')))),
    (select min(c.created_at)
       from auth.mfa_amr_claims c
       join auth.sessions s on s.id = c.session_id
      where s.user_id = p_uid
        and c.authentication_method = 'password'),
    (select u.created_at
       from auth.users u
      where u.id = p_uid
        and coalesce(u.raw_user_meta_data ->> 'ship_invite', '') <> 'true')
  );
$$;

revoke all on function ship.password_evidence_at(uuid) from public, anon, authenticated;

-- Called by the app after the signed-in user set or used a password.
-- Keeps the FIRST time. Returns false when the caller has no profile yet.
create or replace function ship.mark_password_set()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ship.mark_password_set: no authenticated user'
      using errcode = '42501';
  end if;
  update ship.profiles
     set password_set_at = coalesce(password_set_at, now())
   where id = v_uid;
  return found;
end;
$$;

revoke all on function ship.mark_password_set() from public, anon;
grant execute on function ship.mark_password_set() to authenticated;

-- app/api/join stamps it with the service role right after setting the
-- password, so a failed sign-in afterwards can't leave them "needs password".
grant update (password_set_at) on ship.profiles to service_role;

-- Backfill. Idempotent: only fills nulls, from evidence computed in SQL.
update ship.profiles p
   set password_set_at = ev.at
  from (select pr.id, ship.password_evidence_at(pr.id) as at
          from ship.profiles pr
         where pr.password_set_at is null) ev
 where ev.id = p.id
   and ev.at is not null;

-- ---------------------------------------------------------------------
-- claim_invite: same as 0013 except the "not on the invite list" branch,
-- which now creates a consultant profile, and a new profile starts with
-- password_set_at from ship.password_evidence_at().
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
  v_invited   boolean;
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

  -- Proof of mailbox control (or of an admin-issued join link, which
  -- confirms the account server-side). Read from auth.users, not the JWT.
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
  v_invited := found;

  -- Not invited: open sign-up. A plain consultant with no projects.
  -- Two concurrent first-sign-in calls race on the insert below; the
  -- loser's insert is a no-op.
  insert into ship.profiles (id, email, name, role, password_set_at)
  values (
    v_uid,
    v_email,
    coalesce(
      case when v_invited then nullif(btrim(v_invite.name), '') end,
      initcap(regexp_replace(split_part(v_email, '@', 1), '[._-]+', ' ', 'g'))
    ),
    case when v_invited then coalesce(v_invite.role, 'consultant') else 'consultant' end,
    ship.password_evidence_at(v_uid)
  )
  on conflict do nothing;

  select * into v_profile from ship.profiles p where p.id = v_uid;

  if not found then
    -- The only way to get here is a profile that already holds this
    -- email under a DIFFERENT auth user id.
    raise exception 'ship.claim_invite: another SHIP account already uses %', v_email
      using errcode = '23505';
  end if;

  if v_invited then
    update ship.pending_invites
       set accepted_at = coalesce(accepted_at, now())
     where email = v_email;
  end if;

  return v_profile;
end;
$$;

-- CREATE OR REPLACE keeps the 0013 grants; restated so this file alone is
-- enough on a database that skipped a step.
revoke all on function ship.claim_invite() from public, anon;
grant execute on function ship.claim_invite() to authenticated;

notify pgrst, 'reload schema';
