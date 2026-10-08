-- =====================================================================
-- 0024_default_phase_template.sql
-- SHIP -- new projects start on the DCAMM Study + Design phase template.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0023. Additive; nothing earlier is edited.
--
-- WHY
-- ---
-- The phase template is now ONE project-level choice (the owner's call:
-- per-package phase structures were never going to be used). It lives where
-- it always has, project_cost_settings.default_phase_template_id, and every
-- package's phases come from it. A project created with no template would
-- give every new package a guessed fallback, so a new project starts on
-- DCAMM Study + Design, which the user can change in the Cost model.
--
-- SCOPE: create_project() only. Existing projects and the seeded fixtures
-- keep whatever they have -- no backfill, no column default, no trigger
-- (seeds insert cost settings directly and must stay as they are).
--
-- CONTRACT: unchanged -- ship.create_project(p_name text,
--   p_consultants jsonb default '[]') returns jsonb
--   { project_id, invited_emails }. The body is 0018's, verbatim, except
--   the project_cost_settings insert.
-- =====================================================================

begin;

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

  -- 0024: born with the DCAMM Study + Design phase template (null if that
  -- built-in has been removed -- the column is nullable and the UI copes).
  insert into ship.project_cost_settings (project_id, base_year, updated_by, default_phase_template_id)
  values (v_slug, v_year, auth.uid(),
          (select t.id from ship.phase_templates t
            where t.is_builtin and t.name = 'DCAMM Study + Design'
            order by t.created_at
            limit 1))
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

commit;
