-- =====================================================================
-- 0034_item_org_is_submitters_firm.sql
-- SHIP -- an item filed for another discipline carries the SUBMITTER's
-- firm, and keeps it when the roster is saved.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0033. Adds one column, replaces two
-- functions, backfills the items 0033 labelled 'Unknown Organization'.
--
-- WHY
-- ---
-- The client, after 0033 went live:
--   "I added several envelope items and they weren't automatically
--    assigned to FAA like the architectural ones were ... would be nice
--    to know who put the items in."
-- The owner: admins "can pick any infra like architecture or envelope ...
-- but still uses the same org".
--
-- 0033 gave such an item the roster's firm for the PICKED discipline, and
-- 'Unknown Organization' when that discipline had none -- so an FAA user
-- (on the roster under Architecture) filing Envelope items on a project
-- with no Envelope firm got 'Unknown Organization' on every one.
--
-- THE CHANGES
-- -----------
--   * normalize_line_item(): an item filed by someone who is not a member
--     of its discipline, but is a member of another one on this project,
--     takes that firm (theirs). Members filing under their own discipline,
--     and submitters with no membership at all (service imports, platform
--     admins off the roster), are unchanged.
--   * line_items.org_discipline records WHICH roster entry the firm came
--     from in that case. NULL means "the item's own discipline", i.e. every
--     item before this migration.
--   * sync_item_organization() (0027) follows org_discipline when set. It
--     has to: update_project() saves the roster by deleting and re-inserting
--     every row, consultants before members, so the sync can't look the
--     submitter's membership up at that moment. Without the column, the
--     next roster save would put Envelope's firm (or 'Unknown
--     Organization') back on the FAA items. With it, renaming the
--     Architecture firm still reaches them.
--   * guard_line_item_system_columns() (0029): a client may not write
--     org_discipline, exactly like company_name.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The column.
-- ---------------------------------------------------------------------
alter table ship.line_items
  add column if not exists org_discipline text;

comment on column ship.line_items.org_discipline is
  'The roster discipline whose organization company_name follows (0034). NULL: the item''s own discipline. Set by normalize_line_item() when the submitter filed for a discipline they are not a member of.';

-- ---------------------------------------------------------------------
-- 2. Guard: 0029's body, plus org_discipline treated like company_name.
-- ---------------------------------------------------------------------
create or replace function ship.guard_line_item_system_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_privileged  boolean;
  v_renumbering boolean;
begin
  -- No JWT at all (migrations, seeds, psql, a server process using the
  -- service role) is trusted, as is an active platform admin.
  v_privileged  := auth.uid() is null or ship.is_admin();
  -- Only ship.renumber_line_items() / ship.reorder_line_items() (0029)
  -- turn this on, transaction-locally, and off again. See 0029's header.
  v_renumbering := coalesce(current_setting('ship.renumbering', true), '') = 'on';

  if tg_op = 'INSERT' then
    if not v_privileged then
      new.item_number    := '';     -- 0003 fill_item_number assigns it
      new.company_name   := '';     -- 0003 normalize_line_item derives it
      new.org_discipline := null;   -- 0034 normalize_line_item derives it
      new.created_at     := now();
      new.sort_order     := null;   -- 0029 line_items_ab_sort_order: last
    end if;
    return new;
  end if;

  -- UPDATE.
  -- project_id: nobody. Package links, numbering and every RLS decision
  -- hang off it.
  if new.project_id is distinct from old.project_id then
    raise exception 'project_id can''t be changed'
      using errcode = '42501',
            hint = 'A line item belongs to the project it was created in. Create it again in the other project instead.';
  end if;

  if v_privileged then
    return new;
  end if;

  if new.item_number is distinct from old.item_number and not v_renumbering then
    raise exception 'item_number can''t be changed'
      using errcode = '42501',
            hint = 'Numbers follow the order of the items. Reorder them instead.';
  end if;
  if new.sort_order is distinct from old.sort_order and not v_renumbering then
    raise exception 'sort_order can''t be changed'
      using errcode = '42501',
            hint = 'Use ship.reorder_line_items().';
  end if;
  if new.company_name is distinct from old.company_name
     and coalesce(current_setting('ship.syncing_org', true), '') <> 'on' then
    raise exception 'company_name can''t be changed' using errcode = '42501';
  end if;
  if new.org_discipline is distinct from old.org_discipline then
    raise exception 'org_discipline can''t be changed' using errcode = '42501';
  end if;
  if new.consultant_type is distinct from old.consultant_type then
    raise exception 'consultant_type can''t be changed' using errcode = '42501';
  end if;
  if new.discipline is distinct from old.discipline then
    raise exception 'discipline can''t be changed' using errcode = '42501';
  end if;
  -- normalize lower-cases/trims user_email after this trigger; compare
  -- the normalised form so resending the same address in another case is
  -- not reported as a change.
  if lower(btrim(coalesce(new.user_email, ''))) is distinct from old.user_email then
    raise exception 'user_email can''t be changed' using errcode = '42501';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at can''t be changed' using errcode = '42501';
  end if;
  -- ecc_amount is recomputed from estimated_first_cost by
  -- line_items_cc_sync_ecc on every write anyway; a client that sends a
  -- different value is told so rather than silently overwritten.
  if new.ecc_amount is distinct from old.ecc_amount then
    raise exception 'ecc_amount can''t be changed'
      using errcode = '42501',
            hint = 'ecc_amount is derived from estimated_first_cost. Change that instead.';
  end if;

  return new;
end;
$$;

revoke all on function ship.guard_line_item_system_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Organization lookup: 0033's body; only the company_name block
--    differs (new step 2).
-- ---------------------------------------------------------------------
create or replace function ship.normalize_line_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original_type text;
  v_org           text;
  v_org_disc      text;
  v_roster_name   text;
begin
  new.consultant_type := ship.canonical_discipline(new.consultant_type);
  if new.discipline is not null then
    new.discipline := ship.canonical_discipline(new.discipline);
  end if;

  v_original_type := new.consultant_type;

  -- normalizeLineItem(): 'Admin' is not a real discipline.
  if lower(new.consultant_type) = 'admin' then
    v_original_type     := 'Admin';
    new.consultant_type := 'Architecture';
  end if;

  -- Fill discipline from consultant_type when the client left it blank.
  -- The numbering trigger reads this column, which is exactly why the
  -- trigger names are ordered the way they are (see 0003).
  if new.discipline is null or new.discipline = '' then
    new.discipline := new.consultant_type;
  end if;

  if lower(new.discipline) = 'admin' then
    new.discipline := 'Architecture';
  end if;

  -- A custom discipline takes the spelling it has on this project (the
  -- roster first, else the name its prefix was allocated under), so
  -- "acoustics" files, numbers and resolves its org as "Acoustics".
  if ship.builtin_discipline_prefix(new.discipline) is null then
    select pc.consultant_type into v_roster_name
      from ship.project_consultants pc
     where pc.project_id = new.project_id
       and lower(pc.consultant_type) = lower(new.discipline)
     limit 1;
    if v_roster_name is null then
      select dp.discipline into v_roster_name
        from ship.project_discipline_prefixes dp
       where dp.project_id = new.project_id
         and dp.discipline_key = lower(new.discipline);
    end if;
    new.discipline := coalesce(v_roster_name, new.discipline);
  end if;
  if ship.builtin_discipline_prefix(new.consultant_type) is null then
    v_roster_name := null;
    select pc.consultant_type into v_roster_name
      from ship.project_consultants pc
     where pc.project_id = new.project_id
       and lower(pc.consultant_type) = lower(new.consultant_type)
     limit 1;
    new.consultant_type := coalesce(v_roster_name, new.consultant_type);
  end if;

  new.user_email          := lower(btrim(coalesce(new.user_email, '')));
  new.estimated_first_cost := coalesce(new.estimated_first_cost, '');
  new.potential_synergies  := coalesce(new.potential_synergies, '{}'::text[]);

  if new.company_name is null or btrim(new.company_name) = '' then
    if v_original_type = 'Admin' then
      new.company_name := 'FAA';
    else
      -- 1. the org for THIS discipline that this email belongs to
      select pc.org_name
        into v_org
        from ship.project_consultants pc
        join ship.project_members pm
          on pm.project_id = pc.project_id
         and pm.consultant_type = pc.consultant_type
       where pc.project_id = new.project_id
         and pc.consultant_type = new.discipline
         and pm.email = new.user_email
       limit 1;

      -- 2. (0034) the submitter's own firm: they filed for a discipline
      --    they are not a member of (an admin or FAA user picking it in
      --    the form). The item remembers which roster entry that was, so
      --    0027's sync keeps following it.
      if coalesce(v_org, '') = '' then
        select btrim(pc.org_name), pc.consultant_type
          into v_org, v_org_disc
          from ship.project_members pm
          join ship.project_consultants pc
            on pc.project_id = pm.project_id
           and pc.consultant_type = pm.consultant_type
         where pm.project_id = new.project_id
           and pm.email = new.user_email
           and lower(pm.consultant_type) <> lower(new.discipline)
           and btrim(coalesce(pc.org_name, '')) <> ''
         order by pc.consultant_type
         limit 1;
        if coalesce(v_org, '') <> '' then
          new.org_discipline := v_org_disc;
        end if;
      end if;

      -- 3. (0033) the roster's organization for this discipline -- a
      --    submitter with no firm on this project (a service import, a
      --    platform admin off the roster).
      if coalesce(v_org, '') = '' then
        select coalesce(nullif(btrim(pc.org_name), ''), 'Unknown Organization')
          into v_org
          from ship.project_consultants pc
         where pc.project_id = new.project_id
           and lower(pc.consultant_type) = lower(new.discipline)
         limit 1;
      end if;

      -- 4. fallback: the TS literal
      new.company_name := coalesce(nullif(v_org, ''), 'Unknown Organization');
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;

  return new;
end;
$$;

revoke all on function ship.normalize_line_item() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. The sync: 0027's body, keyed on org_discipline when it is set.
-- ---------------------------------------------------------------------
create or replace function ship.sync_item_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org text := coalesce(nullif(btrim(new.org_name), ''), 'Unknown Organization');
begin
  perform set_config('ship.syncing_org', 'on', true);
  update ship.line_items li
     set company_name = v_org
   where li.project_id = new.project_id
     and lower(coalesce(li.org_discipline, li.discipline)) = lower(new.consultant_type)
     and li.company_name is distinct from v_org;
  perform set_config('ship.syncing_org', 'off', true);
  return null;
end;
$$;

revoke all on function ship.sync_item_organization() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Backfill: the items 0033 left 'Unknown Organization' although their
--    submitter has a firm on the project. Items that already carry a
--    real organization are left alone -- that label was chosen on
--    purpose (e.g. example data entered on a discipline firm's behalf).
-- ---------------------------------------------------------------------
with fix as (
  select li.id, f.org_name, f.consultant_type
    from ship.line_items li
    cross join lateral (
      select btrim(pc.org_name) as org_name, pc.consultant_type
        from ship.project_members pm
        join ship.project_consultants pc
          on pc.project_id = pm.project_id
         and pc.consultant_type = pm.consultant_type
       where pm.project_id = li.project_id
         and pm.email = li.user_email
         and lower(pm.consultant_type) <> lower(li.discipline)
         and btrim(coalesce(pc.org_name, '')) <> ''
       order by pc.consultant_type
       limit 1
    ) f
   where li.company_name = 'Unknown Organization'
     and li.org_discipline is null
     and not exists (
       select 1 from ship.project_members pm
        where pm.project_id = li.project_id
          and pm.email = li.user_email
          and lower(pm.consultant_type) = lower(li.discipline)
     )
)
update ship.line_items li
   set company_name   = fix.org_name,
       org_discipline = fix.consultant_type
  from fix
 where li.id = fix.id;
