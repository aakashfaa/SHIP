-- =====================================================================
-- 0026_default_form_set.sql
-- SHIP -- new projects start with the State House question set.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0025. Additive; nothing earlier is edited.
--
-- WHY
-- ---
-- The State House Envelope Repairs Master View asked the original 21
-- questions (what / where / impacts / cost and energy rating / the five
-- Yes-No flags / synergies / notes). That is the set the client actually
-- answers, so it becomes the starting form for every NEW project.
--
--   shown:   the 21 original questions, plus annual_energy_savings, which
--            the builder will not let an admin remove (it drives the
--            Timeline energy chart -- lib/form-defaults.ts)
--   hidden:  annual_cost_savings, energy_notes
--
-- The two hidden ones are still created: they are real columns (the
-- database cannot delete them) and an admin can switch either back on in
-- the form builder. Nothing is lost, and Master View / exports only list a
-- question while it is shown.
--
-- SCOPE: ship.seed_default_form() only, and only for rows it inserts. The
-- ON CONFLICT DO NOTHING is unchanged, so every existing project keeps the
-- form it has. No backfill. CONTRACT unchanged: seed_default_form(text)
-- returns void, gated on can_edit_project().
-- =====================================================================

create or replace function ship.seed_default_form(p_project_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not ship.can_edit_project(p_project_id) then
    raise exception 'ship.seed_default_form: edit access to project % required', p_project_id
      using errcode = '42501';
  end if;

  insert into ship.form_fields
    (project_id, key, label, help_text, input_type, storage, group_label,
     sort_order, is_required, is_builtin, is_hidden)
  select p_project_id, d.key, d.label, d.help_text, d.input_type, 'column',
         d.group_label, d.sort_order, d.is_required, true,
         d.key = any (array['annual_cost_savings', 'energy_notes'])
    from ship.default_form_fields() d
  on conflict (project_id, key) do nothing;

  insert into ship.form_field_options (field_id, value, label, sort_order)
  select f.id, o.value, o.value, o.sort_order
    from ship.default_form_field_options() o
    join ship.form_fields f
      on f.project_id = p_project_id and f.key = o.field_key
  on conflict (field_id, value) do nothing;

  insert into ship.form_field_options (field_id, value, label, sort_order, is_archived)
  select f.id, t.value, t.value, t.sort_order, t.is_archived
    from ship.project_taxonomy_values t
    join ship.form_fields f
      on f.project_id = t.project_id
     and f.key = case t.kind
                   when 'building_area'     then 'building_area_impacted'
                   when 'building_level'    then 'building_level_impacted'
                   when 'category'          then 'category'
                   when 'timeline_priority' then 'timeline_priority'
                 end
   where t.project_id = p_project_id
  on conflict (field_id, value) do nothing;
end;
$$;

revoke all    on function ship.seed_default_form(text) from public;
grant execute on function ship.seed_default_form(text) to authenticated;
