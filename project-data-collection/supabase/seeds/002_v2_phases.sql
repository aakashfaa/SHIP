-- =====================================================================
-- 002_v2_phases.sql
-- Fixture data for the v2 phasing, cost and energy features.
--
-- Runs after 001_seed.sql (glob order), which creates the projects,
-- line items and packages this builds on.
--
-- WHY THIS IS A SEED AND NOT PART OF MIGRATION 0007
-- -------------------------------------------------
-- 0007 contains a backfill that turns existing chunk_projects.timeline_
-- segments into chunk_phases. On a database with real v1 schedules that
-- is exactly right. On a fresh one it is a no-op, because the CLI
-- applies migrations before seeds, so there are no chunks yet. This file
-- is the fixture equivalent -- it exists so the Timeline tab has
-- something meaningful to render locally and so the visual tests have a
-- deterministic subject.
--
-- WHAT IT IS SHAPED TO DEMONSTRATE
-- --------------------------------
-- Every v2 behaviour that is hard to eyeball, arranged so a screenshot
-- shows it:
--
--   * design scheduled years ahead of construction, which is the entire
--     point of the sub-task level
--   * a locked-duration phase, so the resize affordance can be seen to
--     be absent
--   * a finish-to-start dependency between two packages
--   * a package whose phase percentages do NOT sum to 100, so the
--     warning state is reachable without hand-editing data
--   * energy savings on some line items and not others, so the step
--     chart has both steps and flat runs
--
-- Deterministic: no random values, no now()-relative dates. Visual
-- baselines depend on that.
--
-- Idempotent: guarded inserts throughout, safe to re-run.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Cost + energy parameters for the fixture project
--
-- The numbers are the first client's stated working assumptions, which
-- makes the fixture a realistic rehearsal of their actual conversation:
-- 1.33x TPC, 4%/yr compound escalation measured to the midpoint of each
-- phase, a July fiscal year, and a 5-year confidence horizon past which
-- the UI stops pretending to know.
--
-- interaction_factor is 0.90 rather than 1.00 on purpose: it makes the
-- de-rate visible in the fixture, so nobody ships a change that quietly
-- ignores it.
-- ---------------------------------------------------------------------
insert into ship.project_cost_settings
  (project_id, tpc_factor, base_year, escalation_mode, escalation_annual_percent,
   escalation_basis, escalation_confidence_years,
   default_phase_template_id)
select 'federal-campus-master-plan', 1.33, 2026, 'compound_annual', 4.0,
       'midpoint', 5,
       (select id from ship.phase_templates where is_builtin and name = 'DCAMM Study + Design')
where not exists (
  select 1 from ship.project_cost_settings where project_id = 'federal-campus-master-plan'
);

-- Two pinned near-term years over the 4% default. This is the case a
-- single compound rate cannot express and the reason the engine computes
-- escalation as a product over years rather than a power: estimators
-- know the next year or two and are guessing after that.
insert into ship.escalation_rate_overrides (project_id, year_offset, rate_percent)
values ('federal-campus-master-plan', 0, 6.5),
       ('federal-campus-master-plan', 1, 5.25)
on conflict (project_id, year_offset) do nothing;

insert into ship.project_energy_settings
  (project_id, unit_label, baseline_annual, interaction_factor)
select 'federal-campus-master-plan', 'kBtu/yr', 12500000, 0.90
where not exists (
  select 1 from ship.project_energy_settings where project_id = 'federal-campus-master-plan'
);

-- Anchor the timeline to a real calendar year so fiscal-year labels and
-- escalation have something to measure from. Matches base_year above.
update ship.project_timeline_settings
   set start_calendar_year     = 2026,
       fiscal_year_start_month = 7,
       fiscal_year_labels_by   = 'end_year'
 where project_id = 'federal-campus-master-plan';

-- ---------------------------------------------------------------------
-- Energy savings on line items
--
-- Applied by category rather than to specific item numbers, so the seed
-- survives 001_seed.sql growing more rows. Envelope and mechanical work
-- saves energy; restoration and documentation work does not, which is
-- what produces flat runs between steps on the chart.
--
-- Units are kBtu/yr, matching project_energy_settings.unit_label above.
-- Nothing enforces that agreement -- the unit is a project-level label
-- precisely because the client does not know their units yet ("We don't
-- know the scale or the units yet, but we can get that soon" -- Megan).
-- ---------------------------------------------------------------------
update ship.line_items
   set annual_energy_savings = case discipline
                                 when 'Mechanical' then 430000
                                 when 'Envelope'   then 610000
                                 when 'Electrical' then 185000
                                 when 'Plumbing'   then  42000
                                 else 0
                               end,
       annual_cost_savings   = case discipline
                                 when 'Mechanical' then 61000
                                 when 'Envelope'   then 88000
                                 when 'Electrical' then 26000
                                 when 'Plumbing'   then  6000
                                 else 0
                               end,
       energy_notes          = case discipline
                                 when 'Mechanical' then 'Placeholder pending engineer model. Not a calibrated figure.'
                                 when 'Envelope'   then 'Placeholder pending engineer model. Not a calibrated figure.'
                                 when 'Electrical' then 'Placeholder pending engineer model. Not a calibrated figure.'
                                 when 'Plumbing'   then 'Placeholder pending engineer model. Not a calibrated figure.'
                                 else ''
                               end
 where project_id = 'federal-campus-master-plan'
   and annual_energy_savings = 0;

-- ---------------------------------------------------------------------
-- Phases
--
-- Built from the DCAMM 1/9/90 template, then placed to tell the story
-- the client described: design for everything happens early and close
-- together, construction is spread out per package with real gaps.
--
--   "The design happens all at once, but the construction is phased just
--    because they've acknowledged that they can't do more than one wing
--    at a time."                                              -- Steve
--
-- Slot units are whatever project_timeline_settings.interval_unit says;
-- the fixture project is on 'yearly', so a slot is a year and slot 0 is
-- calendar 2026.
-- ---------------------------------------------------------------------
do $$
declare
  v_chunk      record;
  v_tpl        uuid;
  v_step       record;
  -- (draft study start, design start, construction start, construction duration)
  v_layout     int[][] := array[
    array[0, 1, 3, 4],   -- PP10  design early, build years 3-6
    array[0, 1, 5, 3],   -- PP11  same design window, build later
    array[1, 2, 8, 2],   -- PP12  far-out work: past the confidence horizon
    array[0, 1, 4, 3],   -- PP13
    array[2, 3, 6, 2]    -- PP14
  ];
  v_idx        int := 0;
  -- Postgres 2-D arrays are NOT arrays-of-arrays: v_layout[i] on a 2-D
  -- array yields NULL, not a row. Every read below must subscript both
  -- dimensions, v_layout[i][j].
  v_n          int := array_length(v_layout, 1);
  v_pick       int;
begin
  select id into v_tpl from ship.phase_templates
   where is_builtin and name = 'DCAMM Study + Design';

  for v_chunk in
    select id, chunk_number from ship.chunk_projects
     where project_id = 'federal-campus-master-plan'
     order by chunk_number
  loop
    -- Never clobber phases that already exist (0007's backfill, or a
    -- previous run of this seed).
    if exists (select 1 from ship.chunk_phases p where p.chunk_project_id = v_chunk.id) then
      continue;
    end if;

    v_idx  := v_idx + 1;
    v_pick := least(v_idx, v_n);

    for v_step in
      select * from ship.phase_template_steps
       where template_id = v_tpl order by sort_order
    loop
      insert into ship.chunk_phases
        (chunk_project_id, template_step_id, name, kind, sort_order,
         pct_of_tpc, start_slot, duration_slots, duration_locked)
      values (
        v_chunk.id,
        v_step.id,
        v_step.name,
        v_step.kind,
        v_step.sort_order,
        v_step.default_pct_of_tpc,
        case v_step.kind
          when 'study'        then v_layout[v_pick][1]
          when 'design'       then v_layout[v_pick][2]
          else                     v_layout[v_pick][3]
        end,
        case v_step.kind
          when 'study'        then 1
          when 'design'       then 2
          else                     v_layout[v_pick][4]
        end,
        -- PP12's construction duration is locked. A regulatory review or
        -- a fixed-price contract window is the usual real reason; here it
        -- exists so the padlock and the missing resize handles are
        -- visible in a screenshot without anyone hand-editing data.
        (v_chunk.chunk_number = 'PP12' and v_step.kind = 'construction')
      );
    end loop;
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- A package whose percentages do not add up
--
-- PP14's construction phase is knocked down to 80%, leaving the package
-- at 90% of TPC. That is not a mistake in the fixture -- it is the
-- fixture FOR the mistake, so the "phases total 90%, not 100%" warning
-- has a home on screen and cannot regress unnoticed.
--
-- The tool deliberately does not auto-correct this. Silently rescaling a
-- number a cost estimator typed is worse than showing them it is wrong.
-- ---------------------------------------------------------------------
update ship.chunk_phases p
   set pct_of_tpc = 80
  from ship.chunk_projects c
 where c.id = p.chunk_project_id
   and c.chunk_number = 'PP14'
   and p.kind = 'construction'
   and p.pct_of_tpc = 90;

-- ---------------------------------------------------------------------
-- Dependencies
--
-- Jeff's case, made concrete: one package's construction cannot start
-- until another's finishes.
--
--   "You can't start the bulfinch upgrades until the wings project is
--    complete. So if you push out the wings project, will it
--    automatically push out the bulfinch?"                     -- Jeff
--
-- Both are finish-to-start, which is what ~all real links are. The
-- second carries a one-slot lag, so the lag rendering has a subject.
-- ---------------------------------------------------------------------
insert into ship.phase_dependencies
  (predecessor_phase_id, successor_phase_id, dep_type, lag_slots)
select pred.id, succ.id, 'FS', 0
  from ship.chunk_phases pred
  join ship.chunk_projects pc on pc.id = pred.chunk_project_id and pc.chunk_number = 'PP10'
  join ship.chunk_projects sc on sc.chunk_number = 'PP11' and sc.project_id = pc.project_id
  join ship.chunk_phases succ on succ.chunk_project_id = sc.id and succ.kind = 'construction'
 where pred.kind = 'construction'
   and not exists (
     select 1 from ship.phase_dependencies d
      where d.predecessor_phase_id = pred.id and d.successor_phase_id = succ.id
   );

insert into ship.phase_dependencies
  (predecessor_phase_id, successor_phase_id, dep_type, lag_slots)
select pred.id, succ.id, 'FS', 1
  from ship.chunk_phases pred
  join ship.chunk_projects pc on pc.id = pred.chunk_project_id and pc.chunk_number = 'PP13'
  join ship.chunk_projects sc on sc.chunk_number = 'PP14' and sc.project_id = pc.project_id
  join ship.chunk_phases succ on succ.chunk_project_id = sc.id and succ.kind = 'construction'
 where pred.kind = 'construction'
   and not exists (
     select 1 from ship.phase_dependencies d
      where d.predecessor_phase_id = pred.id and d.successor_phase_id = succ.id
   );

commit;
