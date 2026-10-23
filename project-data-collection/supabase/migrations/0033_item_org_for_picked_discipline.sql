-- =====================================================================
-- 0033_item_org_for_picked_discipline.sql
-- SHIP -- a line item filed for another discipline takes that
-- discipline's organization.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0032. Replaces two functions, adds one helper; no data change.
--
-- WHY
-- ---
-- The owner:
--   "let the admins, basically all people with the faainc.com email, also
--    add data on their end from other disciplines so have them pick a
--    discipline in the form they fill for line items"
--
-- The form now lets them pick (lib/line-item-discipline.ts). The insert
-- itself already accepted any discipline on the project's roster, but
-- normalize_line_item() looked the organization up through the
-- SUBMITTER's membership: an FAA admin is not a member of Mechanical, so
-- step 1 missed, and step 2 ("any roster row for that email") would have
-- labelled a Mechanical item with the admin's own firm, or with
-- 'Unknown Organization'.
--
-- THE CHANGES
-- -----------
-- The form offers every built-in discipline (those always had a number
-- prefix) plus an "Other" box. So:
--
--   * fill_item_number() allocates a prefix for a typed discipline that
--     is new to the project -- for admins and @faainc.com users only
--     (ship.may_file_any_discipline); anyone else is still refused.
--   * normalize_line_item() no longer falls back to the submitter's own
--     firm; a discipline with no firm on the roster reads
--     'Unknown Organization' until one is added.
--
-- And, as below:
-- normalize_line_item() is 0022's body with one new step between the old
-- steps 1 and 2: the roster's organization for the item's discipline --
-- the same rule 0027's sync applies whenever the roster is saved. Nothing
-- else differs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Organization lookup.
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

      -- 2. (0033) the roster's organization for this discipline -- an
      --    admin filing an item for another discipline is not a member of
      --    it, and 0027 points every item at the roster's org anyway.
      if coalesce(v_org, '') = '' then
        select coalesce(nullif(btrim(pc.org_name), ''), 'Unknown Organization')
          into v_org
          from ship.project_consultants pc
         where pc.project_id = new.project_id
           and lower(pc.consultant_type) = lower(new.discipline)
         limit 1;
      end if;

      -- (0033) The old "any roster row for this email" fallback is gone:
      -- it put the submitter's own firm on an item they filed for a
      -- discipline that has no firm on this project yet. Such an item reads
      -- 'Unknown Organization' until the discipline is added to the roster,
      -- when 0027's sync points it at the new firm.

      -- 3. fallback: the TS literal
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
-- 2. Who may file under any discipline: project admins (platform admins
--    are 'admin' on every project) and @faainc.com users who may add
--    items here. Server processes with no JWT are trusted.
--    Mirrors lib/line-item-discipline.ts canPickDiscipline().
-- ---------------------------------------------------------------------
create or replace function ship.may_file_any_discipline(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is null
      or ship.project_role(p_project_id) = 'admin'
      or (ship.can_contribute_project(p_project_id)
          and lower(ship.current_email()) like '%@faainc.com')
$$;

revoke all on function ship.may_file_any_discipline(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Numbering: 0022's body, plus the allocation above.
-- ---------------------------------------------------------------------
create or replace function ship.fill_item_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_discipline text;
  v_prefix     text;
  v_next       integer;
  v_candidate  text;
  v_tries      integer := 0;
begin
  -- Respect an explicitly supplied number (seed fixtures, platform
  -- admin). Non-admin inserts arrive here with it blanked by
  -- line_items_a0_guard_system_columns.
  if new.item_number is not null and new.item_number <> '' then
    return new;
  end if;

  v_discipline := coalesce(nullif(ship.canonical_discipline(new.discipline), ''), 'Admin');
  v_prefix     := ship.project_discipline_prefix(new.project_id, v_discipline);

  -- (0033) A discipline nobody on the project has yet -- typed into the
  -- form's "Other" box -- gets its prefix here, but only for the people
  -- the form offers that box to: project admins and FAA staff.
  if v_prefix is null and ship.may_file_any_discipline(new.project_id) then
    v_prefix := ship.allocate_discipline_prefix(new.project_id, v_discipline);
  end if;

  if v_prefix is null then
    raise exception 'discipline "%" is not on this project''s roster', v_discipline
      using errcode = '22023',
            hint = 'Add the discipline to the project in Settings first.';
  end if;

  -- One counter per discipline: a custom one is keyed on the name its
  -- prefix was allocated under, so case variants share it.
  if ship.builtin_discipline_prefix(v_discipline) is null then
    select dp.discipline into v_discipline
      from ship.project_discipline_prefixes dp
     where dp.project_id = new.project_id
       and dp.discipline_key = lower(v_discipline);
  end if;

  loop
    -- One statement, one row lock -> concurrent inserts serialise and
    -- each receives a distinct counter value (see 0003's header).
    insert into ship.item_number_counters as c (project_id, discipline, next_value)
    values (new.project_id, v_discipline, 2)
    on conflict (project_id, discipline)
      do update set next_value = c.next_value + 1
    returning c.next_value - 1 into v_next;

    v_candidate := v_prefix || v_next::text;

    -- Skip a number already taken by a hand-set / imported row (0014).
    exit when not exists (
      select 1 from ship.line_items li
       where li.project_id = new.project_id
         and li.item_number = v_candidate
    );

    v_tries := v_tries + 1;
    if v_tries > 10000 then
      raise exception 'fill_item_number: no free item number for % in project %', v_discipline, new.project_id
        using errcode = '55000';
    end if;
  end loop;

  new.item_number := v_candidate;
  return new;
end;
$$;

revoke all on function ship.fill_item_number() from public, anon, authenticated;
