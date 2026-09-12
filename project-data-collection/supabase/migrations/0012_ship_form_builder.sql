-- =====================================================================
-- 0012_ship_form_builder.sql
-- SHIP v2 -- the line-item form becomes data instead of code.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0011. Local stack only; not applied remotely.
--
-- THE PROBLEM
-- -----------
-- 0008 made the VALUES in four dropdowns per-project. It did not make the
-- FIELDS per-project, so the form is still one firm's questionnaire: 20
-- questions chosen for a state-house envelope study, in a fixed order,
-- with fixed labels, and no way to ask a 21st.
--
-- A practice that wants to record "Roof warranty expiry" or "Grant
-- eligible?" has nowhere to put it, and a practice that does not care
-- about "Electrification EO594" has no way to stop being asked. That
-- makes the vocabulary editor from 0008 close to pointless on its own --
-- being able to rename the wings of a building you were never going to
-- survey is not the problem anyone has.
--
-- WHAT THIS DOES
-- --------------
-- `form_fields` is the definition of a project's line-item form: one row
-- per question, carrying its label, input type, grouping and order.
-- `form_field_options` holds the choices for the ones that have choices.
-- Every existing field is seeded as a row, so the form a project sees on
-- the day this lands is byte-for-byte the form it saw the day before.
--
-- TWO KINDS OF FIELD, AND THE DIFFERENCE MATTERS
-- ----------------------------------------------
--   storage = 'column'  -- the value lives in a real line_items column.
--                          Every field that exists today. Code depends on
--                          these: ecc_amount is derived from
--                          estimated_first_cost, the energy chart reads
--                          annual_energy_savings, numbering reads
--                          discipline. They can be relabelled, reordered,
--                          regrouped and hidden. They cannot be deleted or
--                          have their input_type changed, because the
--                          column's type and the code reading it are not
--                          negotiable from a settings screen.
--
--   storage = 'custom'  -- the value lives in line_items.custom_fields,
--                          keyed by `key`. Fully editable and deletable.
--                          This is what "add two more fields" creates.
--
-- WHY JSONB FOR CUSTOM VALUES RATHER THAN AN EAV TABLE
-- ----------------------------------------------------
-- An `(line_item_id, field_id, value)` table is the textbook answer and
-- is wrong here. Every read of the Master View would become a pivot over
-- N rows per item, RLS would need a policy on a table whose tenant key is
-- two joins away, and the export would have to reassemble rows it had
-- just decomposed. The values are always read as a whole item and never
-- queried across items, which is exactly the shape jsonb is for. The
-- cost of that choice is no per-field type enforcement in the database --
-- see the validation trigger below, which does what it can.
--
-- THE ADDITIVE GUARANTEE
-- ----------------------
-- The client asked for this explicitly: "Let's say they have 10 different
-- fields right now. In the future, they add 2 more. That should add it,
-- not edit or delete everything else."
--
-- `ship.seed_default_form()` inserts ON CONFLICT (project_id, key) DO
-- NOTHING. It only ever adds fields that are missing. Run it against a
-- project whose form has been customised for a year and it will add any
-- field this release introduced and touch nothing else -- not a label
-- someone rewrote, not an order someone set, not a field someone hid.
-- That is also how a FUTURE built-in field ships: add one row to the
-- defaults below, and every existing project picks it up without a
-- data migration.
--
-- Re-runnable throughout.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- line_items.custom_fields
--
-- `{}` default rather than null so every read can assume an object and
-- no consumer has to write `coalesce(custom_fields, '{}')`.
-- ---------------------------------------------------------------------
alter table ship.line_items
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'line_items_custom_fields_object_ck') then
    alter table ship.line_items
      add constraint line_items_custom_fields_object_ck
      check (jsonb_typeof(custom_fields) = 'object');
  end if;
end
$$;

comment on column ship.line_items.custom_fields is
  'Values for form_fields rows with storage=''custom'', keyed by form_fields.key. Built-in fields live in their own columns -- see migration 0012.';

-- ---------------------------------------------------------------------
-- form_fields
--
-- `key` is the stable identifier and the thing everything else joins on.
-- For a built-in it IS the line_items column name, which is what lets the
-- client map a definition row onto a column without a lookup table.
--
-- `group_label` is the wizard step a field appears under. Free text on
-- purpose: a firm that wants five steps instead of seven should not need
-- a migration, and grouping carries no behaviour.
-- ---------------------------------------------------------------------
create table if not exists ship.form_fields (
  id           uuid primary key default gen_random_uuid(),
  project_id   text not null references ship.projects(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label        text not null check (btrim(label) <> ''),
  help_text    text not null default '',
  input_type   text not null check (input_type in (
                 'text', 'textarea', 'number', 'currency',
                 'select', 'multiselect', 'boolean', 'date')),
  storage      text not null default 'custom' check (storage in ('column', 'custom')),
  group_label  text not null default '',
  sort_order   integer not null default 0,
  is_required  boolean not null default false,
  is_hidden    boolean not null default false,
  -- Built-ins are seeded, not authored. The flag is what the delete and
  -- retype guards below key off.
  is_builtin   boolean not null default false,
  config       jsonb not null default '{}'::jsonb
                 check (jsonb_typeof(config) = 'object'),
  created_at   timestamptz not null default now(),
  unique (project_id, key)
);

create index if not exists form_fields_project_sort_idx
  on ship.form_fields (project_id, sort_order);

comment on table ship.form_fields is
  'Per-project definition of the line-item form. storage=''column'' fields map to a real line_items column of the same name; storage=''custom'' fields live in line_items.custom_fields. See migration 0012.';

-- A built-in must be column-backed and a custom field must not be. The
-- seeder is the only thing that creates built-ins, but the constraint
-- stops a client from minting one and claiming a column that does not
-- exist -- which the validation trigger would then try to read.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'form_fields_builtin_storage_ck') then
    alter table ship.form_fields
      add constraint form_fields_builtin_storage_ck
      check ((is_builtin and storage = 'column') or (not is_builtin and storage = 'custom'));
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- form_field_options
--
-- Supersedes project_taxonomy_values from 0008. Same idea -- a list of
-- allowed values with an order and a soft-delete -- but hung off a FIELD
-- rather than off one of four hardcoded `kind`s, which is the whole
-- point: a user-created "Grant programme" dropdown needs options too, and
-- 0008 had no way to give it any.
--
-- `is_archived` rather than delete, for the same reason as 0008: a value
-- already written onto line items cannot be withdrawn without those rows
-- failing their next validation.
-- ---------------------------------------------------------------------
create table if not exists ship.form_field_options (
  id          uuid primary key default gen_random_uuid(),
  field_id    uuid not null references ship.form_fields(id) on delete cascade,
  value       text not null check (btrim(value) <> ''),
  label       text not null default '',
  sort_order  integer not null default 0,
  is_archived boolean not null default false,
  unique (field_id, value)
);

create index if not exists form_field_options_field_sort_idx
  on ship.form_field_options (field_id, sort_order);

-- ---------------------------------------------------------------------
-- ship.default_form_fields()
--
-- The form as it exists in code today, transcribed. Order and
-- group_label reproduce AddDataTab's seven-step wizard exactly, so a
-- project seeded from this sees no change at all.
--
-- ADDING A BUILT-IN FIELD IN A FUTURE RELEASE: add a row here and ship a
-- migration that calls seed_default_form() for every project. The ON
-- CONFLICT DO NOTHING in the seeder means existing projects gain the new
-- field and keep every customisation they have made.
--
-- Columns deliberately absent because they are system-managed, not
-- questions: id, project_id, user_email, created_at, updated_at,
-- item_number, company_name, consultant_type, discipline (all filled by
-- the 0003 triggers) and ecc_amount (derived from estimated_first_cost
-- by the 0006 trigger).
-- ---------------------------------------------------------------------
create or replace function ship.default_form_fields()
returns table (
  key text, label text, help_text text, input_type text,
  group_label text, sort_order integer, is_required boolean
)
language sql
immutable
set search_path = ''
as $$
  values
    -- Step 1 -- identity
    ('name',              'Item name',        '', 'text',     'What is this item?',            10,  true),
    ('short_description', 'Short description','', 'textarea', 'What is this item?',            20,  false),

    -- Step 2 -- classification. Options for these four come from 0008's
    -- taxonomy, migrated into form_field_options below.
    ('category',                'Category',          '', 'select', 'Category and timeline',    30,  false),
    ('timeline_priority',       'Timeline priority', '', 'select', 'Category and timeline',    40,  false),

    -- Step 3 -- location
    ('building_area_impacted',  'Building area',     '', 'select', 'Where is it impacted?',    50,  false),
    ('building_level_impacted', 'Building level',    '', 'select', 'Where is it impacted?',    60,  false),

    -- Step 4 -- impact
    ('operational_impact', 'Operational impact', '', 'select', 'Operational and user impact',  70,  false),
    ('benefit_to_users',   'Benefit to users',   '', 'select', 'Operational and user impact',  80,  false),
    ('benefit_to_public',  'Benefit to public',  '', 'select', 'Operational and user impact',  90,  false),

    -- Step 5 -- cost and energy.
    -- estimated_first_cost is the input of record for ecc_amount, which
    -- every figure on the Timeline is built from.
    ('relative_first_cost',  'Relative first cost', '', 'select',   'Cost and energy',        100,  false),
    ('estimated_first_cost', 'Estimated first cost',
       'Un-escalated, in base-year dollars. Accepts 1.2m, 850k, $2,400,000.',
       'currency', 'Cost and energy', 110, false),
    ('relative_operation_cost_impact',   'Operating cost impact', '', 'select', 'Cost and energy', 120, false),
    ('relative_operational_energy_usage','Energy / emissions',    '', 'select', 'Cost and energy', 130, false),
    ('electrification_eo594',            'Electrification',       '', 'select', 'Cost and energy', 140, false),
    ('annual_energy_savings', 'Annual energy saving',
       'Per unit, in the project''s energy unit. Drives the reduction chart under the Timeline.',
       'number', 'Cost and energy', 150, false),
    ('annual_cost_savings',   'Annual utility cost saving', 'USD per year.', 'number', 'Cost and energy', 160, false),
    ('energy_notes',          'Energy notes',
       'Where the saving figure came from. A number with no provenance is not usable in a deliverable six months later.',
       'textarea', 'Cost and energy', 170, false),

    -- Step 6 -- strategic flags
    ('addressing_resiliency_sustainability', 'Addresses resiliency / sustainability', '', 'boolean', 'Strategic flags', 180, false),
    ('addressing_deferred_maintenance',      'Addresses deferred maintenance',        '', 'boolean', 'Strategic flags', 190, false),
    ('code_life_safety_improvement',         'Code / life-safety improvement',        '', 'boolean', 'Strategic flags', 200, false),
    ('accessibility_improvement',            'Accessibility improvement',             '', 'boolean', 'Strategic flags', 210, false),
    ('historic_impact',                      'Historic impact',                       '', 'boolean', 'Strategic flags', 220, false),

    -- Step 7 -- notes
    ('potential_synergies', 'Potential synergies', '', 'multiselect', 'Synergies and notes',  230, false),
    ('supporting_notes',    'Supporting notes',    '', 'textarea',    'Synergies and notes',  240, false)
$$;

revoke all    on function ship.default_form_fields() from public;
grant execute on function ship.default_form_fields() to authenticated;

-- ---------------------------------------------------------------------
-- Fixed option sets for the built-in selects that are NOT taxonomy-backed.
--
-- These four dropdowns were `CHECK` constraints in 0001 and are still
-- validated by them, so their options are seeded but a firm cannot add to
-- them without a migration. That is honest rather than ideal: offering an
-- "Add option" button that produces a value the database rejects on save
-- would be worse than not offering it. The UI marks them accordingly.
-- ---------------------------------------------------------------------
-- NOTE the $fn$ tag rather than a bare $$. Two of the relative-first-cost
-- values are literally '$$Moderate' and '$$$High', and a $$-quoted body ends
-- at the first $$ inside it -- which fails with a syntax error pointing at
-- "Moderate", several lines from the actual cause.
create or replace function ship.default_form_field_options()
returns table (field_key text, value text, sort_order integer)
language sql
immutable
set search_path = ''
as $fn$
  values
    ('operational_impact', 'NONE', 10), ('operational_impact', 'LOW', 20),
    ('operational_impact', 'MODERATE', 30), ('operational_impact', 'HIGH', 40),

    ('benefit_to_users', 'NONE', 10), ('benefit_to_users', 'LOW', 20),
    ('benefit_to_users', 'MODERATE', 30), ('benefit_to_users', 'HIGH', 40),

    ('benefit_to_public', 'NONE', 10), ('benefit_to_public', 'LOW', 20),
    ('benefit_to_public', 'MODERATE', 30), ('benefit_to_public', 'HIGH', 40),

    ('electrification_eo594', 'NONE', 10), ('electrification_eo594', 'LOW', 20),
    ('electrification_eo594', 'MODERATE', 30), ('electrification_eo594', 'HIGH', 40),

    ('relative_first_cost', '$LOW', 10), ('relative_first_cost', '$$Moderate', 20),
    ('relative_first_cost', '$$$High', 30),

    ('relative_operation_cost_impact', 'MINIMAL IMPACT', 10),
    ('relative_operation_cost_impact', 'MODERATE REDUCTION', 20),
    ('relative_operation_cost_impact', 'HIGH REDUCTION', 30),
    ('relative_operation_cost_impact', 'INCREASE', 40),
    ('relative_operation_cost_impact', 'N/A', 50),

    ('relative_operational_energy_usage', 'MINIMAL IMPACT', 10),
    ('relative_operational_energy_usage', 'MODERATE REDUCTION', 20),
    ('relative_operational_energy_usage', 'HIGH REDUCTION', 30),
    ('relative_operational_energy_usage', 'N/A', 40),

    ('potential_synergies', 'Architecture', 10), ('potential_synergies', 'Accessibility', 20),
    ('potential_synergies', 'Civil', 30), ('potential_synergies', 'Electrical', 40),
    ('potential_synergies', 'Envelope', 50), ('potential_synergies', 'Fire Alarm', 60),
    ('potential_synergies', 'Hazardous Materials', 70), ('potential_synergies', 'Historic Preservation', 80),
    ('potential_synergies', 'Landscape', 90), ('potential_synergies', 'Mechanical', 100),
    ('potential_synergies', 'Plumbing', 110), ('potential_synergies', 'Structural', 120),
    ('potential_synergies', 'Security', 130), ('potential_synergies', 'Telecom', 140)
$fn$;

revoke all    on function ship.default_form_field_options() from public;
grant execute on function ship.default_form_field_options() to authenticated;

-- ---------------------------------------------------------------------
-- ship.seed_default_form(project_id)
--
-- THE ADDITIVE OPERATION. Adds every default field the project does not
-- already have, and every default option those fields do not already
-- have. Never updates, never deletes.
--
-- Gated on can_edit_project() rather than is_admin(): this is the same
-- authority that edits the rest of the form, and a SECURITY DEFINER
-- function bypasses RLS entirely, so the check here IS the policy.
--
-- Safe to call repeatedly, including from createProject and from a future
-- migration that introduces a new built-in field.
-- ---------------------------------------------------------------------
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
     sort_order, is_required, is_builtin)
  select p_project_id, d.key, d.label, d.help_text, d.input_type, 'column',
         d.group_label, d.sort_order, d.is_required, true
    from ship.default_form_fields() d
  on conflict (project_id, key) do nothing;

  -- Fixed option sets for the non-taxonomy selects.
  insert into ship.form_field_options (field_id, value, label, sort_order)
  select f.id, o.value, o.value, o.sort_order
    from ship.default_form_field_options() o
    join ship.form_fields f
      on f.project_id = p_project_id and f.key = o.field_key
  on conflict (field_id, value) do nothing;

  -- Taxonomy-backed selects inherit whatever 0008 left in
  -- project_taxonomy_values for this project, including anything the firm
  -- added or archived. Archived stays archived.
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

-- ---------------------------------------------------------------------
-- Backfill every existing project.
--
-- Runs as the migration's owner, so it cannot call seed_default_form()
-- (that function's can_edit_project() check reads auth.uid(), which is
-- null here). The inserts are repeated inline instead -- same ON CONFLICT
-- DO NOTHING, same additive semantics.
--
-- On a FRESH database this is a no-op, because the CLI applies migrations
-- before seeds and ship.projects is still empty. Local fixture forms come
-- from seeds/004_v2_form.sql, exactly as 0007 and 0008 needed 002 and 003.
-- ---------------------------------------------------------------------
insert into ship.form_fields
  (project_id, key, label, help_text, input_type, storage, group_label,
   sort_order, is_required, is_builtin)
select p.id, d.key, d.label, d.help_text, d.input_type, 'column',
       d.group_label, d.sort_order, d.is_required, true
  from ship.projects p
  cross join ship.default_form_fields() d
on conflict (project_id, key) do nothing;

insert into ship.form_field_options (field_id, value, label, sort_order)
select f.id, o.value, o.value, o.sort_order
  from ship.default_form_field_options() o
  join ship.form_fields f on f.key = o.field_key
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
on conflict (field_id, value) do nothing;

-- ---------------------------------------------------------------------
-- ship.guard_form_field()  -- BEFORE UPDATE OR DELETE
--
-- Built-in fields are structural. A settings screen may rename one,
-- reorder it, regroup it or hide it; it may not delete one or change what
-- it is, because a real column and the code reading that column are on
-- the other end.
--
-- Without this, "delete field" on `estimated_first_cost` would leave the
-- column and its data in place but remove the only way to edit it, and
-- retyping `annual_energy_savings` from number to text would put strings
-- into a numeric column on the next save.
-- ---------------------------------------------------------------------
create or replace function ship.guard_form_field()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_builtin then
      raise exception 'form_fields: "%" is a built-in field and cannot be deleted. Hide it instead.', old.key
        using errcode = '42501',
              hint = 'Built-in fields map to a real line_items column that the cost and energy engines read.';
    end if;
    return old;
  end if;

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
  end if;

  return new;
end;
$$;

revoke all on function ship.guard_form_field() from public, anon, authenticated;

drop trigger if exists form_fields_guard on ship.form_fields;
create trigger form_fields_guard
  before update or delete on ship.form_fields
  for each row execute function ship.guard_form_field();

-- ---------------------------------------------------------------------
-- ship.taxonomy_value_allowed() -- repointed at form_field_options
--
-- 0008's validation trigger still guards the four taxonomy columns; it
-- now reads its allowed set from the form definition rather than from
-- project_taxonomy_values, so the two cannot disagree.
--
-- FAIL-OPEN ON ZERO ROWS is preserved deliberately, and for the same
-- reason 0008 gave: a project whose form has not been seeded, or a field
-- somebody hid before adding options, must not have line-item entry
-- bricked. This is a vocabulary, not a security boundary.
--
-- Archived options still VALIDATE -- archiving stops a value being
-- offered on new items, it does not invalidate items already carrying it.
-- ---------------------------------------------------------------------
create or replace function ship.taxonomy_value_allowed(
  p_project_id text, p_kind text, p_value text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      when p_value is null or btrim(p_value) = '' then true
      when not exists (
        select 1
          from ship.form_fields f
          join ship.form_field_options o on o.field_id = f.id
         where f.project_id = p_project_id
           and f.key = case p_kind
                         when 'building_area'     then 'building_area_impacted'
                         when 'building_level'    then 'building_level_impacted'
                         when 'category'          then 'category'
                         when 'timeline_priority' then 'timeline_priority'
                         else p_kind
                       end
      ) then true
      else exists (
        select 1
          from ship.form_fields f
          join ship.form_field_options o on o.field_id = f.id
         where f.project_id = p_project_id
           and f.key = case p_kind
                         when 'building_area'     then 'building_area_impacted'
                         when 'building_level'    then 'building_level_impacted'
                         when 'category'          then 'category'
                         when 'timeline_priority' then 'timeline_priority'
                         else p_kind
                       end
           and o.value = p_value
      )
    end
$$;

-- project_taxonomy_values is now SUPERSEDED. It is deliberately left in
-- place and simply stops being read or written, so this migration is
-- reversible on a database that already holds customised vocabularies. A
-- later release may drop it.
comment on table ship.project_taxonomy_values is
  'SUPERSEDED by form_field_options (migration 0012). Retained for reversibility; no longer read or written. Do not add to it.';

-- ---------------------------------------------------------------------
-- Grants and RLS
--
-- Read: anyone who can read the project -- a consultant filling the form
-- in obviously needs its definition.
-- Write: can_edit_project(), matching every other project-configuration
-- table since 0009.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on ship.form_fields        to authenticated;
grant select, insert, update, delete on ship.form_field_options to authenticated;

alter table ship.form_fields        enable row level security;
alter table ship.form_field_options enable row level security;

drop policy if exists form_fields_select on ship.form_fields;
drop policy if exists form_fields_insert on ship.form_fields;
drop policy if exists form_fields_update on ship.form_fields;
drop policy if exists form_fields_delete on ship.form_fields;

create policy form_fields_select on ship.form_fields
  for select to authenticated
  using (project_id in (select ship.my_project_ids()));

create policy form_fields_insert on ship.form_fields
  for insert to authenticated
  with check ((select ship.can_edit_project(project_id)));

-- WITH CHECK mirrors USING so a writer cannot move a field to another
-- project by updating project_id -- USING would pass on a row that is
-- currently theirs and the new value would never be validated.
create policy form_fields_update on ship.form_fields
  for update to authenticated
  using      (project_id in (select ship.my_editable_project_ids()))
  with check (project_id in (select ship.my_editable_project_ids()));

create policy form_fields_delete on ship.form_fields
  for delete to authenticated
  using (project_id in (select ship.my_editable_project_ids()));

drop policy if exists form_field_options_select on ship.form_field_options;
drop policy if exists form_field_options_insert on ship.form_field_options;
drop policy if exists form_field_options_update on ship.form_field_options;
drop policy if exists form_field_options_delete on ship.form_field_options;

create policy form_field_options_select on ship.form_field_options
  for select to authenticated
  using (exists (select 1 from ship.form_fields f
                  where f.id = field_id
                    and f.project_id in (select ship.my_project_ids())));

create policy form_field_options_insert on ship.form_field_options
  for insert to authenticated
  with check (exists (select 1 from ship.form_fields f
                       where f.id = field_id
                         and (select ship.can_edit_project(f.project_id))));

create policy form_field_options_update on ship.form_field_options
  for update to authenticated
  using      (exists (select 1 from ship.form_fields f
                       where f.id = field_id
                         and f.project_id in (select ship.my_editable_project_ids())))
  with check (exists (select 1 from ship.form_fields f
                       where f.id = field_id
                         and f.project_id in (select ship.my_editable_project_ids())));

create policy form_field_options_delete on ship.form_field_options
  for delete to authenticated
  using (exists (select 1 from ship.form_fields f
                  where f.id = field_id
                    and f.project_id in (select ship.my_editable_project_ids())));

commit;

-- =====================================================================
-- ROLLBACK
--
-- begin;
--   drop trigger  if exists form_fields_guard on ship.form_fields;
--   drop function if exists ship.guard_form_field();
--   drop table    if exists ship.form_field_options;
--   drop table    if exists ship.form_fields;
--   drop function if exists ship.seed_default_form(text);
--   drop function if exists ship.default_form_field_options();
--   drop function if exists ship.default_form_fields();
--   alter table ship.line_items drop column if exists custom_fields;
--   -- and re-apply 0008's taxonomy_value_allowed(), which reads
--   -- project_taxonomy_values. That table was never modified, so the
--   -- 0008 behaviour returns intact.
-- commit;
--
-- HOW TO VERIFY
--
-- -- Every project has the full default form, once:
-- select project_id, count(*) from ship.form_fields group by 1;   -- 24 each
--
-- -- Additive: re-running adds nothing and changes nothing.
-- update ship.form_fields set label = 'RENAMED' where key = 'category';
-- -- (then call seed_default_form as an editor, and re-select)
-- select label from ship.form_fields where key = 'category';      -- RENAMED
--
-- -- Built-ins are structural:
-- delete from ship.form_fields where key = 'estimated_first_cost';
-- -- expected: 42501 ... cannot be deleted. Hide it instead.
-- update ship.form_fields set input_type = 'text' where key = 'annual_energy_savings';
-- -- expected: 42501 cannot change the input type
-- =====================================================================
