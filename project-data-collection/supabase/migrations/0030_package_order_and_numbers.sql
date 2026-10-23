-- =====================================================================
-- 0030_package_order_and_numbers.sql
-- SHIP -- packages get a user-owned number and a user-owned order.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0029: everything in `ship`, no extensions,
-- one transaction. Additive; nothing earlier is edited. Anything an
-- earlier migration defined that changes here is redefined here in full.
-- Re-runnable: every step is IF NOT EXISTS / CREATE OR REPLACE / DROP
-- ... IF EXISTS, and the backfill only touches rows still unset.
--
-- WHY
-- ---
-- The owner: "the packages can be in any order and any number and name."
-- Until now a package's number (PP10, PP11, ...) was handed out by
-- ship.fill_chunk_number() (0003) and the UI could only rename it, and
-- the order was simply created_at. Now:
--
--   * The Rename dialog edits the number AND the name. The number is
--     free text ("PP3", "12", "A-2"), trimmed, non-blank, at most 40
--     characters, and unique within the project (the existing
--     unique (project_id, chunk_number) constraint from 0001 stays; the
--     client turns its 23505 into a friendly inline message). Changing
--     one package's number never renumbers another.
--
--   * Packages are reordered by drag and drop. The order lives in a new
--     column, chunk_projects.sort_order, and is independent of the
--     number. Every list of packages (Packaging tab, Timeline rows,
--     exports) reads ORDER BY sort_order, created_at, id.
--
--   * New packages still get a default number: the next PP number from
--     ship.chunk_number_counters, but now SKIPPING any number already in
--     use in the project, because a person can type "PP14" by hand before
--     the counter gets there. A new package goes last (max + 1).
--
--   * Deleting a package renumbers nothing. Numbers belong to the user.
--
-- CONNECTIONS ARE UNAFFECTED
-- --------------------------
-- Nothing references a package by its number. chunk_project_items,
-- chunk_phases (and through them phase_dependencies), and every scenario
-- payload key packages by chunk_projects.id (uuid). chunk_number is a
-- display label only, so renumbering or reordering moves no data.
--
-- AUTHORITY
-- ---------
-- * Number and name: a plain UPDATE through the existing RLS policy
--   chunk_projects_update (0009): admins and editors of the project
--   (my_editable_project_ids()). That policy never guarded the number
--   column, so nothing changes for who may write; consultants and viewers
--   are still refused by RLS (the update matches no rows).
-- * Order: ship.reorder_chunk_projects(p_project_id, p_ordered_ids),
--   SECURITY DEFINER so the whole order is written in one statement,
--   with an explicit ship.can_edit_project() check first (42501 for
--   anyone who is not an admin/editor of the project). anon gets nothing.
--
-- CONTRACT
--   ship.chunk_projects.sort_order integer not null  (0-based, per project)
--   ship.reorder_chunk_projects(p_project_id text, p_ordered_ids uuid[])
--     returns void
--     Listed ids take positions 0..n-1 in the given order. Ids that are
--     not packages of p_project_id (e.g. deleted a moment ago) are
--     ignored; a repeated id counts at its first position. Packages of
--     the project that were NOT listed (e.g. created a moment ago by
--     someone else) keep their relative order after the listed ones.
--   Number errors from the trigger: 23514 'package number cannot be
--   blank' / 'package number is too long'. Duplicates: 23505 from the
--   unique constraint chunk_projects_project_id_chunk_number_key.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. sort_order, backfilled in today's display order (created_at, which
--    is what lib/store.ts and lib/export/report-data.ts ordered by).
-- ---------------------------------------------------------------------
alter table ship.chunk_projects
  add column if not exists sort_order integer;

update ship.chunk_projects c
   set sort_order = ranked.pos
  from (
    select id,
           (row_number() over (partition by project_id
                               order by created_at, chunk_number, id) - 1)::integer as pos
      from ship.chunk_projects
  ) ranked
 where ranked.id = c.id
   and c.sort_order is null;

-- No column default: the BEFORE INSERT trigger below puts a new package
-- last. NOT NULL is checked after BEFORE triggers, so an insert that
-- leaves sort_order out still succeeds.
alter table ship.chunk_projects
  alter column sort_order set not null;

comment on column ship.chunk_projects.sort_order is
  'Display order of the package within its project (0-based). User-owned and independent of chunk_number. Written by ship.reorder_chunk_projects(); a new package is put last by ship.fill_chunk_number().';

create index if not exists chunk_projects_project_id_sort_order_idx
  on ship.chunk_projects (project_id, sort_order);

-- ---------------------------------------------------------------------
-- 2. The number: non-blank and bounded. The trigger trims first, so
--    these only fire for a value that is genuinely blank or too long.
-- ---------------------------------------------------------------------
alter table ship.chunk_projects
  drop constraint if exists chunk_projects_chunk_number_not_blank;
alter table ship.chunk_projects
  add constraint chunk_projects_chunk_number_not_blank
  check (btrim(chunk_number) <> '');

alter table ship.chunk_projects
  drop constraint if exists chunk_projects_chunk_number_length;
alter table ship.chunk_projects
  add constraint chunk_projects_chunk_number_length
  check (char_length(chunk_number) <= 40);

comment on column ship.chunk_projects.chunk_number is
  'The package number shown to people (PP10, A-2, ...). Free text, trimmed, unique per project. Auto-assigned as the next free PP number when left blank on insert; editable afterwards by project admins/editors. A label only: nothing references a package by it.';

-- ---------------------------------------------------------------------
-- 3. ship.fill_chunk_number() -- BEFORE INSERT OR UPDATE OF chunk_number
--
-- INSERT: trims the number; when blank, hands out the next PP number
--   from the counter, skipping numbers already taken in the project.
--   The counter row is locked (FOR UPDATE) for the rest of the
--   transaction, so two concurrent inserts cannot pick the same number.
--   Also puts the package last when sort_order was not given.
-- UPDATE: trims the number and refuses a blank one with a readable
--   message (rather than the bare check-constraint name).
--
-- Still SECURITY DEFINER with an empty search_path (0003): the counter
-- table has no client grants, and the "is it taken" probe must see every
-- package of the project regardless of the caller's RLS.
-- ---------------------------------------------------------------------
create or replace function ship.fill_chunk_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next integer;
begin
  new.chunk_number := btrim(coalesce(new.chunk_number, ''));

  if tg_op = 'UPDATE' then
    if new.chunk_number = '' then
      raise exception 'package number cannot be blank'
        using errcode = '23514';
    end if;
    if char_length(new.chunk_number) > 40 then
      raise exception 'package number is too long (40 characters at most)'
        using errcode = '23514';
    end if;
    return new;
  end if;

  -- INSERT ------------------------------------------------------------
  if new.sort_order is null then
    select coalesce(max(c.sort_order) + 1, 0)
      into new.sort_order
      from ship.chunk_projects c
     where c.project_id = new.project_id;
  end if;

  if new.chunk_number <> '' then
    return new;
  end if;

  -- next_value is the NEXT number to hand out (0001/0003 semantics; the
  -- default 10 makes the first package PP10).
  insert into ship.chunk_number_counters (project_id)
  values (new.project_id)
  on conflict (project_id) do nothing;

  select c.next_value
    into v_next
    from ship.chunk_number_counters c
   where c.project_id = new.project_id
     for update;

  while exists (
    select 1
      from ship.chunk_projects c
     where c.project_id = new.project_id
       and c.chunk_number = 'PP' || v_next::text
  ) loop
    v_next := v_next + 1;
  end loop;

  update ship.chunk_number_counters c
     set next_value = v_next + 1
   where c.project_id = new.project_id;

  new.chunk_number := 'PP' || v_next::text;

  return new;
end;
$$;

-- Same name as 0003 (see the trigger-ordering note there); now also on
-- UPDATE OF chunk_number so a rename is trimmed and checked too.
drop trigger if exists chunk_projects_aa_fill_chunk_number on ship.chunk_projects;

create trigger chunk_projects_aa_fill_chunk_number
  before insert or update of chunk_number on ship.chunk_projects
  for each row execute function ship.fill_chunk_number();

-- A trigger function: never callable directly (matches 0005).
revoke all on function ship.fill_chunk_number() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. ship.reorder_chunk_projects(p_project_id, p_ordered_ids)
-- ---------------------------------------------------------------------
create or replace function ship.reorder_chunk_projects(
  p_project_id  text,
  p_ordered_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project_id is null or not coalesce(ship.can_edit_project(p_project_id), false) then
    raise exception 'ship.reorder_chunk_projects: edit access to this project required'
      using errcode = '42501';
  end if;

  with listed as (
    -- First position of each listed id that really is a package of this
    -- project; strays (deleted, other project, repeated) drop out here.
    select x.id, min(x.ord) as ord
      from unnest(coalesce(p_ordered_ids, '{}'::uuid[])) with ordinality as x(id, ord)
      join ship.chunk_projects c
        on c.id = x.id and c.project_id = p_project_id
     group by x.id
  ),
  ranked as (
    select c.id,
           (row_number() over (
              order by (l.ord is null),          -- listed first
                       l.ord,                    -- in the given order
                       c.sort_order, c.created_at, c.id  -- then the rest, as they were
            ) - 1)::integer as pos
      from ship.chunk_projects c
      left join listed l on l.id = c.id
     where c.project_id = p_project_id
  )
  update ship.chunk_projects c
     set sort_order = r.pos
    from ranked r
   where r.id = c.id
     and c.sort_order is distinct from r.pos;
end;
$$;

revoke all on function ship.reorder_chunk_projects(text, uuid[]) from public, anon;
grant execute on function ship.reorder_chunk_projects(text, uuid[]) to authenticated;

comment on function ship.reorder_chunk_projects(text, uuid[]) is
  'Sets the display order of a project''s packages. Admins/editors of the project only (42501 otherwise). See 0030 for the contract.';

commit;
