-- =====================================================================
-- 0014_line_item_integrity.sql
-- SHIP -- line items keep their identity, numbering cannot be bricked,
-- packages stay inside one project, and blank answers can be stored as
-- blank.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0013. Additive; nothing earlier is edited.
--
-- WHAT THIS FIXES (pre-launch audit master IDs)
-- ---------------------------------------------
-- M-11  `authenticated` holds a whole-row UPDATE on line_items and the
--       policy only checks ownership, so a consultant could PATCH their
--       own row's item_number, company_name, created_at (verified live:
--       'ZZ99' / 'Fake Corp' / 2000-01-01 all stuck). A BEFORE UPDATE
--       trigger now refuses any change to the system columns
--         item_number, company_name, consultant_type, discipline,
--         user_email, created_at, ecc_amount
--       from anyone but a platform admin, with errcode 42501 and the
--       message "<column> can't be changed". A trigger rather than
--       column grants because column-level UPDATE grants would make every
--       existing whole-row `.update()` fail outright, even ones that send
--       the column unchanged; this only objects to an actual change.
--
--       The trigger is named `line_items_a0_...` so it fires BEFORE
--       `line_items_aa_normalize` (triggers fire in name order). It must
--       see what the CLIENT sent, before normalize/sync rewrite NEW.
--
--       On INSERT, non-platform-admins can no longer choose item_number,
--       company_name or created_at either: those are blanked/reset so the
--       0003 triggers assign them, exactly as the app already expects
--       (lib/store.ts createLineItem never sends them).
--
--       DATA-6 / M-11: fill_item_number() used to hand out the counter's
--       next value blindly. If that number was already taken (a hand-set
--       or imported number), the insert hit the unique index, the failed
--       insert rolled back the counter bump, and every later insert for
--       that discipline failed forever. It now skips taken numbers.
--
-- M-12  Line items could be moved to another project (UPDATE project_id)
--       and packages could link line items from a different project.
--       project_id is now immutable for EVERYONE (including platform
--       admins: moving an item would orphan its package links and its
--       number), and a trigger on chunk_project_items requires the line
--       item and the package to share a project. Any existing
--       cross-project links are deleted below (none on the local seed).
--
-- D-9   Blank is a legitimate answer for number and dropdown fields:
--       NULL = unanswered, 0 = zero. annual_energy_savings /
--       annual_cost_savings lose NOT NULL and their 0 default, and the
--       eleven built-in dropdown columns lose NOT NULL. Their CHECK lists
--       already accept NULL (a CHECK passes on NULL), and the taxonomy
--       trigger already treats NULL as allowed. Existing 0s are left as
--       0: there is no way to tell a typed 0 from a defaulted one, and
--       rewriting a client's figure is worse than leaving it.
--       NOTE for clients: a blank dropdown must be sent as NULL, not ''
--       -- '' still fails the CHECK lists on the CHECK-constrained columns.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. System-column guard (M-11, M-12).
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
  if new.company_name is distinct from old.company_name then
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

revoke all on function ship.guard_line_item_system_columns() from public, anon, authenticated;

drop trigger if exists line_items_a0_guard_system_columns on ship.line_items;
create trigger line_items_a0_guard_system_columns
  before insert or update on ship.line_items
  for each row execute function ship.guard_line_item_system_columns();

-- ---------------------------------------------------------------------
-- 2. Numbering that skips taken numbers (M-11 / DATA-6).
--    Body identical to 0003 except the allocate-until-free loop.
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

  v_discipline := coalesce(nullif(btrim(new.discipline), ''), 'Admin');
  v_prefix     := ship.discipline_prefix(v_discipline);

  loop
    -- One statement, one row lock -> concurrent inserts serialise and
    -- each receives a distinct counter value (see 0003's header).
    insert into ship.item_number_counters as c (project_id, discipline, next_value)
    values (new.project_id, v_discipline, 2)
    on conflict (project_id, discipline)
      do update set next_value = c.next_value + 1
    returning c.next_value - 1 into v_next;

    v_candidate := v_prefix || v_next::text;

    -- A number can already be taken by a hand-set / imported row. Skip
    -- it rather than handing it out and failing on the unique index --
    -- that failure would roll back this very counter bump and so recur
    -- on every later insert for the discipline.
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

-- ---------------------------------------------------------------------
-- 3. Packages stay inside one project (M-12).
-- ---------------------------------------------------------------------
do $$
declare
  v_deleted integer;
begin
  delete from ship.chunk_project_items cpi
   using ship.chunk_projects c, ship.line_items li
   where c.id = cpi.chunk_project_id
     and li.id = cpi.line_item_id
     and c.project_id <> li.project_id;
  get diagnostics v_deleted = row_count;
  raise notice '0014: removed % cross-project package link(s)', v_deleted;
end;
$$;

create or replace function ship.check_chunk_item_same_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chunk_project text;
  v_item_project  text;
begin
  select c.project_id into v_chunk_project
    from ship.chunk_projects c where c.id = new.chunk_project_id;
  select li.project_id into v_item_project
    from ship.line_items li where li.id = new.line_item_id;

  -- A missing parent is the FK's job to report; only judge real rows.
  if v_chunk_project is not null and v_item_project is not null
     and v_chunk_project <> v_item_project then
    raise exception 'chunk_project_items: a package in project % cannot include a line item from project %',
      v_chunk_project, v_item_project
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function ship.check_chunk_item_same_project() from public, anon, authenticated;

drop trigger if exists chunk_project_items_same_project on ship.chunk_project_items;
create trigger chunk_project_items_same_project
  before insert or update of chunk_project_id, line_item_id on ship.chunk_project_items
  for each row execute function ship.check_chunk_item_same_project();

-- ---------------------------------------------------------------------
-- 4. D-9: blank (NULL) allowed for built-in number and dropdown columns.
-- ---------------------------------------------------------------------
alter table ship.line_items
  alter column annual_energy_savings drop not null,
  alter column annual_energy_savings set default null,
  alter column annual_cost_savings   drop not null,
  alter column annual_cost_savings   set default null,
  alter column category                          drop not null,
  alter column timeline_priority                 drop not null,
  alter column building_area_impacted            drop not null,
  alter column building_level_impacted           drop not null,
  alter column operational_impact                drop not null,
  alter column benefit_to_users                  drop not null,
  alter column benefit_to_public                 drop not null,
  alter column relative_first_cost               drop not null,
  alter column relative_operation_cost_impact    drop not null,
  alter column relative_operational_energy_usage drop not null,
  alter column electrification_eo594             drop not null;

comment on column ship.line_items.annual_energy_savings is
  'Annual energy saving per unit, in the project''s energy unit. NULL = not answered (D-9); 0 = answered zero.';
comment on column ship.line_items.annual_cost_savings is
  'Annual utility cost saving per unit, USD. NULL = not answered (D-9); 0 = answered zero.';

commit;
