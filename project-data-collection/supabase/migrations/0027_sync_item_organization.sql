-- =====================================================================
-- 0027_sync_item_organization.sql
-- SHIP -- a line item's Organization follows the project roster.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0026. Additive; nothing earlier is edited.
--
-- THE BUG
-- -------
-- line_items.company_name is a copy, written once by normalize_line_item()
-- when the item is created (the roster org for the item's discipline, else
-- 'Unknown Organization'). Editing the organization in Settings only
-- changed project_consultants.org_name, so Master View and the exports kept
-- showing the old value: an Architecture roster entry renamed to "FAA" still
-- showed "Unknown Organization" on every item.
--
-- THE FIX
-- -------
-- An AFTER INSERT OR UPDATE OF org_name trigger on project_consultants
-- re-points the items of that discipline at the roster's organization. It
-- fires on INSERT as well because update_project() saves the roster by
-- deleting and re-inserting every row, so there is never an UPDATE to see.
-- A blank organization maps to 'Unknown Organization', exactly what
-- normalize_line_item() writes for a roster entry with no organization.
--
-- Only rows whose value actually differs are written, so saving a roster
-- that changed nothing touches no line item (and does not bump updated_at).
-- Items entered as 'Admin' are stored under Architecture (see
-- normalize_line_item) and follow Architecture's organization too.
--
-- A one-off backfill below applies the same rule to every existing item.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The guard (0003 / 0013 / 0014 lineage) refuses a non-platform-admin's
--    change to company_name -- correct for a contributor editing an item,
--    but it would also fail a project admin's roster save, because the
--    sync below runs as that user. The only change here: company_name may
--    change while the transaction-local flag ship.syncing_org is 'on',
--    which only sync_item_organization() sets (and clears again in the
--    same statement). Everything else in the function is unchanged.
-- ---------------------------------------------------------------------
create or replace function ship.guard_line_item_system_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_privileged boolean;
begin
  -- No JWT at all (migrations, seeds, psql, a server process using the
  -- service role) is trusted, as is an active platform admin.
  v_privileged := auth.uid() is null or ship.is_admin();

  if tg_op = 'INSERT' then
    if not v_privileged then
      new.item_number  := '';     -- 0003 fill_item_number assigns it
      new.company_name := '';     -- 0003 normalize_line_item derives it
      new.created_at   := now();
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

  if new.item_number is distinct from old.item_number then
    raise exception 'item_number can''t be changed' using errcode = '42501';
  end if;
  if new.company_name is distinct from old.company_name
     and coalesce(current_setting('ship.syncing_org', true), '') <> 'on' then
    raise exception 'company_name can''t be changed' using errcode = '42501';
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

-- ---------------------------------------------------------------------
-- 2. The sync.
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
     and lower(li.discipline) = lower(new.consultant_type)
     and li.company_name is distinct from v_org;
  perform set_config('ship.syncing_org', 'off', true);
  return null;
end;
$$;

revoke all on function ship.sync_item_organization() from public, anon, authenticated;

drop trigger if exists project_consultants_zy_sync_item_org on ship.project_consultants;
create trigger project_consultants_zy_sync_item_org
  after insert or update of org_name on ship.project_consultants
  for each row execute function ship.sync_item_organization();

-- Backfill: bring every existing item in line with its roster.
update ship.line_items li
   set company_name = coalesce(nullif(btrim(pc.org_name), ''), 'Unknown Organization')
  from ship.project_consultants pc
 where pc.project_id = li.project_id
   and lower(pc.consultant_type) = lower(li.discipline)
   and li.company_name is distinct from coalesce(nullif(btrim(pc.org_name), ''), 'Unknown Organization');
