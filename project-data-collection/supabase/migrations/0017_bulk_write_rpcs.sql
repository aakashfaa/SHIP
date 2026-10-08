-- =====================================================================
-- 0017_bulk_write_rpcs.sql
-- SHIP -- reorder form fields and dropdown options in one statement.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0016. Additive; nothing earlier is edited.
--
-- WHAT THIS FIXES (pre-launch audit master ID)
-- --------------------------------------------
-- M-18  Every up/down arrow in the Form Builder failed with
--       `null value in column "key" ... violates not-null constraint`.
--       lib/store.ts reordered with `upsert([{id, project_id,
--       sort_order}], {onConflict: 'id'})`, which PostgREST compiles to
--       INSERT ... ON CONFLICT DO UPDATE -- and Postgres checks NOT NULL
--       on the proposed INSERT row (no key/label/input_type, no option
--       value) before it ever looks at the conflict. 100% reproducible.
--
--       These two RPCs do the reorder as one UPDATE ... FROM unnest(...)
--       WITH ORDINALITY: atomic, one round trip, and no partial rows.
--
--       SECURITY INVOKER on purpose: the caller's own RLS
--       (form_fields_update / form_field_options_update, i.e.
--       can_edit_project) decides what they may reorder, exactly as it
--       did for the per-row writes. If any listed id is not updated --
--       it does not exist, belongs to another project/field, or RLS hid
--       it -- the whole call raises and nothing changes.
--
-- CONTRACT
--   ship.reorder_form_fields(p_project_id text, p_ids uuid[]) returns void
--   ship.reorder_field_options(p_field_id uuid, p_ids uuid[]) returns void
--     p_ids in the desired display order; sort_order becomes
--     10, 20, 30, ... (the spacing seed_default_form uses, so a later
--     insert can slot in between without renumbering).
-- =====================================================================

begin;

create or replace function ship.reorder_form_fields(p_project_id text, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expected integer;
  v_updated  integer;
begin
  select count(distinct id) into v_expected from unnest(coalesce(p_ids, '{}'::uuid[])) as t(id);

  if v_expected <> coalesce(cardinality(p_ids), 0) then
    raise exception 'reorder_form_fields: an id is listed more than once' using errcode = '22023';
  end if;

  if v_expected = 0 then
    return;
  end if;

  update ship.form_fields f
     set sort_order = (o.ord * 10)::integer
    from unnest(p_ids) with ordinality as o(id, ord)
   where f.id = o.id
     and f.project_id = p_project_id;

  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception 'reorder_form_fields: % of % fields could not be reordered (not in project %, or no edit access)',
      v_expected - v_updated, v_expected, p_project_id
      using errcode = '42501';
  end if;
end;
$$;

create or replace function ship.reorder_field_options(p_field_id uuid, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expected integer;
  v_updated  integer;
begin
  select count(distinct id) into v_expected from unnest(coalesce(p_ids, '{}'::uuid[])) as t(id);

  if v_expected <> coalesce(cardinality(p_ids), 0) then
    raise exception 'reorder_field_options: an id is listed more than once' using errcode = '22023';
  end if;

  if v_expected = 0 then
    return;
  end if;

  update ship.form_field_options o
     set sort_order = (x.ord * 10)::integer
    from unnest(p_ids) with ordinality as x(id, ord)
   where o.id = x.id
     and o.field_id = p_field_id;

  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception 'reorder_field_options: % of % options could not be reordered (not on this field, or no edit access)',
      v_expected - v_updated, v_expected
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function ship.reorder_form_fields(text, uuid[])   from public, anon;
revoke all on function ship.reorder_field_options(uuid, uuid[]) from public, anon;
grant execute on function ship.reorder_form_fields(text, uuid[])   to authenticated;
grant execute on function ship.reorder_field_options(uuid, uuid[]) to authenticated;

commit;
