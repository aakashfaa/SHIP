-- =====================================================================
-- 0003_ship_numbering.sql
-- SHIP -- line item normalisation + race-safe A1 / M2 / PP12 numbering.
--
-- WHAT THIS REPLACES (and the bugs it fixes)
-- ------------------------------------------
-- lib/store.ts:266-273  getNextItemNumber()
--     return `${prefix}${matching.length + 1}`
--   Bug 1 (racy):   two concurrent inserts both read the same count and
--                   both produce A4.
--   Bug 2 (reuse):  delete A2 and the next insert is also numbered A4 ->
--                   wait, worse: the count drops, so the NEXT item reuses
--                   a number that already existed. Numbers must never be
--                   reused; they end up in client deliverables.
--   Bug 3 (global): `items.filter(i => i.discipline === discipline)`
--                   counts across ALL projects, so the second project's
--                   first Mechanical item is numbered M4 instead of M1.
--   Fixed by scoping the counter to (project_id, discipline).
--
-- lib/store.ts:225-236  normalizeLineItem()
-- lib/store.ts:315-329  getCompanyNameForUser()
--   Both move into ship.normalize_line_item() below, so the rules hold no
--   matter which client writes the row.
--
-- WHY TRIGGERS AND NOT RPCs
-- -------------------------
-- With BEFORE INSERT triggers the client keeps doing a plain
-- supabase.from('line_items').insert(...): RLS applies normally, the
-- returned row is the real row, and there is no extra RPC surface to
-- secure. An RPC would have to re-implement the RLS check by hand.
--
-- COUNTER SEMANTICS -- READ THIS BEFORE TOUCHING THE SEED
-- -------------------------------------------------------
-- `next_value` holds the NEXT number to hand out (hence the defaults of
-- 1 and 10 in 0001). The allocation is a single statement:
--
--   insert into <counter> as c (...) values (..., N + 1)
--   on conflict (...) do update set next_value = c.next_value + 1
--   returning c.next_value - 1
--
--   * miss  -> row is created holding N+1, and RETURNING yields N.
--   * hit   -> the row is bumped, and RETURNING yields the pre-bump value.
--
-- ON CONFLICT DO UPDATE takes a row lock on exactly one counter row, so
-- concurrent inserts serialise on it and every one of them gets a
-- distinct number. Deleting a line item does not roll the counter back,
-- which is the point.
--
-- The corollary for seeds/001_seed.sql: the backfill must set
-- next_value = max(existing) + 1, NOT max(existing).
--
-- Re-runnable: `create or replace function` plus
-- `drop trigger if exists` + `create trigger`.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- ship.discipline_prefix(text)
-- An exact port of getDisciplinePrefix() at lib/store.ts:238-264,
-- including its fallbacks: a single unmapped word yields its first two
-- characters, and a multi-word unmapped value yields the initials of its
-- first two words.
-- ---------------------------------------------------------------------
create or replace function ship.discipline_prefix(p_discipline text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_clean  text;
  v_prefix text;
  v_words  text[];
begin
  v_clean := upper(btrim(coalesce(p_discipline, '')));

  v_prefix := case v_clean
                when 'ARCHITECTURE'           then 'A'
                when 'ACCESSIBILITY'          then 'AC'
                when 'CIVIL'                  then 'C'
                when 'ELECTRICAL'             then 'E'
                when 'ENVELOPE'               then 'EN'
                when 'FIRE ALARM'             then 'FA'
                when 'HAZARDOUS MATERIALS'    then 'HM'
                when 'HISTORIC PRESERVATION'  then 'HP'
                when 'LANDSCAPE'              then 'L'
                when 'MECHANICAL'             then 'M'
                when 'PLUMBING'               then 'P'
                when 'STRUCTURAL'             then 'S'
                when 'SECURITY'               then 'SE'
                when 'TELECOM'                then 'T'
                when 'ADMIN'                  then 'AD'
                else null
              end;

  if v_prefix is not null then
    return v_prefix;
  end if;

  v_words := array_remove(regexp_split_to_array(v_clean, '\s+'), '');

  if array_length(v_words, 1) is null then
    return '';
  elsif array_length(v_words, 1) = 1 then
    return left(v_words[1], 2);
  else
    return left(v_words[1], 1) || left(v_words[2], 1);
  end if;
end;
$$;

revoke all on function ship.discipline_prefix(text) from public;
grant execute on function ship.discipline_prefix(text) to authenticated;

-- ---------------------------------------------------------------------
-- ship.normalize_line_item()  -- BEFORE INSERT OR UPDATE
--
-- SECURITY DEFINER because it reads project_consultants/project_members
-- to derive company_name; running as the owner keeps that lookup out of
-- the writer's RLS scope (and out of the writer's control).
--
-- Derived values are only ever FILLED IN when blank, never overwritten.
-- That is what lets seeds/001_seed.sql supply its own company_name, and
-- it matches the TS behaviour where companyName is computed once at
-- creation and then carried.
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
begin
  v_original_type := new.consultant_type;

  -- normalizeLineItem(): 'Admin' is not a real discipline.
  if new.consultant_type = 'Admin' then
    new.consultant_type := 'Architecture';
  end if;

  -- Fill discipline from consultant_type when the client left it blank.
  -- The numbering trigger reads this column, which is exactly why the
  -- trigger names below are ordered the way they are.
  if new.discipline is null or btrim(new.discipline) = '' then
    new.discipline := new.consultant_type;
  end if;

  if new.discipline = 'Admin' then
    new.discipline := 'Architecture';
  end if;

  new.user_email          := lower(btrim(coalesce(new.user_email, '')));
  new.estimated_first_cost := coalesce(new.estimated_first_cost, '');
  new.potential_synergies  := coalesce(new.potential_synergies, '{}'::text[]);

  -- getCompanyNameForUser(lib/store.ts:315-329)
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

      -- 2. fallback: any consultant row on this project for that email
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

-- ---------------------------------------------------------------------
-- ship.fill_item_number()  -- BEFORE INSERT
-- ---------------------------------------------------------------------
create or replace function ship.fill_item_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_discipline text;
  v_next       integer;
begin
  -- Respect an explicitly supplied number. This is what lets the seed
  -- preserve its A1 / M1 / HP1 values, and lets an admin renumber by
  -- hand.
  if new.item_number is not null and new.item_number <> '' then
    return new;
  end if;

  v_discipline := coalesce(nullif(btrim(new.discipline), ''), 'Admin');

  -- One statement, one row lock -> concurrent inserts serialise and each
  -- receives a distinct number. Never count(*)+1; see the header.
  insert into ship.item_number_counters as c (project_id, discipline, next_value)
  values (new.project_id, v_discipline, 2)
  on conflict (project_id, discipline)
    do update set next_value = c.next_value + 1
  returning c.next_value - 1 into v_next;

  new.item_number := ship.discipline_prefix(v_discipline) || v_next::text;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- ship.fill_chunk_number()  -- BEFORE INSERT
-- Ports getNextChunkNumber() (lib/store.ts:479-491), which starts at
-- PP10, with the same race and reuse fixes.
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
  if new.chunk_number is not null and new.chunk_number <> '' then
    return new;
  end if;

  insert into ship.chunk_number_counters as c (project_id, next_value)
  values (new.project_id, 11)
  on conflict (project_id)
    do update set next_value = c.next_value + 1
  returning c.next_value - 1 into v_next;

  new.chunk_number := 'PP' || v_next::text;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- !! TRIGGER NAMES ARE DELIBERATELY UGLY -- DO NOT "TIDY" THEM !!
--
-- Postgres fires BEFORE-row triggers in ALPHABETICAL NAME ORDER, not in
-- creation order. ship.fill_item_number() reads NEW.discipline, and
-- ship.normalize_line_item() is what fills NEW.discipline in when the
-- client leaves it blank. So normalize MUST sort before numbering:
--
--     line_items_aa_normalize        <- runs first
--     line_items_bb_fill_item_number <- runs second, sees a discipline
--
-- Rename either one to something that sorts differently and every item
-- inserted without an explicit discipline gets numbered 'AD<n>' instead
-- of 'M<n>'. The `aa_`/`bb_` prefixes are the whole point.
-- ---------------------------------------------------------------------
drop trigger if exists line_items_aa_normalize        on ship.line_items;
drop trigger if exists line_items_bb_fill_item_number on ship.line_items;

create trigger line_items_aa_normalize
  before insert or update on ship.line_items
  for each row execute function ship.normalize_line_item();

create trigger line_items_bb_fill_item_number
  before insert on ship.line_items
  for each row execute function ship.fill_item_number();

-- chunk_projects has only the one BEFORE trigger, but it is named to the
-- same convention so the ordering rule stays obvious if a second one is
-- ever added.
drop trigger if exists chunk_projects_aa_fill_chunk_number on ship.chunk_projects;

create trigger chunk_projects_aa_fill_chunk_number
  before insert on ship.chunk_projects
  for each row execute function ship.fill_chunk_number();

commit;
