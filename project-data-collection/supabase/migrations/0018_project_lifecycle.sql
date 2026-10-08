-- =====================================================================
-- 0018_project_lifecycle.sql
-- SHIP -- a new project is born with fixed money and calendar years.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0017. Additive; nothing earlier is edited.
--
-- WHAT THIS FIXES (pre-launch audit master ID)
-- --------------------------------------------
-- M-25  create_project() created a project_timeline_settings row with
--       start_calendar_year NULL and no project_cost_settings row at all.
--       lib/mappers.ts then defaulted both the cost base year and the
--       timeline start year to `new Date().getUTCFullYear()` -- so every
--       total, escalation anchor and FY label silently shifted on
--       1 January (bsb2301: -$3.02M), and an export taken in December
--       disagreed with one taken in January. Worse, once someone saved a
--       cost setting the base year pinned while the start year kept
--       floating, adding a year of escalation every New Year.
--
--       Now:
--       * create_project() inserts project_cost_settings (base_year =
--         this year), project_energy_settings, and the timeline row with
--         start_calendar_year = this year. Fixed at creation, never
--         re-derived.
--       * Every existing project is backfilled: missing rows are created
--         and a NULL start_calendar_year is set, both from the year of
--         projects.created_at (decision: backfill year = creation year).
--       * project_timeline_settings.start_calendar_year becomes NOT NULL
--         (with a this-year default, so an insert that forgets it gets
--         a fixed year rather than an error).
--       The mappers' "now" fallback can therefore be removed (WS-5): a
--       missing row is now an error state, not something to paper over.
--
-- ALSO (M-44 / DATA-23, same function): create_project() seeds the
-- default taxonomy and the default form inside the same transaction.
-- lib/store.ts used to make two more round trips after the create, and a
-- failure there left a project with no form and only a console.error.
-- The client's own seed calls are idempotent (ON CONFLICT DO NOTHING), so
-- an older client that still makes them is unaffected.
-- New roster emails are allowlisted with pending_invites.project_id set,
-- matching update_project() in 0013.
--
-- CONTRACT: unchanged -- ship.create_project(p_name text,
--   p_consultants jsonb default '[]') returns jsonb
--   { project_id, invited_emails }.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. create_project()
-- ---------------------------------------------------------------------
create or replace function ship.create_project(
  p_name        text,
  p_consultants jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base        text;
  v_slug        text;
  v_n           integer := 1;
  v_year        integer := extract(year from current_date)::integer;
  v_consultants jsonb := coalesce(p_consultants, '[]'::jsonb);
  v_invited     text[];
begin
  if not ship.is_admin() then
    raise exception 'ship.create_project: admin role required'
      using errcode = '42501';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'ship.create_project: name is required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_consultants) <> 'array' then
    raise exception 'ship.create_project: p_consultants must be a JSON array'
      using errcode = '22023';
  end if;

  v_base := ship.slugify(p_name);
  v_slug := v_base;

  -- Slug collision retry, as in 0004.
  loop
    begin
      insert into ship.projects (id, name, created_by)
      values (v_slug, btrim(p_name), auth.uid());
      exit;
    exception when unique_violation then
      v_n := v_n + 1;
      if v_n > 500 then
        raise exception 'ship.create_project: could not allocate a unique slug for %', p_name
          using errcode = '55000';
      end if;
      v_slug := v_base || '-' || v_n::text;
    end;
  end loop;

  insert into ship.project_consultants (project_id, consultant_type, org_name)
  select v_slug,
         c ->> 'type',
         coalesce(c ->> 'orgName', '')
    from jsonb_array_elements(v_consultants) as c
   where coalesce(c ->> 'type', '') <> ''
  on conflict (project_id, consultant_type)
    do update set org_name = excluded.org_name;

  insert into ship.project_members (project_id, email, consultant_type)
  select distinct
         v_slug,
         lower(btrim(e.value #>> '{}')),
         c ->> 'type'
    from jsonb_array_elements(v_consultants) as c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c -> 'emails') = 'array' then c -> 'emails' else '[]'::jsonb end
    ) as e
   where coalesce(c ->> 'type', '') <> ''
     and jsonb_typeof(e.value) = 'string'
     and btrim(coalesce(e.value #>> '{}', '')) <> ''
  on conflict do nothing;

  -- Allowlist the roster (consultant, scoped to this project). RETURNING
  -- yields only genuinely new invites -- the set the caller should mail.
  with inserted as (
    insert into ship.pending_invites (email, name, role, invited_by, project_id)
    select pm.email,
           initcap(regexp_replace(split_part(pm.email, '@', 1), '[._-]+', ' ', 'g')),
           'consultant',
           auth.uid(),
           v_slug
      from (select distinct m.email from ship.project_members m where m.project_id = v_slug) pm
    on conflict (email) do nothing
    returning email
  )
  select coalesce(array_agg(distinct i.email), '{}'::text[]) into v_invited from inserted i;

  -- Per-project singletons. The years are FIXED here (M-25).
  insert into ship.chunk_number_counters (project_id)
  values (v_slug)
  on conflict (project_id) do nothing;

  insert into ship.project_timeline_settings (project_id, start_calendar_year)
  values (v_slug, v_year)
  on conflict (project_id) do nothing;

  insert into ship.project_cost_settings (project_id, base_year, updated_by)
  values (v_slug, v_year, auth.uid())
  on conflict (project_id) do nothing;

  insert into ship.project_energy_settings (project_id, updated_by)
  values (v_slug, auth.uid())
  on conflict (project_id) do nothing;

  -- Taxonomy, then the form (whose taxonomy-backed selects copy it).
  perform ship.seed_default_taxonomy(v_slug);
  perform ship.seed_default_form(v_slug);

  return jsonb_build_object(
    'project_id',     v_slug,
    'invited_emails', to_jsonb(coalesce(v_invited, '{}'::text[]))
  );
end;
$$;

revoke all on function ship.create_project(text, jsonb) from public, anon;
grant execute on function ship.create_project(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Backfill existing projects from their creation year.
-- ---------------------------------------------------------------------
insert into ship.project_timeline_settings (project_id, start_calendar_year)
select p.id, extract(year from p.created_at)::integer
  from ship.projects p
on conflict (project_id) do nothing;

update ship.project_timeline_settings t
   set start_calendar_year = extract(year from p.created_at)::integer
  from ship.projects p
 where p.id = t.project_id
   and t.start_calendar_year is null;

insert into ship.project_cost_settings (project_id, base_year)
select p.id, extract(year from p.created_at)::integer
  from ship.projects p
on conflict (project_id) do nothing;

insert into ship.project_energy_settings (project_id)
select p.id
  from ship.projects p
on conflict (project_id) do nothing;

-- ---------------------------------------------------------------------
-- 3. start_calendar_year is a fact about the project, not optional.
-- ---------------------------------------------------------------------
alter table ship.project_timeline_settings
  alter column start_calendar_year set default extract(year from current_date)::integer,
  alter column start_calendar_year set not null;

comment on column ship.project_timeline_settings.start_calendar_year is
  'Calendar year of timeline slot 0. Fixed when the project is created (0018) -- never derived from the viewer''s clock.';

commit;
