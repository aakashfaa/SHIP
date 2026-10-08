-- =====================================================================
-- 0028_trim_default_form.sql
-- SHIP -- drop the unused questions; show what the cost tiers mean.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0027. Additive; supersedes the 0026 seeding.
--
-- 1. REMOVED questions. Operating cost impact, Electrification (EO594)
--    and Energy notes are read by no calculation, total or export figure
--    (checked: only the form, Add Data and the column catalog touch them).
--    They are taken out of the form builder the same way its Remove button
--    does it: is_hidden = true plus config.removed = true. The row stays --
--    the database refuses to delete a built-in field, and every value
--    already entered is kept -- but the question is gone from the form,
--    Master View and the exports. Applied to EVERY project and to every
--    project created from now on.
--
--    Annual utility cost saving stays merely HIDDEN: it feeds the package
--    "annual cost savings" total on the Timeline summary and the Excel
--    Packages sheet (never a cost figure), so an admin may want it back.
--
-- 2. Relative first cost tiers carry their meaning. The stored values are
--    pinned by line_items_relative_first_cost_check ($LOW / $$Moderate /
--    $$$High) and are not touched; only the option LABEL, which is what
--    every screen and export shows, changes. Ranges are from the SHIP
--    Options Matrix: $ < $250,000 ; $$ $250,000 to $5M ; $$$ $5M+.
--
-- NOTE the $fn$ tag: the tier values contain '$$', which would end a $$ body.
-- seed_default_form(): 0026's body, plus the removal marker and the tier
-- labels. Existing rows keep winning (ON CONFLICT DO NOTHING); the backfill
-- below brings existing projects in line.
-- =====================================================================

create or replace function ship.seed_default_form(p_project_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not ship.can_edit_project(p_project_id) then
    raise exception 'ship.seed_default_form: edit access to project % required', p_project_id
      using errcode = '42501';
  end if;

  insert into ship.form_fields
    (project_id, key, label, help_text, input_type, storage, group_label,
     sort_order, is_required, is_builtin, is_hidden, config)
  select p_project_id, d.key, d.label, d.help_text, d.input_type, 'column',
         d.group_label, d.sort_order, d.is_required, true,
         d.key = any (array['annual_cost_savings', 'energy_notes',
                            'relative_operation_cost_impact', 'electrification_eo594']),
         case when d.key = any (array['energy_notes', 'relative_operation_cost_impact',
                                      'electrification_eo594'])
              then '{"removed": true}'::jsonb else '{}'::jsonb end
    from ship.default_form_fields() d
  on conflict (project_id, key) do nothing;

  insert into ship.form_field_options (field_id, value, label, sort_order)
  select f.id, o.value,
         case when o.field_key = 'relative_first_cost' and o.value = '$LOW'       then '$LOW (under $250,000)'
              when o.field_key = 'relative_first_cost' and o.value = '$$Moderate' then '$$Moderate ($250,000 to $5M)'
              when o.field_key = 'relative_first_cost' and o.value = '$$$High'    then '$$$High ($5M+)'
              else o.value end,
         o.sort_order
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
$fn$;

revoke all    on function ship.seed_default_form(text) from public;
grant execute on function ship.seed_default_form(text) to authenticated;

-- ---------------------------------------------------------------------
-- Backfill every existing project.
-- ---------------------------------------------------------------------
update ship.form_fields
   set is_hidden = true,
       config = coalesce(config, '{}'::jsonb) || '{"removed": true}'::jsonb
 where is_builtin
   and key in ('energy_notes', 'relative_operation_cost_impact', 'electrification_eo594')
   and not (is_hidden and coalesce(config ->> 'removed', '') = 'true');

update ship.form_field_options o
   set label = case o.value
                 when '$LOW'       then '$LOW (under $250,000)'
                 when '$$Moderate' then '$$Moderate ($250,000 to $5M)'
                 when '$$$High'    then '$$$High ($5M+)'
               end
  from ship.form_fields f
 where o.field_id = f.id
   and f.key = 'relative_first_cost'
   and o.value in ('$LOW', '$$Moderate', '$$$High')
   and o.label is distinct from case o.value
                 when '$LOW'       then '$LOW (under $250,000)'
                 when '$$Moderate' then '$$Moderate ($250,000 to $5M)'
                 when '$$$High'    then '$$$High ($5M+)'
               end;
