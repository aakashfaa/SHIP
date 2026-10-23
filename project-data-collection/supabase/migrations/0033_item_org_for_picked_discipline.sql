-- =====================================================================
-- 0033_item_org_for_picked_discipline.sql
-- SHIP -- a line item filed for another discipline takes that
-- discipline's organization.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0032. Replaces one function; no data change.
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
-- THE CHANGE
-- ----------
-- normalize_line_item() is 0022's body with one new step between the old
-- steps 1 and 2: the roster's organization for the item's discipline --
-- the same rule 0027's sync applies whenever the roster is saved. Nothing
-- else differs.
-- =====================================================================

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

      -- 3. fallback: any consultant row on this project for that email
      if coalesce(v_org, '') = '' then
        select pc.org_name
          into v_org
          from ship.project_consultants pc
          join ship.project_members pm
            on pm.project_id = pc.project_id
           and pm.consultant_type = pc.consultant_type
         where pc.project_id = new.project_id
           and pm.email = new.user_email
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
