-- =====================================================================
-- 0025_replace_chunk_phases.sql
-- SHIP -- replace a package's phases in ONE transaction.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0024. Additive; nothing earlier is edited.
--
-- WHY
-- ---
-- The project has one phase template (0024), applied to every package:
-- when a package is created, and to all of them when the template changes.
-- The client used to do that as a DELETE then an INSERT. If the insert
-- failed the package was left with no phases at all, and a package with
-- no phases prices at $0 on the Timeline and in the export -- the worst
-- kind of wrong, because it looks like an answer.
--
-- ship.replace_chunk_phases(p_chunk_id, p_phases) does both inside the
-- function, so any failure (validation, a constraint, a foreign key)
-- rolls back the delete too and the old phases stay exactly as they were.
--
-- AUTHORITY: ship.can_edit_chunk() -- the same check as the
-- chunk_phases insert policy and the edit-set the update/delete policies
-- use (0009): admins and editors of the package's project. Consultants
-- and viewers are refused (42501). SECURITY DEFINER only so the delete
-- and insert run as one unit; the check is done here, first.
--
-- PAYLOAD: a JSON array (1-50 entries) of
--   { name, kind, sort_order, pct_of_tpc, start_month, duration_months,
--     duration_locked, template_step_id }
-- name non-blank (<= 200 chars); kind one of study/design/construction/
-- closeout; pct_of_tpc 0-100; start_month a whole number >= 0;
-- duration_months a whole number >= 1; template_step_id null or a step
-- of a template this project can see (built-in or its own). Months are
-- stored in start_slot / duration_slots (0020 kept the column names).
-- Anything else is refused with 22023 before a row is touched.
--
-- Dependency links on the old phases go with them (ON DELETE CASCADE on
-- phase_dependencies, 0007), exactly as a phase delete always did.
--
-- RETURNS the new rows (callers sort by sort_order).
-- =====================================================================

begin;

create or replace function ship.replace_chunk_phases(
  p_chunk_id uuid,
  p_phases   jsonb
)
returns setof ship.chunk_phases
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id text;
  v_phase      jsonb;
  v_name       text;
  v_kind       text;
  v_pct        numeric;
  v_start      numeric;
  v_duration   numeric;
  v_step       uuid;
begin
  select c.project_id into v_project_id
    from ship.chunk_projects c
   where c.id = p_chunk_id;

  -- An unknown package and one you cannot edit look the same from here.
  if v_project_id is null or not coalesce(ship.can_edit_chunk(p_chunk_id), false) then
    raise exception 'ship.replace_chunk_phases: edit access to this package required'
      using errcode = '42501';
  end if;

  if p_phases is null or jsonb_typeof(p_phases) <> 'array' then
    raise exception 'ship.replace_chunk_phases: p_phases must be a JSON array'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_phases) < 1 or jsonb_array_length(p_phases) > 50 then
    raise exception 'ship.replace_chunk_phases: between 1 and 50 phases required, got %',
      jsonb_array_length(p_phases)
      using errcode = '22023';
  end if;

  -- Validate everything before touching a row.
  for v_phase in select value from jsonb_array_elements(p_phases)
  loop
    if jsonb_typeof(v_phase) <> 'object' then
      raise exception 'ship.replace_chunk_phases: every phase must be an object'
        using errcode = '22023';
    end if;

    v_name := btrim(coalesce(v_phase ->> 'name', ''));
    if v_name = '' or length(v_name) > 200 then
      raise exception 'ship.replace_chunk_phases: a phase name must be 1-200 characters'
        using errcode = '22023';
    end if;

    v_kind := v_phase ->> 'kind';
    if v_kind is null or v_kind not in ('study', 'design', 'construction', 'closeout') then
      raise exception 'ship.replace_chunk_phases: unknown phase kind %', coalesce(v_kind, 'null')
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_phase -> 'pct_of_tpc') <> 'number'
       or jsonb_typeof(v_phase -> 'start_month') <> 'number'
       or jsonb_typeof(v_phase -> 'duration_months') <> 'number'
       or jsonb_typeof(v_phase -> 'sort_order') <> 'number' then
      raise exception 'ship.replace_chunk_phases: pct_of_tpc, start_month, duration_months and sort_order must be numbers'
        using errcode = '22023';
    end if;

    v_pct      := (v_phase ->> 'pct_of_tpc')::numeric;
    v_start    := (v_phase ->> 'start_month')::numeric;
    v_duration := (v_phase ->> 'duration_months')::numeric;

    if v_pct < 0 or v_pct > 100 then
      raise exception 'ship.replace_chunk_phases: pct_of_tpc must be 0-100, got %', v_pct
        using errcode = '22023';
    end if;
    if v_start < 0 or v_start <> trunc(v_start) then
      raise exception 'ship.replace_chunk_phases: start_month must be a whole number >= 0, got %', v_start
        using errcode = '22023';
    end if;
    if v_duration < 1 or v_duration <> trunc(v_duration) then
      raise exception 'ship.replace_chunk_phases: duration_months must be a whole number >= 1, got %', v_duration
        using errcode = '22023';
    end if;

    if (v_phase ->> 'sort_order')::numeric <> trunc((v_phase ->> 'sort_order')::numeric)
       or (v_phase ->> 'sort_order')::numeric < 0 then
      raise exception 'ship.replace_chunk_phases: sort_order must be a whole number >= 0'
        using errcode = '22023';
    end if;

    if v_phase ? 'duration_locked'
       and jsonb_typeof(v_phase -> 'duration_locked') not in ('boolean', 'null') then
      raise exception 'ship.replace_chunk_phases: duration_locked must be a boolean'
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_phase -> 'template_step_id') = 'string' then
      v_step := (v_phase ->> 'template_step_id')::uuid;
      if not exists (
        select 1
          from ship.phase_template_steps s
          join ship.phase_templates t on t.id = s.template_id
         where s.id = v_step
           and (t.project_id is null or t.project_id = v_project_id)
      ) then
        raise exception 'ship.replace_chunk_phases: template step % is not available to this project', v_step
          using errcode = '22023';
      end if;
    end if;
  end loop;

  delete from ship.chunk_phases where chunk_project_id = p_chunk_id;

  return query
  insert into ship.chunk_phases
    (chunk_project_id, template_step_id, name, kind, sort_order,
     pct_of_tpc, start_slot, duration_slots, duration_locked)
  select p_chunk_id,
         case when jsonb_typeof(e.value -> 'template_step_id') = 'string'
              then (e.value ->> 'template_step_id')::uuid end,
         btrim(e.value ->> 'name'),
         e.value ->> 'kind',
         (e.value ->> 'sort_order')::integer,
         (e.value ->> 'pct_of_tpc')::numeric,
         (e.value ->> 'start_month')::numeric,
         (e.value ->> 'duration_months')::numeric,
         coalesce((e.value ->> 'duration_locked')::boolean, false)
    from jsonb_array_elements(p_phases) with ordinality as e(value, ord)
   order by e.ord
  returning *;
end;
$$;

revoke all on function ship.replace_chunk_phases(uuid, jsonb) from public, anon;
grant execute on function ship.replace_chunk_phases(uuid, jsonb) to authenticated;

commit;
