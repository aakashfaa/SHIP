-- =====================================================================
-- 0029_line_item_order.sql
-- SHIP -- people put their own line items in order (drag and drop in
-- Add Data), and item numbers renumber to stay gap-free.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0028. Additive; earlier files are not edited.
--
-- THE CLIENT REQUEST
-- ------------------
-- Owner: "Let people reorder stuff in the Add Data view so they can
-- reorder their own stuff. The way they do that is by dragging and
-- dropping, looking on the left side of a line item, and moving up and
-- down. Similarly there should be renumbering after moving the things and
-- if something is deleted there should be renumbering for all. Any
-- connection to them should remain."
-- Megan: "If I wanted to shift A4 to A7, is there a way?" and "when we
-- delete a number in the sequence, such as A6, can the rest of the series
-- renumber to fill in that void? Currently they all stay the same."
--
-- THIS REVERSES A RULE -- READ BEFORE TRUSTING 0003 / 0014's COMMENTS
-- -------------------------------------------------------------------
-- 0003 ("Numbers must never be reused; they end up in client
-- deliverables", "Deleting a line item does not roll the counter back,
-- which is the point") and 0014 (only a platform admin may change
-- item_number) were written under the rule that a number, once handed
-- out, is permanent. The owner has DECIDED otherwise: within a project and
-- discipline the numbers are always 1..n with no gaps, in the order the
-- items are arranged. So from this migration on:
--   * an item's number is a POSITION, not an identity. It changes when
--     items are reordered or when an earlier item in the same discipline
--     is deleted.
--   * the identity is line_items.id (uuid). Everything that links to a
--     line item already uses it: chunk_project_items.line_item_id
--     (packages), suggestions.target_id, scenario payloads (phase rows,
--     no item references at all). Nothing stores item_number as a
--     reference, so "any connection to them should remain" holds by
--     construction. Exports print the number as of the moment of export.
--   * 0003's race-safe counter is kept for INSERT (it is still the
--     cheapest way to hand out the next number under concurrency), but it
--     is now reset to count+1 after every renumber instead of only ever
--     growing.
--   * 0014's guard still refuses item_number from a client. Only the
--     renumber below may change it (see "THE BYPASS").
-- The text of 0003/0014 is left as it was (applied migrations are not
-- edited); this header is the correction.
--
-- WHAT CHANGES
-- ------------
-- 1. line_items.sort_order integer NOT NULL: the project-wide arrangement.
--    Backfilled per project in the order Master View shows by default
--    (item-number letters, then the numeric part -- lib/view-columns/
--    master.ts compareItemNumbers), so nothing visibly moves.
--    Item numbers are DERIVED from it: within a discipline (strictly,
--    within a prefix) the item with the lowest sort_order is <prefix>1.
--    sort_order itself may have gaps; only the numbers are gap-free.
--
-- 2. New items go last: BEFORE INSERT trigger line_items_ab_sort_order
--    sets sort_order = max + 1 for the project (a client-supplied value is
--    ignored unless the writer is privileged, same rule as item_number).
--    0003's fill_item_number then hands out count+1 for the discipline,
--    which is exactly where a last item belongs.
--
-- 3. ship.renumber_line_items(project): ranks each prefix's items by
--    sort_order and rewrites item_number gap-free, then resets
--    item_number_counters to count+1 (and to 1 for a discipline with no
--    items left). Two-phase UPDATE -- changed rows first move to a unique
--    '~<uuid>' placeholder, then to their final number -- because
--    unique (project_id, item_number) is not deferrable and swapping A3
--    and A4 in one statement would collide mid-way. Only rows whose number
--    actually changes are written. Internal: no client may call it.
--
-- 4. ship.reorder_line_items(p_project_id, p_ordered_ids uuid[]) -- the
--    RPC behind the drag handle. The caller passes the items THEY see, in
--    the new order. Those items are dealt back into the sort_order slots
--    the same items occupy today, so items the caller does not see (other
--    people's) keep their slots and do not move. Then renumber.
--    Permission: the same rule as line_items_update (0009) -- a project
--    admin/editor may reorder any item in the project, a consultant only
--    items they filed (user_email = their email), a viewer nothing. Every
--    id must pass, or the whole call fails with 42501 and nothing changes.
--
-- 5. Renumber after delete: statement-level AFTER DELETE trigger with a
--    transition table, one renumber per affected project per statement.
--    Deleting a PROJECT cascades into line_items; by then the project row
--    is gone, and renumber_line_items() skips a project that no longer
--    exists (writing its counters would violate their FK).
--
-- THE BYPASS (how the renumber gets past 0014's guard)
-- ---------------------------------------------------
-- The renumber runs as whichever user caused it (a consultant reordering,
-- or deleting their item), so 0014's guard would refuse the item_number
-- change. Same technique as 0027's ship.syncing_org: the transaction-local
-- setting ship.renumbering = 'on', set only by the SECURITY DEFINER
-- functions here and switched off again before they return. While it is
-- on, the guard lets item_number and sort_order change -- and nothing else
-- (project_id, company_name, discipline, ... are still checked).
-- A client cannot set it: PostgREST exposes only the schemas in
-- config.toml (public, graphql_public, ship) and set_config() lives in
-- pg_catalog; no exposed function calls set_config() with caller-chosen
-- arguments (grep: only 0027 and this file call it, with constants);
-- PostgREST itself only sets its own request.* / role GUCs. A
-- set_config(..., true) made inside a subtransaction that fails is
-- rolled back with it, so an exception cannot leave the flag on.
--
-- While the flag is on, three BEFORE triggers are skipped through a
-- trigger WHEN clause (recreated below under their original names, so
-- 0003's alphabetical ordering is unchanged):
--   line_items_aa_normalize      -- would bump updated_at on every
--                                   renumbered row ("edited" when nobody
--                                   edited it) and re-derive org/discipline
--   line_items_cc_sync_ecc       -- recomputes ecc_amount; pointless here
--   line_items_dd_check_taxonomy -- re-validates the four taxonomy columns
--                                   on EVERY update. An item whose category
--                                   option was since deleted would make the
--                                   renumber -- and therefore deleting any
--                                   item in that project -- fail.
-- The renumber writes only item_number / sort_order, so none of the three
-- has anything to say about it.
--
-- CONCURRENCY
-- -----------
-- One transaction-scoped advisory lock per project
-- (ship.lock_line_item_order) is taken by every insert (in the sort_order
-- trigger, before the 0003 counter), by reorder_line_items and by
-- renumber_line_items, and held to commit. So a renumber never runs while
-- another transaction holds an uncommitted, already-numbered insert in the
-- same project, and two reorders of one project run one after the other.
-- Inserts into one project already serialised on the counter row (0003),
-- so this adds no new waiting for them.
--
-- KNOWN LIMITS
-- ------------
-- * A platform admin may still hand-set item_number / sort_order / move
--   an item's discipline (0014's privileged path). Numbers then stay as
--   set until the next reorder or delete in that project renumbers them.
-- * Running this migration renumbers every existing project once, so
--   gaps left by earlier deletes close now (relative order is kept).
--
-- Re-runnable: add column if not exists, backfill only NULLs, create or
-- replace, drop trigger if exists + create trigger. Renumbering an already
-- gap-free project changes nothing.
--
-- No explicit BEGIN/COMMIT, like 0020/0022: the Supabase CLI runs each
-- migration in a transaction, and supabase/tests/0029 @includes this text
-- inside its own rolled-back transaction. For a manual apply use
-- `psql -1` (single transaction).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. The column (filled in step 7, made NOT NULL there)
-- ---------------------------------------------------------------------
alter table ship.line_items add column if not exists sort_order integer;

comment on column ship.line_items.sort_order is
  'Project-wide arrangement of line items (0029). Item numbers are derived from it: within a prefix, lowest sort_order = <prefix>1. Set by trigger on insert (last), changed only by ship.reorder_line_items(). May have gaps; item numbers may not.';

create index if not exists line_items_project_sort_order_idx
  on ship.line_items (project_id, sort_order);

-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------

-- Serialises inserts, reorders and renumbers of ONE project until commit.
create or replace function ship.lock_line_item_order(p_project_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('ship.line_item_order:' || coalesce(p_project_id, ''), 0))
$$;

-- "M12" -> 12; no trailing digits -> NULL. numeric, so a hand-typed
-- 30-digit number cannot overflow the ordering.
create or replace function ship.item_number_seq(p_item_number text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select substring(coalesce(p_item_number, '') from '([0-9]+)$')::numeric
$$;

-- The numbering plan for a project: for every line item whose discipline
-- has a prefix, the number it should have now, and the counter key
-- fill_item_number() uses for its discipline (builtin -> canonical name,
-- custom -> the name its prefix was allocated under; see 0022 §5).
-- Ranking is by sort_order; the old number, created_at and id only break
-- ties (there should be none: sort_order is unique in practice).
create or replace function ship.line_item_number_plan(p_project_id text)
returns table (id uuid, current_number text, target_number text, counter_key text)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select li.id,
           li.item_number,
           li.sort_order,
           li.created_at,
           ship.project_discipline_prefix(li.project_id, li.discipline) as prefix,
           case
             when ship.builtin_discipline_prefix(li.discipline) is not null
               then coalesce(nullif(ship.canonical_discipline(li.discipline), ''), 'Admin')
             else (select dp.discipline
                     from ship.project_discipline_prefixes dp
                    where dp.project_id = li.project_id
                      and dp.discipline_key = lower(ship.canonical_discipline(li.discipline)))
           end as counter_key
      from ship.line_items li
     where li.project_id = p_project_id
  )
  select b.id,
         b.item_number,
         b.prefix || row_number() over (
           partition by b.prefix
           order by b.sort_order nulls last,
                    ship.item_number_seq(b.item_number) nulls last,
                    b.created_at,
                    b.id)::text,
         b.counter_key
    from base b
   -- A discipline with no prefix (cannot happen after 0022: such an item
   -- could not have been numbered) is left exactly as it is.
   where b.prefix is not null
$$;

-- ---------------------------------------------------------------------
-- 3. Guard: 0027's body, plus
--    * item_number / sort_order may change while ship.renumbering = 'on'
--    * a client may not write sort_order directly (on INSERT it is
--      cleared so the trigger in step 4 places the item last)
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
      new.item_number  := '';     -- 0003 fill_item_number assigns it
      new.company_name := '';     -- 0003 normalize_line_item derives it
      new.created_at   := now();
      new.sort_order   := null;   -- 0029 line_items_ab_sort_order: last
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
-- 4. New items go last.
--    "ab_" sorts after "aa_normalize" and before "bb_fill_item_number":
--    the advisory lock must be held before the 0003 counter is bumped.
-- ---------------------------------------------------------------------
create or replace function ship.assign_line_item_sort_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ship.lock_line_item_order(new.project_id);

  if new.sort_order is null then
    select coalesce(max(li.sort_order), 0) + 1
      into new.sort_order
      from ship.line_items li
     where li.project_id = new.project_id;
  end if;

  return new;
end;
$$;

revoke all on function ship.assign_line_item_sort_order() from public, anon, authenticated;

drop trigger if exists line_items_ab_sort_order on ship.line_items;
create trigger line_items_ab_sort_order
  before insert on ship.line_items
  for each row execute function ship.assign_line_item_sort_order();

-- ---------------------------------------------------------------------
-- 5. Skip normalize / ecc / taxonomy while renumbering (see header).
--    Same names, same functions, same events as 0003 / 0006 / 0008; only
--    the WHEN clause is new.
-- ---------------------------------------------------------------------
drop trigger if exists line_items_aa_normalize on ship.line_items;
create trigger line_items_aa_normalize
  before insert or update on ship.line_items
  for each row
  when (coalesce(current_setting('ship.renumbering', true), '') <> 'on')
  execute function ship.normalize_line_item();

drop trigger if exists line_items_cc_sync_ecc on ship.line_items;
create trigger line_items_cc_sync_ecc
  before insert or update on ship.line_items
  for each row
  when (coalesce(current_setting('ship.renumbering', true), '') <> 'on')
  execute function ship.sync_line_item_ecc();

drop trigger if exists line_items_dd_check_taxonomy on ship.line_items;
create trigger line_items_dd_check_taxonomy
  before insert or update on ship.line_items
  for each row
  when (coalesce(current_setting('ship.renumbering', true), '') <> 'on')
  execute function ship.check_line_item_taxonomy();

-- ---------------------------------------------------------------------
-- 6. Renumber, reorder, renumber-after-delete
-- ---------------------------------------------------------------------

-- Returns how many items got a new number. Internal only.
create or replace function ship.renumber_line_items(p_project_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  v_targets text[];
  v_keys    text[];
  v_changed integer := 0;
begin
  -- A project being deleted (cascade) has nothing left to number, and its
  -- counters are going with it.
  if p_project_id is null
     or not exists (select 1 from ship.projects p where p.id = p_project_id) then
    return 0;
  end if;

  perform ship.lock_line_item_order(p_project_id);

  -- One plan, computed before anything moves, used by both phases.
  select coalesce(array_agg(pl.id), '{}'), coalesce(array_agg(pl.target_number), '{}')
    into v_ids, v_targets
    from ship.line_item_number_plan(p_project_id) pl
   where pl.current_number is distinct from pl.target_number;

  perform set_config('ship.renumbering', 'on', true);

  if cardinality(v_ids) > 0 then
    -- Phase 1: out of the way, onto a placeholder nobody else can hold.
    update ship.line_items li
       set item_number = '~' || li.id::text
     where li.project_id = p_project_id
       and li.id = any (v_ids);

    -- Phase 2: onto the final numbers.
    update ship.line_items li
       set item_number = t.target
      from unnest(v_ids, v_targets) as t(id, target)
     where li.project_id = p_project_id
       and li.id = t.id;

    v_changed := cardinality(v_ids);
  end if;

  -- Counters: next number = count + 1 per discipline; 1 for a discipline
  -- whose items are all gone. fill_item_number() still skips a taken
  -- number (0014), so this can only ever be too low, never collide.
  select coalesce(array_agg(distinct pl.counter_key), '{}')
    into v_keys
    from ship.line_item_number_plan(p_project_id) pl
   where pl.counter_key is not null;

  insert into ship.item_number_counters as c (project_id, discipline, next_value)
  select p_project_id, pl.counter_key, count(*) + 1
    from ship.line_item_number_plan(p_project_id) pl
   where pl.counter_key is not null
   group by pl.counter_key
  on conflict (project_id, discipline)
    do update set next_value = excluded.next_value
     where c.next_value is distinct from excluded.next_value;

  update ship.item_number_counters c
     set next_value = 1
   where c.project_id = p_project_id
     and c.next_value <> 1
     and not (c.discipline = any (v_keys));

  perform set_config('ship.renumbering', 'off', true);

  return v_changed;
end;
$$;

revoke all on function ship.renumber_line_items(text)      from public, anon, authenticated;
revoke all on function ship.line_item_number_plan(text)    from public, anon, authenticated;
revoke all on function ship.lock_line_item_order(text)     from public, anon, authenticated;
revoke all on function ship.item_number_seq(text)          from public, anon;
grant execute on function ship.item_number_seq(text)       to authenticated;

-- The drag handle. p_ordered_ids = the items the caller sees, new order.
create or replace function ship.reorder_line_items(p_project_id text, p_ordered_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected integer;
  v_allowed  integer;
  v_slots    integer[];
  v_editor   boolean;
begin
  v_expected := coalesce(cardinality(p_ordered_ids), 0);
  if v_expected = 0 then
    return;
  end if;

  if array_position(p_ordered_ids, null) is not null
     or (select count(distinct x) from unnest(p_ordered_ids) as t(x)) <> v_expected then
    raise exception 'reorder_line_items: every id must be listed exactly once' using errcode = '22023';
  end if;

  -- Viewers, outsiders and deactivated accounts stop here (project_role()
  -- is null / 'viewer' for them).
  if not ship.can_contribute_project(p_project_id) then
    raise exception 'You don''t have permission to reorder line items in this project.'
      using errcode = '42501';
  end if;

  v_editor := ship.can_edit_project(p_project_id);

  perform ship.lock_line_item_order(p_project_id);

  -- Same rule as the line_items_update policy (0009): editors any item,
  -- contributors their own.
  select count(*)
    into v_allowed
    from ship.line_items li
   where li.project_id = p_project_id
     and li.id = any (p_ordered_ids)
     and (v_editor or li.user_email = ship.current_email());

  if v_allowed <> v_expected then
    raise exception 'reorder_line_items: % of % line items can''t be reordered (not in this project, or not yours to edit)',
      v_expected - v_allowed, v_expected
      using errcode = '42501';
  end if;

  -- The slots these very items hold now, lowest first. Dealing them back
  -- out in the new order moves only these items; everyone else's stay put.
  select array_agg(li.sort_order order by li.sort_order, li.id)
    into v_slots
    from ship.line_items li
   where li.project_id = p_project_id
     and li.id = any (p_ordered_ids);

  perform set_config('ship.renumbering', 'on', true);

  update ship.line_items li
     set sort_order = v_slots[o.ord]
    from unnest(p_ordered_ids) with ordinality as o(id, ord)
   where li.project_id = p_project_id
     and li.id = o.id
     and li.sort_order is distinct from v_slots[o.ord];

  perform set_config('ship.renumbering', 'off', true);

  perform ship.renumber_line_items(p_project_id);
end;
$$;

revoke all on function ship.reorder_line_items(text, uuid[]) from public, anon;
grant execute on function ship.reorder_line_items(text, uuid[]) to authenticated;

comment on function ship.reorder_line_items(text, uuid[]) is
  'Drag-and-drop order for line items (0029). Pass the items you see, in the new order; they take the sort_order slots they hold now, then item numbers are renumbered gap-free. Editors: any item; contributors: their own; all-or-nothing (42501).';

create or replace function ship.renumber_after_line_item_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project text;
begin
  for v_project in
    select distinct d.project_id from deleted_line_items d order by 1
  loop
    perform ship.renumber_line_items(v_project);
  end loop;
  return null;
end;
$$;

revoke all on function ship.renumber_after_line_item_delete() from public, anon, authenticated;

drop trigger if exists line_items_zz_renumber_after_delete on ship.line_items;
create trigger line_items_zz_renumber_after_delete
  after delete on ship.line_items
  referencing old table as deleted_line_items
  for each statement execute function ship.renumber_after_line_item_delete();

-- ---------------------------------------------------------------------
-- 7. Backfill, then renumber every project once.
--    The flag keeps normalize/taxonomy out of the backfill (an item with
--    a since-deleted taxonomy value must not stop the migration).
-- ---------------------------------------------------------------------
select set_config('ship.renumbering', 'on', true);

with base as (
  select li.project_id, coalesce(max(li.sort_order), 0) as top
    from ship.line_items li
   group by li.project_id
),
ordered as (
  select li.id,
         b.top + row_number() over (
           partition by li.project_id
           order by substring(li.item_number from '^[A-Za-z]*'),
                    ship.item_number_seq(li.item_number) nulls last,
                    li.item_number,
                    li.created_at,
                    li.id) as rn
    from ship.line_items li
    join base b on b.project_id = li.project_id
   where li.sort_order is null
)
update ship.line_items li
   set sort_order = o.rn
  from ordered o
 where li.id = o.id;

select set_config('ship.renumbering', 'off', true);

alter table ship.line_items alter column sort_order set not null;

do $$
declare
  v_project text;
  v_changed integer;
  v_total   integer := 0;
begin
  for v_project in select p.id from ship.projects p order by p.id loop
    v_changed := ship.renumber_line_items(v_project);
    v_total := v_total + v_changed;
  end loop;
  raise notice '0029: renumbered % line item(s) to close gaps', v_total;
end;
$$;
