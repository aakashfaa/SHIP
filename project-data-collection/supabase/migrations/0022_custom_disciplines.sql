-- =====================================================================
-- 0022_custom_disciplines.sql
-- SHIP -- consultants can belong to a discipline outside the fixed list
-- ("Other..." in the UI), e.g. "Acoustics" or "Audio Visual".
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0021. Additive; nothing earlier is edited.
--
-- WHAT CHANGES
-- ------------
-- 1. Every CHECK constraint on the five discipline columns
--    (project_consultants.consultant_type, project_members.consultant_type,
--    line_items.consultant_type, line_items.discipline,
--    line_items.potential_synergies) is dropped -- found through
--    pg_constraint by column, not by name, so a differently named copy
--    on another database cannot survive -- and replaced by a shape check:
--    non-blank, at most 60 characters (code points), no control
--    characters (U+0001-U+001F, U+007F-U+009F; spelled out rather than
--    [[:cntrl:]] so the result does not depend on the database locale).
--    Every existing value passes. lib/constants.ts customDisciplineError()
--    mirrors these rules exactly.
--
-- 2. Names are canonicalised (ship.canonical_discipline): every run of
--    whitespace (an explicit set, again locale-independent) becomes one
--    space, the ends are trimmed, and a case-insensitive match of a
--    built-in discipline takes its canonical spelling ("mechanical" ->
--    "Mechanical"). Applied by trigger on project_consultants and
--    project_members, and by normalize_line_item on line_items (which also
--    maps a custom discipline to the roster's spelling). 'Admin' is not a
--    roster discipline. One discipline per project case-insensitively
--    (project_consultants_project_lower_type_key, plus a BEFORE trigger
--    that refuses a second one with a clean 22023 -- so a create_project /
--    update_project payload listing one twice no longer fails with
--    "cannot affect row a second time"). Neither RPC is redefined here.
--
-- 3. Item-number prefixes for custom disciplines (owner's decision: an
--    automatic prefix, never chosen or shown as a setting).
--    * The 15 built-in prefixes (A, AC, ... AD) are unchanged
--      (ship.builtin_discipline_prefix()).
--    * A custom prefix is allocated ONLY when the discipline joins a
--      project's roster (AFTER trigger on project_consultants -- a
--      project-admin action), and is kept forever in
--      ship.project_discipline_prefixes. That table is not touched by
--      update_project()'s delete-and-reinsert of the roster, so removing
--      and re-adding "Acoustics" gives back the same prefix and its
--      numbering continues.
--    * Numbering a line item never allocates. A line item whose discipline
--      is neither built-in, 'Admin', nor a discipline that has been on the
--      roster is REFUSED (22023). Refusing rather than falling back to AD:
--      a fallback would silently file the item under the wrong discipline
--      and mix its numbers into Admin's sequence, while the refusal is what
--      the pre-0022 CHECK did for unknown disciplines anyway. Either way a
--      contributor can no longer exhaust a project's prefix pool by
--      inventing discipline strings.
--    * Counters are keyed on the canonical name (the roster spelling for a
--      custom discipline), so "acoustics" and "Acoustics" share one
--      counter as well as one prefix.
--    * Derivation: uppercase A-Z letters only. Two or more words -> the
--      initials of the first four ("Audio Visual" -> AV); one word -> its
--      first two letters ("Acoustics" -> AC). If taken it grows from the
--      letters of the name (ACO, ACOU, ...), then base + one letter, then
--      X + two letters. "Taken" = a built-in prefix, PP (package numbers),
--      or another custom prefix in the same project; unique (project_id,
--      prefix) makes that hard even under concurrency. Letters only, so
--      <prefix><n> is never ambiguous.
--    Item numbers already stored on line_items are never rewritten.
--
-- Re-runnable: constraints dropped by lookup, create or replace, if not
-- exists throughout.
--
-- No explicit BEGIN/COMMIT, like 0020: the Supabase CLI runs each
-- migration in a transaction, and supabase/tests/0022 @includes this text
-- inside its own rolled-back transaction. For a manual apply use
-- `psql -1` (single transaction).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Shape validation + canonical form
-- ---------------------------------------------------------------------
create or replace function ship.is_valid_discipline(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and btrim(p_value) <> ''
     and char_length(p_value) <= 60
     and p_value !~ '[\u0001-\u001f\u007f-\u009f]'
$$;

create or replace function ship.are_valid_disciplines(p_values text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_values is not null
     and coalesce(cardinality(p_values), 0) <= 100
     and coalesce(bool_and(ship.is_valid_discipline(v)), true)
    from unnest(p_values) as v
$$;

-- "  fire   alarm " -> "Fire Alarm"; "Acoustics " -> "Acoustics".
-- Whitespace set = lib/constants.ts DISCIPLINE_WHITESPACE.
create or replace function ship.canonical_discipline(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  with c as (
    select btrim(regexp_replace(coalesce(p_value, ''),
                 '[\u0009-\u000d    -     　﻿]+',
                 ' ', 'g')) as v
  )
  select coalesce(k.name, c.v)
    from c
    left join (values
      ('Architecture'), ('Accessibility'), ('Civil'), ('Electrical'), ('Envelope'),
      ('Fire Alarm'), ('Hazardous Materials'), ('Historic Preservation'), ('Landscape'),
      ('Mechanical'), ('Plumbing'), ('Structural'), ('Security'), ('Telecom')
    ) as k(name) on lower(k.name) = lower(c.v)
$$;

revoke all on function ship.is_valid_discipline(text)     from public, anon;
revoke all on function ship.are_valid_disciplines(text[]) from public, anon;
revoke all on function ship.canonical_discipline(text)    from public, anon;
grant execute on function ship.is_valid_discipline(text)     to authenticated;
grant execute on function ship.are_valid_disciplines(text[]) to authenticated;
grant execute on function ship.canonical_discipline(text)    to authenticated;

-- Drop EVERY single-column CHECK on the discipline columns, whatever it is
-- called, then add the new ones under the 0001 names.
do $$
declare
  r record;
begin
  for r in
    select con.conrelid::regclass as tbl, con.conname
      from pg_constraint con
      join pg_attribute a
        on a.attrelid = con.conrelid
       and a.attnum = any (con.conkey)
     where con.contype = 'c'
       and cardinality(con.conkey) = 1
       and (con.conrelid, a.attname) in (
             ('ship.project_consultants'::regclass, 'consultant_type'),
             ('ship.project_members'::regclass,     'consultant_type'),
             ('ship.line_items'::regclass,          'consultant_type'),
             ('ship.line_items'::regclass,          'discipline'),
             ('ship.line_items'::regclass,          'potential_synergies'))
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end;
$$;

alter table ship.project_consultants add constraint project_consultants_consultant_type_check
  check (ship.is_valid_discipline(consultant_type)
         and consultant_type = btrim(consultant_type)
         and lower(consultant_type) <> 'admin');

alter table ship.project_members add constraint project_members_consultant_type_check
  check (ship.is_valid_discipline(consultant_type)
         and consultant_type = btrim(consultant_type)
         and lower(consultant_type) <> 'admin');

-- line_items keep accepting 'Admin' (normalize_line_item rewrites it).
alter table ship.line_items add constraint line_items_consultant_type_check
  check (ship.is_valid_discipline(consultant_type));

alter table ship.line_items add constraint line_items_discipline_check
  check (ship.is_valid_discipline(discipline));

-- Synergy choices come from the project's own roster, which can now hold
-- custom disciplines.
alter table ship.line_items add constraint line_items_potential_synergies_check
  check (ship.are_valid_disciplines(potential_synergies));

-- ---------------------------------------------------------------------
-- 2. Canonical spelling on the roster tables
-- ---------------------------------------------------------------------
create or replace function ship.canonicalize_consultant_type()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.consultant_type := ship.canonical_discipline(new.consultant_type);
  return new;
end;
$$;

revoke all on function ship.canonicalize_consultant_type() from public, anon, authenticated;

-- One discipline per project, case-insensitively, refused with a clean
-- 22023. create_project()/update_project() insert the whole roster in one
-- INSERT ... ON CONFLICT DO UPDATE (into a new project / a just-emptied
-- roster), and a payload naming "Mechanical" and "mechanical" would
-- otherwise die with "ON CONFLICT DO UPDATE command cannot affect row a
-- second time" (or a raw 23505 for a custom name). A row-level BEFORE
-- trigger sees the rows earlier in the same statement, so it catches the
-- second one. Done here rather than in those RPCs so it holds whichever
-- migration last redefines them (0024 replaces create_project).
create or replace function ship.refuse_duplicate_discipline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from ship.project_consultants pc
     where pc.project_id = new.project_id
       and lower(pc.consultant_type) = lower(new.consultant_type)
       and (tg_op = 'INSERT' or pc.id <> new.id)
  ) then
    raise exception 'The discipline "%" is listed more than once.', new.consultant_type
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function ship.refuse_duplicate_discipline() from public, anon, authenticated;

-- "ab_" sorts after "aa_canonical_type": it must see the canonical name.
drop trigger if exists project_consultants_ab_refuse_duplicate on ship.project_consultants;
create trigger project_consultants_ab_refuse_duplicate
  before insert or update of consultant_type on ship.project_consultants
  for each row execute function ship.refuse_duplicate_discipline();

drop trigger if exists project_consultants_aa_canonical_type on ship.project_consultants;
create trigger project_consultants_aa_canonical_type
  before insert or update of consultant_type on ship.project_consultants
  for each row execute function ship.canonicalize_consultant_type();

drop trigger if exists project_members_aa_canonical_type on ship.project_members;
create trigger project_members_aa_canonical_type
  before insert or update of consultant_type on ship.project_members
  for each row execute function ship.canonicalize_consultant_type();

create unique index if not exists project_consultants_project_lower_type_key
  on ship.project_consultants (project_id, lower(consultant_type));

-- ---------------------------------------------------------------------
-- 3. Prefixes
-- ---------------------------------------------------------------------
create table if not exists ship.project_discipline_prefixes (
  project_id     text not null references ship.projects(id) on delete cascade,
  discipline_key text not null check (discipline_key = lower(discipline_key) and discipline_key <> ''),
  discipline     text not null,
  prefix         text not null check (prefix ~ '^[A-Z]{1,6}$'),
  created_at     timestamptz not null default now(),
  primary key (project_id, discipline_key),
  unique (project_id, prefix)
);

-- Internal bookkeeping, like the number counters: no client access.
alter table ship.project_discipline_prefixes enable row level security;
revoke all on table ship.project_discipline_prefixes from public, anon, authenticated;

-- Known disciplines (and Admin) only; NULL for anything else.
create or replace function ship.builtin_discipline_prefix(p_discipline text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case upper(ship.canonical_discipline(p_discipline))
           when 'ARCHITECTURE'          then 'A'
           when 'ACCESSIBILITY'         then 'AC'
           when 'CIVIL'                 then 'C'
           when 'ELECTRICAL'            then 'E'
           when 'ENVELOPE'              then 'EN'
           when 'FIRE ALARM'            then 'FA'
           when 'HAZARDOUS MATERIALS'   then 'HM'
           when 'HISTORIC PRESERVATION' then 'HP'
           when 'LANDSCAPE'             then 'L'
           when 'MECHANICAL'            then 'M'
           when 'PLUMBING'              then 'P'
           when 'STRUCTURAL'            then 'S'
           when 'SECURITY'              then 'SE'
           when 'TELECOM'               then 'T'
           when 'ADMIN'                 then 'AD'
           else null
         end
$$;

-- Ordered candidate prefixes for a custom discipline name.
create or replace function ship.custom_prefix_candidates(p_discipline text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_words   text[];
  v_letters text;
  v_base    text;
  v_out     text[] := '{}';
  v_k       integer;
  v_a       integer;
  v_b       integer;
begin
  v_words := array_remove(
    regexp_split_to_array(btrim(regexp_replace(upper(coalesce(p_discipline, '')), '[^A-Z]+', ' ', 'g')), ' '),
    '');

  if coalesce(array_length(v_words, 1), 0) = 0 then
    v_words := array['X'];
  end if;

  v_letters := array_to_string(v_words, '');

  if array_length(v_words, 1) >= 2 then
    v_base := '';
    for v_k in 1 .. least(array_length(v_words, 1), 4) loop
      v_base := v_base || left(v_words[v_k], 1);
    end loop;
  else
    v_base := left(v_words[1], 2);
  end if;

  v_out := v_out || v_base;

  -- Grow from the name's own letters: ACOUSTICS -> ACO, ACOU, ...
  for v_k in char_length(v_base) + 1 .. least(char_length(v_letters), 6) loop
    v_out := v_out || left(v_letters, v_k);
  end loop;

  -- Base + one letter.
  for v_a in 0 .. 25 loop
    v_out := v_out || (left(v_base, 5) || chr(65 + v_a));
  end loop;

  -- Last resort: X + two letters (676 more).
  for v_a in 0 .. 25 loop
    for v_b in 0 .. 25 loop
      v_out := v_out || ('X' || chr(65 + v_a) || chr(65 + v_b));
    end loop;
  end loop;

  return v_out;
end;
$$;

-- LOOKUP ONLY: the prefix item numbers use for p_discipline in
-- p_project_id, or NULL when a custom discipline has never been on the
-- project's roster. Never allocates.
create or replace function ship.project_discipline_prefix(p_project_id text, p_discipline text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    ship.builtin_discipline_prefix(p_discipline),
    (select dp.prefix
       from ship.project_discipline_prefixes dp
      where dp.project_id = p_project_id
        and dp.discipline_key = lower(ship.canonical_discipline(p_discipline))))
$$;

-- ALLOCATES (and stores for good) a prefix for a custom discipline. Only
-- called from the roster trigger below.
create or replace function ship.allocate_discipline_prefix(p_project_id text, p_discipline text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_builtin   text;
  v_name      text;
  v_key       text;
  v_prefix    text;
  v_candidate text;
  v_attempt   integer := 0;
  c_reserved  constant text[] := array['A','AC','C','E','EN','FA','HM','HP','L','M','P','S','SE','T','AD','PP'];
begin
  v_builtin := ship.builtin_discipline_prefix(p_discipline);
  if v_builtin is not null then
    return v_builtin;
  end if;

  v_name := ship.canonical_discipline(p_discipline);
  v_key  := lower(v_name);
  if v_key = '' then
    return null;
  end if;

  loop
    select dp.prefix into v_prefix
      from ship.project_discipline_prefixes dp
     where dp.project_id = p_project_id
       and dp.discipline_key = v_key;
    if found then
      return v_prefix;
    end if;

    select cand into v_candidate
      from unnest(ship.custom_prefix_candidates(v_name)) with ordinality as t(cand, ord)
     where not (cand = any (c_reserved))
       and not exists (
         select 1 from ship.project_discipline_prefixes dp
          where dp.project_id = p_project_id
            and dp.prefix = t.cand)
     order by ord
     limit 1;

    if v_candidate is null then
      raise exception 'allocate_discipline_prefix: no free prefix for % in project %', v_name, p_project_id
        using errcode = '55000';
    end if;

    -- A concurrent allocation of the same key or the same prefix makes
    -- this a no-op; the loop then re-reads and retries.
    insert into ship.project_discipline_prefixes (project_id, discipline_key, discipline, prefix)
    values (p_project_id, v_key, v_name, v_candidate)
    on conflict do nothing
    returning prefix into v_prefix;

    if v_prefix is not null then
      return v_prefix;
    end if;

    v_attempt := v_attempt + 1;
    if v_attempt > 50 then
      raise exception 'allocate_discipline_prefix: could not allocate a prefix for % in project %', v_name, p_project_id
        using errcode = '55000';
    end if;
  end loop;
end;
$$;

revoke all on function ship.builtin_discipline_prefix(text)          from public, anon;
grant execute on function ship.builtin_discipline_prefix(text)       to authenticated;
revoke all on function ship.custom_prefix_candidates(text)           from public, anon, authenticated;
revoke all on function ship.project_discipline_prefix(text, text)    from public, anon, authenticated;
revoke all on function ship.allocate_discipline_prefix(text, text)   from public, anon, authenticated;

-- Allocate as soon as a custom discipline joins a roster, so prefixes
-- follow the order disciplines were added.
create or replace function ship.assign_consultant_prefix()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ship.allocate_discipline_prefix(new.project_id, new.consultant_type);
  return null;
end;
$$;

revoke all on function ship.assign_consultant_prefix() from public, anon, authenticated;

drop trigger if exists project_consultants_zz_assign_prefix on ship.project_consultants;
create trigger project_consultants_zz_assign_prefix
  after insert or update of consultant_type on ship.project_consultants
  for each row execute function ship.assign_consultant_prefix();

-- ---------------------------------------------------------------------
-- 4. normalize_line_item: 0003's body, plus canonical disciplines.
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
-- 5. Numbering: 0014's body; project-aware prefix, never allocates.
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

