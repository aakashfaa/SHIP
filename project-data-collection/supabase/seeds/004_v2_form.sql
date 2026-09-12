-- =====================================================================
-- 004_v2_form.sql
-- Fixture line-item forms for the form builder (Settings > "Line item
-- form").
--
-- Runs after 001/002/003 (glob order), which is what creates
-- ship.projects and the taxonomy rows this inherits options from.
--
-- WHY THIS IS A SEED AND NOT PART OF MIGRATION 0012
-- -------------------------------------------------
-- 0012 backfills every existing project with the default form. On a
-- database with real history that is exactly right. On a fresh one it is
-- a no-op, because the CLI applies migrations BEFORE seeds and
-- ship.projects is still empty when 0012 runs. Same reason
-- 002_v2_phases.sql and 003_v2_taxonomy.sql exist.
--
-- It inserts directly rather than calling ship.seed_default_form(): seeds
-- run as the postgres superuser, where auth.uid() is null, so that
-- function's can_edit_project() gate would raise 42501.
--
-- WHAT IT IS SHAPED TO DEMONSTRATE
-- --------------------------------
-- The default form on every project, plus -- on the fixture project only
-- -- two CUSTOM fields and one hidden built-in, so that a screenshot
-- shows the three states that matter and the "additive" claim is visible
-- rather than asserted:
--
--   * a custom select with its own options    (storage = 'custom')
--   * a custom date field                     (a type no built-in uses)
--   * a built-in hidden rather than deleted   (is_hidden, not a DELETE)
--
-- Idempotent throughout.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Every project gets the default form, cross-joined the same way 0012's
-- backfill does.
-- ---------------------------------------------------------------------
insert into ship.form_fields
  (project_id, key, label, help_text, input_type, storage, group_label,
   sort_order, is_required, is_builtin)
select p.id, d.key, d.label, d.help_text, d.input_type, 'column',
       d.group_label, d.sort_order, d.is_required, true
  from ship.projects p
  cross join ship.default_form_fields() d
on conflict (project_id, key) do nothing;

-- Fixed option sets for the selects that are still CHECK-constrained.
insert into ship.form_field_options (field_id, value, label, sort_order)
select f.id, o.value, o.value, o.sort_order
  from ship.default_form_field_options() o
  join ship.form_fields f on f.key = o.field_key
on conflict (field_id, value) do nothing;

-- Taxonomy-backed selects inherit what 003_v2_taxonomy.sql created,
-- including the value it archived. Archived stays archived -- that is the
-- state the Settings UI needs a subject for.
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
on conflict (field_id, value) do nothing;

-- ---------------------------------------------------------------------
-- Two custom fields on the fixture project.
--
-- These are the whole point of the feature: questions this firm wants to
-- ask that no built-in covers. They are plausible rather than decorative
-- -- a warranty expiry and a funding source are the kind of thing that
-- actually gets tracked against capital scope, and neither has anywhere
-- to live in the 24 built-in fields.
--
-- sort_order 250+ puts them after every built-in, which is where an
-- added field naturally belongs until someone reorders it.
-- ---------------------------------------------------------------------
insert into ship.form_fields
  (project_id, key, label, help_text, input_type, storage, group_label,
   sort_order, is_required, is_builtin)
select 'federal-campus-master-plan', 'funding_source',
       'Funding source',
       'Which programme this scope would be funded from, if known.',
       'select', 'custom', 'Synergies and notes', 250, false, false
where not exists (
  select 1 from ship.form_fields
   where project_id = 'federal-campus-master-plan' and key = 'funding_source'
);

insert into ship.form_field_options (field_id, value, label, sort_order)
select f.id, v.value, v.value, v.sort_order
  from ship.form_fields f
  cross join (values
    ('Capital appropriation', 10),
    ('Deferred maintenance fund', 20),
    ('Utility incentive', 30),
    ('Federal grant', 40),
    ('Unfunded', 50)
  ) as v(value, sort_order)
 where f.project_id = 'federal-campus-master-plan'
   and f.key = 'funding_source'
on conflict (field_id, value) do nothing;

insert into ship.form_fields
  (project_id, key, label, help_text, input_type, storage, group_label,
   sort_order, is_required, is_builtin)
select 'federal-campus-master-plan', 'warranty_expiry',
       'Warranty expiry',
       'For end-of-life items already under warranty.',
       'date', 'custom', 'Synergies and notes', 260, false, false
where not exists (
  select 1 from ship.form_fields
   where project_id = 'federal-campus-master-plan' and key = 'warranty_expiry'
);

-- ---------------------------------------------------------------------
-- One built-in hidden rather than deleted.
--
-- 'electrification_eo594' names a Massachusetts executive order. It is
-- exactly the sort of field that is essential to one client and noise to
-- the next, which makes it the honest example of what hiding is for --
-- and 0012's guard trigger means hiding is the ONLY thing you can do to
-- it, because a real column and the code reading it are on the other end.
-- ---------------------------------------------------------------------
update ship.form_fields
   set is_hidden = true
 where project_id = 'federal-campus-master-plan'
   and key = 'electrification_eo594';

-- ---------------------------------------------------------------------
-- Values for the custom fields on a few existing line items, so the
-- Master View has something in the new columns rather than a blank strip.
-- ---------------------------------------------------------------------
update ship.line_items
   set custom_fields = jsonb_build_object(
         'funding_source',
         case (abs(hashtext(item_number)) % 4)
           when 0 then 'Capital appropriation'
           when 1 then 'Deferred maintenance fund'
           when 2 then 'Utility incentive'
           else        'Unfunded'
         end)
 where project_id = 'federal-campus-master-plan'
   and custom_fields = '{}'::jsonb;

commit;
