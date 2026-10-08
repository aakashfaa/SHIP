-- =====================================================================
-- 0020_canonical_time_unit.sql
-- SHIP -- schedules are stored in MONTHS; the zoom becomes a view.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0019. Additive; nothing earlier is edited.
-- SNAPSHOT THE HOSTED DATABASE BEFORE APPLYING THIS (decision D-1): it
-- rewrites every stored schedule position in place. It is guarded so it
-- can only ever convert once (see "Run-once guard" below), and it logs
-- the factor it used per project so the conversion can be audited or
-- reversed by hand (divide by ship.time_unit_conversion_log.months_per_slot).
--
-- WHAT THIS FIXES (pre-launch audit master ID)
-- --------------------------------------------
-- M-01  chunk_phases.start_slot / duration_slots, phase_dependencies.
--       lag_slots, phase_template_steps.default_duration_slots and the
--       phases inside scenarios.payload / base_payload were stored in
--       "slots", and a slot meant whatever the project's zoom said: a year
--       at Year zoom, a month at Month zoom. Moving the Zoom slider wrote a
--       new zoom_level and re-read EVERY stored row in the new unit, so it
--       re-priced the whole plan and the Excel export (bsb2301: $78.7M at
--       Month, $366M at Year, $694 BILLION at 5-year). Wave A only locked
--       the slider.
--
--       Decision D-1: store every schedule position in months. The zoom is
--       display-only from now on (the app keeps zoom_level purely as the
--       view a page opens at; no stored value or price depends on it).
--
-- CONVERSION RULE
-- ---------------
-- Each project's rows are multiplied by the months-per-slot of the zoom
-- the app was ACTUALLY rendering and pricing them at. That is
-- project_timeline_settings.zoom_level, not interval_unit: the Timeline
-- and the export both derived the interval from zoom_level
-- (intervalForZoom: 1 = 5-year, 2 = 3-year, 3 = Year, 4 = Quarter,
-- 5 = Month), and interval_unit was only ever written alongside it. A
-- project with no settings row rendered at the default zoom 3 (Year).
--
--     zoom_level   1    2    3    4    5    (none)
--     months/slot  60   36   12   3    1    12
--
-- So a phase at slot 3 for 4 slots on a Year-zoom project becomes month
-- 36 for 48 months -- the same calendar position, priced identically
-- (escalation reads yearsOut = months / 12, which equals the old slots x
-- 1). Multiplying by an integer can't make a fractional value out of an
-- integer one, so no rounding is applied and nothing moves.
--
-- Templates: a project's own template steps use that project's factor.
-- Built-in templates (project_id null) are shared by every project; their
-- 1/2/3-slot defaults were written for the default Year zoom, so they are
-- multiplied by 12 (a 3-slot construction default = 36 months, as it
-- always meant at the default zoom).
--
-- Scenario payloads keep their jsonb keys (start_slot, duration_slots,
-- lag_slots) because publish/rebase/save_scenario_payload (0015) read them
-- by name; only the values are scaled. A scenario whose stored
-- baseline_fingerprint matched the live schedule before conversion is
-- re-stamped afterwards (the fingerprint hashes the converted numbers),
-- so converting does not make every open what-if report a false
-- "someone changed the live plan" conflict. A scenario that was ALREADY
-- stale stays stale, as it should.
--
-- WHY THE COLUMN NAMES STAY
-- -------------------------
-- Renaming start_slot -> start_month would mean re-creating every
-- scenario RPC body (0010/0011/0015) and the jsonb payload contract for
-- no behavioural gain. The columns are COMMENTed as months instead, the
-- TypeScript domain types say startMonth / durationMonths / lagMonths,
-- and lib/mappers.ts is the single place the two names meet.
--
-- FUNCTIONS THAT VALIDATE RANGES
-- ------------------------------
-- save_scenario_payload checks start >= 0 and duration >= 1; the table
-- checks are start_slot >= 0, duration_slots >= 1, default_duration_slots
-- >= 1. All hold unchanged in months (one month is the finest unit any
-- zoom can produce), so no function body changes here.
--
-- Seeds (supabase/seeds/*.sql) run AFTER migrations on a reset and now
-- write months directly; on a fresh database this migration converts
-- only the built-in templates 0007 inserted.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Run-once guard
--
-- A marker row, not "does the data look converted": there is no reliable
-- way to tell a 12-month phase from a 12-slot one by looking at it. With
-- the marker present the conversion block is a no-op, so re-running this
-- file (or applying it to a database restored from a post-0020 dump)
-- cannot multiply anything twice.
-- ---------------------------------------------------------------------
create table if not exists ship.schema_conversions (
  key        text primary key,
  applied_at timestamptz not null default now(),
  detail     jsonb not null default '{}'::jsonb
);

comment on table ship.schema_conversions is
  'One row per one-off data conversion, so it can never run twice. Written by migrations only.';

alter table ship.schema_conversions enable row level security;
revoke all on ship.schema_conversions from public, anon, authenticated;

-- What each project was multiplied by. Audit trail, and the way back.
create table if not exists ship.time_unit_conversion_log (
  project_id      text primary key,
  zoom_level      integer,
  interval_unit   text,
  months_per_slot numeric not null,
  phases          integer not null,
  dependencies    integer not null,
  scenarios       integer not null,
  template_steps  integer not null,
  converted_at    timestamptz not null default now()
);

comment on table ship.time_unit_conversion_log is
  'Migration 0020: the months-per-slot factor each project''s schedule was multiplied by when schedules moved to months. Divide by months_per_slot to recover the pre-0020 slot values.';

alter table ship.time_unit_conversion_log enable row level security;
revoke all on ship.time_unit_conversion_log from public, anon, authenticated;

-- Scales the schedule numbers inside a scenario payload (or base_payload)
-- by p_factor, leaving every other key -- and any null or missing value --
-- exactly as it was. pg_temp, so nothing is left behind in the schema.
create or replace function pg_temp.scale_schedule_payload(p_payload jsonb, p_factor numeric)
returns jsonb
language sql
immutable
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then p_payload
    else p_payload
      || case when jsonb_typeof(p_payload -> 'phases') = 'array' then
           jsonb_build_object('phases', (
             select coalesce(jsonb_agg(
                      case when jsonb_typeof(ph) <> 'object' then ph
                           else ph
                             || case when jsonb_typeof(ph -> 'start_slot') = 'number'
                                     then jsonb_build_object('start_slot',
                                            trim_scale((ph ->> 'start_slot')::numeric * p_factor))
                                     else '{}'::jsonb end
                             || case when jsonb_typeof(ph -> 'duration_slots') = 'number'
                                     then jsonb_build_object('duration_slots',
                                            trim_scale((ph ->> 'duration_slots')::numeric * p_factor))
                                     else '{}'::jsonb end
                      end order by ord), '[]'::jsonb)
               from jsonb_array_elements(p_payload -> 'phases') with ordinality as t(ph, ord)))
         else '{}'::jsonb end
      || case when jsonb_typeof(p_payload -> 'dependencies') = 'array' then
           jsonb_build_object('dependencies', (
             select coalesce(jsonb_agg(
                      case when jsonb_typeof(d) = 'object' and jsonb_typeof(d -> 'lag_slots') = 'number'
                           then d || jsonb_build_object('lag_slots',
                                       trim_scale((d ->> 'lag_slots')::numeric * p_factor))
                           else d
                      end order by ord), '[]'::jsonb)
               from jsonb_array_elements(p_payload -> 'dependencies') with ordinality as t(d, ord)))
         else '{}'::jsonb end
  end
$$;

do $$
declare
  v_project record;
  v_phases  integer;
  v_deps    integer;
  v_scen    integer;
  v_steps   integer;
begin
  if exists (select 1 from ship.schema_conversions where key = 'schedule_months') then
    raise notice '0020: schedules are already stored in months; nothing to convert.';
    return;
  end if;

  -- The factor per project, from the zoom the app rendered and priced at.
  create temp table _ship_0020_factor on commit drop as
    select p.id as project_id,
           ts.zoom_level,
           ts.interval_unit,
           (case coalesce(ts.zoom_level, 3)
              when 1 then 60
              when 2 then 36
              when 3 then 12
              when 4 then 3
              when 5 then 1
              else 12
            end)::numeric as factor
      from ship.projects p
      left join ship.project_timeline_settings ts on ts.project_id = p.id;

  -- Which what-ifs were in step with the live plan BEFORE conversion.
  create temp table _ship_0020_current on commit drop as
    select s.id,
           s.baseline_fingerprint = ship.schedule_fingerprint(s.project_id) as was_current
      from ship.scenarios s;

  -- Keep "last edited" on scenarios truthful: converting units is not an edit.
  alter table ship.scenarios disable trigger scenarios_touch_updated_at;

  for v_project in select * from _ship_0020_factor loop
    update ship.chunk_phases ph
       set start_slot     = trim_scale(ph.start_slot * v_project.factor),
           duration_slots = trim_scale(ph.duration_slots * v_project.factor)
      from ship.chunk_projects c
     where c.id = ph.chunk_project_id
       and c.project_id = v_project.project_id;
    get diagnostics v_phases = row_count;

    update ship.phase_dependencies d
       set lag_slots = trim_scale(d.lag_slots * v_project.factor)
     where d.project_id = v_project.project_id;
    get diagnostics v_deps = row_count;

    update ship.scenarios s
       set payload      = pg_temp.scale_schedule_payload(s.payload, v_project.factor),
           base_payload = pg_temp.scale_schedule_payload(s.base_payload, v_project.factor)
     where s.project_id = v_project.project_id;
    get diagnostics v_scen = row_count;

    update ship.phase_template_steps st
       set default_duration_slots = trim_scale(st.default_duration_slots * v_project.factor)
      from ship.phase_templates t
     where t.id = st.template_id
       and t.project_id = v_project.project_id;
    get diagnostics v_steps = row_count;

    insert into ship.time_unit_conversion_log
      (project_id, zoom_level, interval_unit, months_per_slot,
       phases, dependencies, scenarios, template_steps)
    values
      (v_project.project_id, v_project.zoom_level, v_project.interval_unit, v_project.factor,
       v_phases, v_deps, v_scen, v_steps)
    on conflict (project_id) do nothing;
  end loop;

  -- Built-in templates: written for the default Year zoom.
  update ship.phase_template_steps st
     set default_duration_slots = trim_scale(st.default_duration_slots * 12)
    from ship.phase_templates t
   where t.id = st.template_id
     and t.project_id is null;
  get diagnostics v_steps = row_count;

  -- Re-stamp what-ifs that were current, against the converted schedule.
  update ship.scenarios s
     set baseline_fingerprint = ship.schedule_fingerprint(s.project_id)
    from _ship_0020_current c
   where c.id = s.id
     and c.was_current;

  alter table ship.scenarios enable trigger scenarios_touch_updated_at;

  insert into ship.schema_conversions (key, detail)
  values ('schedule_months',
          jsonb_build_object('builtin_template_steps', v_steps,
                             'projects', (select count(*) from _ship_0020_factor)));
end
$$;

-- ---------------------------------------------------------------------
-- Say what the columns mean now. Anyone reading the schema (or writing
-- raw SQL against it) sees the unit without having to find this file.
-- ---------------------------------------------------------------------
comment on column ship.chunk_phases.start_slot is
  'MONTHS from January of project_timeline_settings.start_calendar_year (month 0). Name predates migration 0020; never zoom-dependent.';
comment on column ship.chunk_phases.duration_slots is
  'Duration in MONTHS (>= 1). Name predates migration 0020; never zoom-dependent.';
comment on column ship.phase_dependencies.lag_slots is
  'Lag in MONTHS; negative is a lead. Name predates migration 0020.';
comment on column ship.phase_template_steps.default_duration_slots is
  'Default phase duration in MONTHS. Name predates migration 0020.';
comment on column ship.scenarios.payload is
  'What-if placements. Phase start_slot / duration_slots and dependency lag_slots are in MONTHS since migration 0020 (keys kept for the RPCs).';
comment on column ship.scenarios.base_payload is
  'The live schedule at branch/rebase time, same shape and units (MONTHS) as payload.';
comment on column ship.project_timeline_settings.zoom_level is
  'The DEFAULT VIEW a Timeline opens at (1 = 5-year .. 5 = Month). Display only since migration 0020: no stored schedule or price depends on it.';
comment on column ship.project_timeline_settings.interval_unit is
  'Legacy companion of zoom_level; display only since migration 0020.';
