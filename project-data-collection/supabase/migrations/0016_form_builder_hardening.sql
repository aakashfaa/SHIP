-- =====================================================================
-- 0016_form_builder_hardening.sql
-- SHIP -- only the seeder makes built-in form fields, and projects can be
-- deleted again.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0015. Additive; nothing earlier is edited.
--
-- WHAT THIS FIXES (pre-launch audit master IDs)
-- ---------------------------------------------
-- M-14  0012's comment says "the seeder is the only thing that creates
--       built-ins", but the insert policy only checked can_edit_project.
--       An editor could insert {is_builtin: true, storage: 'column',
--       key: 'user_email'} (or 'no_such_column') -- verified live, 201 --
--       which (a) turned a system column into an editable form input,
--       (b) pointed the form at columns that do not exist, (c) squatted a
--       real key so seed_default_form's ON CONFLICT DO NOTHING could never
--       create the real one, and (d) could not then be deleted, because
--       guard_form_field() protects built-ins.
--
--       Now:
--       * The INSERT policy only admits is_builtin = false and
--         storage = 'custom' from `authenticated`. The SECURITY DEFINER
--         seeder (seed_default_form, run as the table owner) bypasses RLS
--         and remains the only way to create a built-in.
--       * A trigger refuses any storage='column' row whose key is not a
--         real, user-editable line_items column (the same allowlist
--         apply_suggestion() uses: ship.suggestable_line_item_columns()).
--       * guard_form_field() refuses turning an existing custom field into
--         a built-in / column field, and moving a built-in to another
--         project.
--       * Forged rows already in the table are removed or repaired below.
--
-- M-37  (medium; one line in the same function) Projects could not be
--       deleted at all: the FK cascade from projects -> form_fields fired
--       guard_form_field()'s "built-in field cannot be deleted" for every
--       built-in. The guard now lets a delete through when the parent
--       project no longer exists, i.e. when it IS the cascade. A forged
--       built-in (key not on the allowlist) is also deletable, so any
--       that slip through are recoverable without superuser access.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Guard: cascade-aware delete, no promotion to built-in.
--    SECURITY DEFINER so the "does the project still exist" probe is not
--    subject to the caller's RLS.
-- ---------------------------------------------------------------------
create or replace function ship.guard_form_field()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_builtin then
      -- M-37: the project row is already gone -> this is the
      -- projects -> form_fields ON DELETE CASCADE. Let it through.
      if not exists (select 1 from ship.projects p where p.id = old.project_id) then
        return old;
      end if;

      -- M-14: a "built-in" whose key is not a real column was forged
      -- before 0016; it protects nothing, so it may go.
      if not (old.key = any (ship.suggestable_line_item_columns())) then
        return old;
      end if;

      raise exception 'form_fields: "%" is a built-in field and cannot be deleted. Hide it instead.', old.key
        using errcode = '42501',
              hint = 'Built-in fields map to a real line_items column that the cost and energy engines read.';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.is_builtin then
    if new.key <> old.key then
      raise exception 'form_fields: cannot rename the key of built-in field "%"', old.key
        using errcode = '42501',
              hint = 'Change the label instead -- the key is the column name.';
    end if;
    if new.input_type <> old.input_type then
      raise exception 'form_fields: cannot change the input type of built-in field "%"', old.key
        using errcode = '42501';
    end if;
    if new.storage <> old.storage or new.is_builtin <> old.is_builtin then
      raise exception 'form_fields: cannot change the storage of built-in field "%"', old.key
        using errcode = '42501';
    end if;
    if new.project_id <> old.project_id then
      raise exception 'form_fields: cannot move built-in field "%" to another project', old.key
        using errcode = '42501';
    end if;
  elsif new.is_builtin or new.storage <> 'custom' then
    -- M-14: a custom field cannot be promoted into a built-in/column one.
    raise exception 'form_fields: "%" is a custom field and cannot become a built-in one', old.key
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function ship.guard_form_field() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Column-backed keys must name a real, user-editable column (M-14).
-- ---------------------------------------------------------------------
create or replace function ship.check_form_field_column_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.storage = 'column'
     and not (new.key = any (ship.suggestable_line_item_columns())) then
    raise exception 'form_fields: "%" is not a line item column a form can write', new.key
      using errcode = '23514',
            hint = 'Add it as a custom field instead (storage = custom).';
  end if;
  return new;
end;
$$;

revoke all on function ship.check_form_field_column_key() from public, anon, authenticated;

drop trigger if exists form_fields_check_column_key on ship.form_fields;
create trigger form_fields_check_column_key
  before insert or update of key, storage on ship.form_fields
  for each row execute function ship.check_form_field_column_key();

-- ---------------------------------------------------------------------
-- 3. Only the seeder creates built-ins (M-14).
-- ---------------------------------------------------------------------
drop policy if exists form_fields_insert on ship.form_fields;
create policy form_fields_insert on ship.form_fields
  for insert to authenticated
  with check (
    (select ship.can_edit_project(project_id))
    and not is_builtin
    and storage = 'custom'
  );

-- ---------------------------------------------------------------------
-- 4. Clean up rows forged before this migration.
-- ---------------------------------------------------------------------
do $$
declare
  v_deleted  integer;
  v_repaired integer;
begin
  -- (a) column-backed rows naming something that is not an editable
  --     column. The new guard lets these through.
  delete from ship.form_fields f
   where f.storage = 'column'
     and not (f.key = any (ship.suggestable_line_item_columns()));
  get diagnostics v_deleted = row_count;

  -- (b) built-ins on a real key but with the wrong input type (a forged
  --     row squatting the key before the seeder ran). Put the canonical
  --     type back so the form writes the column correctly. The guard
  --     forbids this from a client, so step around it here.
  alter table ship.form_fields disable trigger form_fields_guard;
  update ship.form_fields f
     set input_type = d.input_type
    from ship.default_form_fields() d
   where f.is_builtin
     and f.key = d.key
     and f.input_type <> d.input_type;
  get diagnostics v_repaired = row_count;
  alter table ship.form_fields enable trigger form_fields_guard;

  raise notice '0016: removed % forged column field(s), repaired % built-in input type(s)', v_deleted, v_repaired;
end;
$$;

commit;
