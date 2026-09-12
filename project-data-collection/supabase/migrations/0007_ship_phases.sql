-- =====================================================================
-- 0007_ship_phases.sql
-- SHIP v2 -- the sub-task level: phases within a package, the templates
-- they come from, and the dependencies between them.
--
-- This is the headline change of v2. See
-- docs/SPEC-v2-phasing-and-cost-model.md sections 1.1 and 1.4.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0006. Local stack only; not applied remotely.
--
-- THE PROBLEM THIS SOLVES
-- -----------------------
-- v1 models a package as one bar (optionally split into two). That
-- cannot express the thing the client actually plans around:
--
--   "the design side just wants to be its own chunk in here then almost.
--    Because it's almost independent, really, from when the construction
--    happens. Because if you did a design this year and then you don't do
--    the bulfinch for five more years, that needs to be really separate."
--                                                              -- Megan
--
--   "it's almost like if you're doing something where you have a task,
--    but then you almost have subtasks to that one. So there's the, say,
--    the draft study for something, and that lives as a subtask to that
--    one."                                                     -- Steve
--
-- So: a package decomposes into an ordered list of phases, each with its
-- own position on the timeline and its own share of the package cost.
-- Design for the whole building happens once, early; construction is
-- phased per wing, years later; the gap between them is the point.
--
-- WHY `kind` IS NOT JUST `name`
-- -----------------------------
-- `kind` is a small closed set and drives three behaviours that must not
-- depend on what someone typed in a text box:
--   * bar colour on the timeline
--   * whether the phase contributes to ENERGY ONSET -- savings begin when
--     construction completes, not when design does (spec R7.4)
--   * which default escalation basis applies
-- `name` is free text and is what the user reads. A firm can call their
-- construction phase "Build-out" without breaking the energy chart.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- phase_templates  (6 columns)
--
-- A named phase taxonomy. `project_id is null` means built-in: readable
-- by every SHIP user, writable by nobody through the API (see policies).
--
-- Built-ins exist so that "which phases does a project have" is a choice
-- a user makes, not a constant in the codebase. That is the whole
-- generalisation strategy for v2 -- the first client's DCAMM task
-- structure is one template among several, not the shape of the app.
-- ---------------------------------------------------------------------
create table if not exists ship.phase_templates (
  id          uuid primary key default gen_random_uuid(),
  project_id  text references ship.projects(id) on delete cascade,
  name        text not null check (btrim(name) <> ''),
  description text not null default '',
  is_builtin  boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists phase_templates_project_id_idx
  on ship.phase_templates (project_id);

-- A built-in must have no project, and a project template must not claim
-- to be built-in. Enforced rather than assumed, because the read policy
-- below keys off `project_id is null` and a mislabelled row would leak a
-- project's custom template to every user in the database.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'phase_templates_builtin_ck') then
    alter table ship.phase_templates
      add constraint phase_templates_builtin_ck
      check ((is_builtin and project_id is null) or (not is_builtin and project_id is not null));
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- phase_template_steps  (7 columns)
--
-- default_pct_of_tpc is a STARTING POINT, copied into chunk_phases when
-- a template is applied and edited freely afterwards. Changing a
-- template later does not reach back into packages already built from
-- it -- that would silently re-price work someone has already scheduled.
-- ---------------------------------------------------------------------
create table if not exists ship.phase_template_steps (
  id                     uuid primary key default gen_random_uuid(),
  template_id            uuid not null references ship.phase_templates(id) on delete cascade,
  name                   text not null check (btrim(name) <> ''),
  kind                   text not null check (kind in ('study', 'design', 'construction', 'closeout')),
  sort_order             integer not null default 0,
  default_pct_of_tpc     numeric not null default 0
                           check (default_pct_of_tpc >= 0 and default_pct_of_tpc <= 100),
  default_duration_slots numeric not null default 1 check (default_duration_slots >= 1),
  unique (template_id, sort_order)
);

create index if not exists phase_template_steps_template_id_idx
  on ship.phase_template_steps (template_id);

-- ---------------------------------------------------------------------
-- chunk_phases  (10 columns)  -- THE new sub-task level
--
-- pct_of_tpc
--   This phase's share of the package's Total Project Cost. The package
--   total still rolls up from its line items; phases DIVIDE that total,
--   they never add to it. Two packages can therefore never double-count
--   a line item through their phases.
--
--   The sum across a package's phases SHOULD be 100 and is deliberately
--   NOT constrained to it. A CHECK cannot span rows, and a trigger that
--   auto-normalised would silently rescale a number a cost estimator
--   typed -- which is worse than showing them it is wrong. The UI
--   surfaces a running total that goes red off 100.
--
-- start_slot / duration_slots
--   Timeline slots, same unit as the existing chunk_projects.timeline_*
--   columns. Slot size depends on project_timeline_settings.interval_unit,
--   so these are NOT months or years -- converting is the client's job,
--   in one place (lib/cost-model.ts).
--
-- duration_locked
--   Jeff's ask, verbatim: "The main thing is to be able to lock down a
--   duration because I noticed when Megan, you squeezed up the bulfinch
--   upgrades. It allowed you to do that... So that duration may be a
--   fixed duration and you can't squeeze it."
--
--   A locked phase can still be MOVED. This is Fixed Duration in the MS
--   Project sense -- the bar's length is constant, its position is not.
--   Effort-driven/resource-levelling semantics are deliberately absent:
--   this is a planning tool at year/quarter grain, not a CPM scheduler.
-- ---------------------------------------------------------------------
create table if not exists ship.chunk_phases (
  id               uuid primary key default gen_random_uuid(),
  chunk_project_id uuid not null references ship.chunk_projects(id) on delete cascade,
  template_step_id uuid references ship.phase_template_steps(id) on delete set null,
  name             text not null default '' ,
  kind             text not null default 'construction'
                     check (kind in ('study', 'design', 'construction', 'closeout')),
  sort_order       integer not null default 0,
  pct_of_tpc       numeric not null default 0
                     check (pct_of_tpc >= 0 and pct_of_tpc <= 100),
  start_slot       numeric not null default 0 check (start_slot >= 0),
  duration_slots   numeric not null default 1 check (duration_slots >= 1),
  duration_locked  boolean not null default false,
  created_at       timestamptz not null default now()
);

create index if not exists chunk_phases_chunk_project_id_idx
  on ship.chunk_phases (chunk_project_id);

-- The RLS policies below filter on chunk_project_id via a definer helper;
-- sort_order participates in every ordered read the client does.
create index if not exists chunk_phases_chunk_sort_idx
  on ship.chunk_phases (chunk_project_id, sort_order);

comment on column ship.chunk_phases.pct_of_tpc is
  'Share of the package TPC. Should sum to 100 across a package; not constrained, because silently rescaling an estimator''s number is worse than showing them it is wrong.';

-- ---------------------------------------------------------------------
-- phase_dependencies  (6 columns)
--
--   "You can't start the bulfinch upgrades until the wings project is
--    complete. So if you push out the wings project, will it
--    automatically push out the bulfinch?"                     -- Jeff
--
-- All four PDM link types are modelled because the arithmetic for each
-- is one line and omitting two would guarantee a migration later. FS is
-- the default and will be ~all of real usage -- the DCMA 14-point
-- schedule assessment expects >=90% of links in a well-formed schedule
-- to be FS, and that is for detailed CPM schedules, not year-grain
-- planning like this.
--
-- lag_slots may be NEGATIVE (a lead). That is what expresses "bidding
-- can overlap the tail of CD".
--
-- project_id is DENORMALISED onto this row rather than resolved through
-- two joins (dependency -> phase -> chunk -> project) on every policy
-- evaluation. RLS predicates run per row; a two-join lookup per row is
-- the classic way to make a policy quadratic. The trigger below keeps
-- the denormalised value honest, which is the price of that decision and
-- is not optional -- an unpoliced denormalised tenant key is a
-- cross-project data leak waiting to happen.
-- ---------------------------------------------------------------------
create table if not exists ship.phase_dependencies (
  id                   uuid primary key default gen_random_uuid(),
  project_id           text not null references ship.projects(id) on delete cascade,
  predecessor_phase_id uuid not null references ship.chunk_phases(id) on delete cascade,
  successor_phase_id   uuid not null references ship.chunk_phases(id) on delete cascade,
  dep_type             text not null default 'FS'
                         check (dep_type in ('FS', 'SS', 'FF', 'SF')),
  lag_slots            numeric not null default 0,
  created_at           timestamptz not null default now(),
  unique (predecessor_phase_id, successor_phase_id),
  constraint phase_dependencies_no_self_link check (predecessor_phase_id <> successor_phase_id)
);

create index if not exists phase_dependencies_project_id_idx
  on ship.phase_dependencies (project_id);
create index if not exists phase_dependencies_predecessor_idx
  on ship.phase_dependencies (predecessor_phase_id);
-- The cycle check walks successor -> predecessor, so this direction is
-- load bearing, not symmetry for its own sake.
create index if not exists phase_dependencies_successor_idx
  on ship.phase_dependencies (successor_phase_id);

-- ---------------------------------------------------------------------
-- ship.phase_project_id(uuid) -> text
--
-- Resolves a phase to its project WITHOUT re-entering chunk_phases' or
-- chunk_projects' own policies -- this function is the definer, so the
-- lookups below bypass RLS. Exactly the same trick as
-- ship.can_access_chunk() in 0002, one level deeper.
-- ---------------------------------------------------------------------
create or replace function ship.phase_project_id(p_phase_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.project_id
    from ship.chunk_phases p
    join ship.chunk_projects c on c.id = p.chunk_project_id
   where p.id = p_phase_id
$$;

create or replace function ship.can_access_phase(p_phase_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ship.can_read_project(ship.phase_project_id(p_phase_id))
$$;

revoke all    on function ship.phase_project_id(uuid) from public;
revoke all    on function ship.can_access_phase(uuid) from public;
grant execute on function ship.phase_project_id(uuid) to authenticated;
grant execute on function ship.can_access_phase(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- ship.sync_phase_dependency_project()  -- BEFORE INSERT OR UPDATE
--
-- Derives project_id from the predecessor phase and refuses a link whose
-- two endpoints live in different projects.
--
-- The cross-project check is the important half. Without it, a user with
-- write access to project A could link one of A's phases to a phase in
-- project B, and every subsequent schedule computation for A would pull
-- B's dates through the dependency graph -- reading data the RLS
-- policies exist to keep out. A foreign key cannot express "these two
-- must belong to the same third thing"; this is where that lives.
-- ---------------------------------------------------------------------
create or replace function ship.sync_phase_dependency_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pred_project text;
  v_succ_project text;
begin
  v_pred_project := ship.phase_project_id(new.predecessor_phase_id);
  v_succ_project := ship.phase_project_id(new.successor_phase_id);

  if v_pred_project is null or v_succ_project is null then
    raise exception 'phase_dependencies: unknown phase'
      using errcode = '23503';
  end if;

  if v_pred_project <> v_succ_project then
    raise exception 'phase_dependencies: cannot link phases across projects (% and %)',
      v_pred_project, v_succ_project
      using errcode = '23514';
  end if;

  new.project_id := v_pred_project;
  return new;
end;
$$;

revoke all on function ship.sync_phase_dependency_project() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- ship.assert_no_dependency_cycle()  -- AFTER INSERT OR UPDATE
--
-- A cycle makes the schedule unsolvable: the forward pass that pushes
-- successors when a predecessor moves never terminates. Catching it at
-- write time gives the user a readable error naming the loop; catching
-- it at render time gives them a hung tab.
--
-- AFTER, not BEFORE, so the new edge is visible to the walk and the
-- query is a plain reachability test rather than a special case. The
-- whole thing is inside the caller's transaction, so a raise here rolls
-- the insert back.
--
-- The walk carries its own visited-set in `path` and stops on revisit,
-- so it terminates even on a graph that is already cyclic -- which it
-- can be mid-transaction if several edges are inserted at once.
-- ---------------------------------------------------------------------
create or replace function ship.assert_no_dependency_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle uuid[];
begin
  with recursive walk(phase_id, path) as (
    -- Start at the new edge's successor and follow links forward.
    select new.successor_phase_id, array[new.predecessor_phase_id, new.successor_phase_id]

    union all

    select d.successor_phase_id, w.path || d.successor_phase_id
      from ship.phase_dependencies d
      join walk w on d.predecessor_phase_id = w.phase_id
     where not (d.successor_phase_id = any (w.path))
  )
  select w.path into v_cycle
    from walk w
    join ship.phase_dependencies d on d.predecessor_phase_id = w.phase_id
   where d.successor_phase_id = new.predecessor_phase_id
   limit 1;

  if v_cycle is not null then
    raise exception 'phase_dependencies: this link would create a cycle (%)', v_cycle
      using errcode = '23514',
            hint = 'A phase cannot depend, directly or transitively, on a phase that depends on it.';
  end if;

  return null;
end;
$$;

revoke all on function ship.assert_no_dependency_cycle() from public, anon, authenticated;

drop trigger if exists phase_dependencies_aa_sync_project on ship.phase_dependencies;
create trigger phase_dependencies_aa_sync_project
  before insert or update on ship.phase_dependencies
  for each row execute function ship.sync_phase_dependency_project();

drop trigger if exists phase_dependencies_zz_no_cycle on ship.phase_dependencies;
create trigger phase_dependencies_zz_no_cycle
  after insert or update on ship.phase_dependencies
  for each row execute function ship.assert_no_dependency_cycle();

-- ---------------------------------------------------------------------
-- Built-in phase templates
--
-- Seeded here rather than in seeds/001_seed.sql because they are not
-- fixture data -- they are part of the schema's meaning, and a project
-- created on a fresh database must be able to pick one.
--
-- Idempotent via a name lookup: `on conflict` needs a unique constraint
-- that would be wrong to add (a project may name a custom template
-- anything, including these names).
-- ---------------------------------------------------------------------
do $$
declare
  v_template_id uuid;
begin
  -- -------------------------------------------------------------------
  -- 1. DCAMM Study + Design
  --
  -- Transcribed EXACTLY from Steve's message during the meeting:
  --
  --   * Draft Study to Bidding phases represent 10% of the Total Project
  --     Cost (TPC)
  --       o Draft Study (Study Phase Tasks 1-5) were valued at 1% TPC
  --       o SD & Certifiable Study (Study Phase Tasks 6 & 7) and DD, CD
  --         & Bidding (Design Phase Tasks 1-4) were valued at 9% TPC
  --   * Construction & Close-out (Design Phase Tasks 5 & 6) represent
  --     90% of the Total Project Cost (TPC)
  --
  -- Three steps, 1 / 9 / 90, because that is what he wrote. The 9% step
  -- covers both SD/Certifiable and DD/CD/Bidding as a single bucket --
  -- subdividing it would mean inventing a split he did not give, and a
  -- firm that wants SD scheduled apart from CD can split the step
  -- themselves. Research could not corroborate these percentages as a
  -- published DCAMM standard, so treat them as this firm's convention.
  --
  -- Task numbering: "Study Tasks 6 & 7 = SD + Certifiable Study" is
  -- confirmed against DCAMM DSB filings. The Tasks 1-5 and Design Tasks
  -- 1-4 / 5-6 boundaries are consistent with the contract's described
  -- scope but were not independently verified, and DCAMM has revised
  -- this template contract more than once. Worth checking against the
  -- signed Exhibit A before anyone treats these labels as authoritative.
  -- -------------------------------------------------------------------
  select id into v_template_id from ship.phase_templates
   where is_builtin and name = 'DCAMM Study + Design';

  if v_template_id is null then
    insert into ship.phase_templates (project_id, name, description, is_builtin)
    values (null, 'DCAMM Study + Design',
            'Massachusetts DCAMM study and design task structure. Percentages follow the 1/9/90 TPC split used on the State House envelope study.',
            true)
    returning id into v_template_id;

    insert into ship.phase_template_steps
      (template_id, name, kind, sort_order, default_pct_of_tpc, default_duration_slots)
    values
      (v_template_id, 'Draft Study (Study Tasks 1-5)',                  'study',        0,  1, 1),
      (v_template_id, 'SD, Certifiable Study, DD, CD & Bidding',        'design',       1,  9, 2),
      (v_template_id, 'Construction & Close-out (Design Tasks 5-6)',    'construction', 2, 90, 3);
  end if;

  -- -------------------------------------------------------------------
  -- 2. AIA Standard Phases
  --
  -- The uncontested generic set. Programming is included because most
  -- owners contract it, but it is first so a firm whose basic services
  -- start at SD can delete one row.
  --
  -- The percentages keep the same 10/90 design-to-construction shape,
  -- which is the common design-fee-as-a-share-of-project-cost rule of
  -- thumb, spread across the phases. They are a starting point to be
  -- edited per project, not a claim about any firm's fee structure.
  -- -------------------------------------------------------------------
  select id into v_template_id from ship.phase_templates
   where is_builtin and name = 'AIA Standard Phases';

  if v_template_id is null then
    insert into ship.phase_templates (project_id, name, description, is_builtin)
    values (null, 'AIA Standard Phases',
            'Programming through Closeout. Percentages are a 10/90 design-to-construction starting point, meant to be edited per project.',
            true)
    returning id into v_template_id;

    insert into ship.phase_template_steps
      (template_id, name, kind, sort_order, default_pct_of_tpc, default_duration_slots)
    values
      (v_template_id, 'Programming',                'study',        0,  0.5, 1),
      (v_template_id, 'Schematic Design',           'design',       1,  1.5, 1),
      (v_template_id, 'Design Development',         'design',       2,  2.0, 1),
      (v_template_id, 'Construction Documents',     'design',       3,  5.0, 1),
      (v_template_id, 'Bidding / Procurement',      'design',       4,  1.0, 1),
      (v_template_id, 'Construction Administration','construction', 5, 87.0, 3),
      (v_template_id, 'Closeout',                   'closeout',     6,  3.0, 1);
  end if;

  -- -------------------------------------------------------------------
  -- 3. Design + Construction
  --
  -- The minimum that satisfies the actual ask -- design separable from
  -- construction, with a lag between them -- and nothing else. This is
  -- the right default for a firm that has not yet decided how it wants
  -- to break its phases down, and it is deliberately listed so that
  -- "just split design from construction" does not require deleting five
  -- rows off a bigger template.
  -- -------------------------------------------------------------------
  select id into v_template_id from ship.phase_templates
   where is_builtin and name = 'Design + Construction';

  if v_template_id is null then
    insert into ship.phase_templates (project_id, name, description, is_builtin)
    values (null, 'Design + Construction',
            'Two phases. The minimum that separates design from construction so the two can be scheduled independently.',
            true)
    returning id into v_template_id;

    insert into ship.phase_template_steps
      (template_id, name, kind, sort_order, default_pct_of_tpc, default_duration_slots)
    values
      (v_template_id, 'Design',       'design',       0, 10, 1),
      (v_template_id, 'Construction', 'construction', 1, 90, 3);
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- project_cost_settings.default_phase_template_id
--
-- Which template a newly created package draws its phases from. Lives on
-- the cost settings row rather than the timeline settings row because it
-- carries the pct_of_tpc allocation, which is a cost decision.
--
-- Nullable: a project that has not chosen one gets packages with no
-- phases, which the UI surfaces as "this package is not scheduled yet"
-- rather than guessing a taxonomy on the firm's behalf. Guessing here
-- would put percentages in front of a client that nobody chose.
--
-- `on delete set null` rather than cascade -- deleting a custom template
-- must not delete the project's cost settings along with it.
-- ---------------------------------------------------------------------
alter table ship.project_cost_settings
  add column if not exists default_phase_template_id uuid
    references ship.phase_templates(id) on delete set null;

-- ---------------------------------------------------------------------
-- Backfill: chunk_projects.timeline_segments -> chunk_phases
--
-- Every existing segment becomes one construction-kind phase, splitting
-- pct_of_tpc evenly. That is a faithful migration of what v1 actually
-- modelled: packages whose entire cost is construction, optionally split
-- across two windows. It deliberately does NOT invent a design phase --
-- v1 had no design data, and fabricating one would put numbers in front
-- of the client that nobody supplied.
--
-- timeline_segments is left in place and simply stops being written.
-- That keeps this migration reversible on a database that already has
-- real schedules in it; a later release drops the column.
--
-- Guarded on "this chunk has no phases yet" so re-running never
-- duplicates. Note that means it will NOT re-derive phases for a chunk
-- someone has since edited, which is the correct behaviour.
--
-- On a FRESH database this is a no-op, because the CLI applies
-- migrations before seeds, so chunk_projects is still empty here. That
-- is expected and harmless -- the statement exists for databases that
-- already hold real v1 schedules. Local fixture phases come from
-- seeds/002_v2_phases.sql instead.
-- ---------------------------------------------------------------------
insert into ship.chunk_phases
  (chunk_project_id, name, kind, sort_order, pct_of_tpc, start_slot, duration_slots)
select
  c.id,
  case when seg.total = 1 then 'Construction'
       else 'Construction ' || (seg.idx + 1) || ' of ' || seg.total
  end,
  'construction',
  seg.idx,
  round(100.0 / seg.total, 4),
  greatest(coalesce((seg.value ->> 'start')::numeric, 0), 0),
  greatest(coalesce((seg.value ->> 'duration')::numeric, 1), 1)
from ship.chunk_projects c
cross join lateral (
  select
    (row_number() over (order by coalesce((s.value ->> 'start')::numeric, 0)))::int - 1 as idx,
    count(*) over ()                                                                    as total,
    s.value
  from jsonb_array_elements(
         case when jsonb_typeof(c.timeline_segments) = 'array'
                   and jsonb_array_length(c.timeline_segments) > 0
              then c.timeline_segments
              -- A chunk with no segments still gets one phase, from the
              -- scalar timeline_start/timeline_duration columns, so no
              -- package silently vanishes off the timeline.
              else jsonb_build_array(jsonb_build_object(
                     'start',    coalesce(c.timeline_start, 0),
                     'duration', coalesce(c.timeline_duration, 1)))
         end
       ) as s(value)
) as seg
where not exists (select 1 from ship.chunk_phases p where p.chunk_project_id = c.id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
grant select                         on ship.phase_templates      to authenticated;
grant insert, update, delete         on ship.phase_templates      to authenticated;
grant select                         on ship.phase_template_steps to authenticated;
grant insert, update, delete         on ship.phase_template_steps to authenticated;
grant select, insert, update, delete on ship.chunk_phases         to authenticated;
grant select, insert, update, delete on ship.phase_dependencies   to authenticated;

alter table ship.phase_templates      enable row level security;
alter table ship.phase_template_steps enable row level security;
alter table ship.chunk_phases         enable row level security;
alter table ship.phase_dependencies   enable row level security;

-- ---------------------------------------------------------------------
-- Policies
--
-- chunk_phases and phase_dependencies are readable AND writable by any
-- project member, matching the chunk_projects policies in 0002 and for
-- the same stated reason: consultants are routed to the Chunking and
-- Timeline tabs, so an admin-only write policy hands them a UI that
-- silently fails on every drag.
--
-- >>> 0009 NARROWS THIS. The spec's role matrix makes the schedule
-- >>> read-only for consultants, writable by editors and admins. These
-- >>> four write policies plus the three in 0002 are the complete set to
-- >>> change; swap ship.can_read_project(...) for the project-role
-- >>> helper and leave every select policy alone.
-- ---------------------------------------------------------------------
drop policy if exists phase_templates_select on ship.phase_templates;
drop policy if exists phase_templates_write  on ship.phase_templates;

-- Built-ins (project_id is null) are readable by every active SHIP user;
-- a project's own templates only by people on that project.
create policy phase_templates_select on ship.phase_templates
  for select to authenticated
  using (
    (project_id is null and ship.is_active_user())
    or ship.can_read_project(project_id)
  );

-- `project_id is not null` in BOTH clauses is what stops a member from
-- creating or converting a template into a built-in, which would publish
-- it to every user of the database. The WITH CHECK half is the one that
-- matters on UPDATE: without it, USING passes on a row they own and the
-- new project_id is never validated.
create policy phase_templates_write on ship.phase_templates
  for all to authenticated
  using      (project_id is not null and ship.can_read_project(project_id))
  with check (project_id is not null and ship.can_read_project(project_id));

drop policy if exists phase_template_steps_select on ship.phase_template_steps;
drop policy if exists phase_template_steps_write  on ship.phase_template_steps;

create policy phase_template_steps_select on ship.phase_template_steps
  for select to authenticated
  using (
    exists (
      select 1 from ship.phase_templates t
       where t.id = template_id
         and ((t.project_id is null and ship.is_active_user())
              or ship.can_read_project(t.project_id))
    )
  );

create policy phase_template_steps_write on ship.phase_template_steps
  for all to authenticated
  using (
    exists (select 1 from ship.phase_templates t
             where t.id = template_id
               and t.project_id is not null
               and ship.can_read_project(t.project_id))
  )
  with check (
    exists (select 1 from ship.phase_templates t
             where t.id = template_id
               and t.project_id is not null
               and ship.can_read_project(t.project_id))
  );

drop policy if exists chunk_phases_select on ship.chunk_phases;
drop policy if exists chunk_phases_write  on ship.chunk_phases;

create policy chunk_phases_select on ship.chunk_phases
  for select to authenticated
  using (ship.can_access_chunk(chunk_project_id));

create policy chunk_phases_write on ship.chunk_phases
  for all to authenticated
  using      (ship.can_access_chunk(chunk_project_id))
  with check (ship.can_access_chunk(chunk_project_id));

drop policy if exists phase_dependencies_select on ship.phase_dependencies;
drop policy if exists phase_dependencies_write  on ship.phase_dependencies;

create policy phase_dependencies_select on ship.phase_dependencies
  for select to authenticated
  using (ship.can_read_project(project_id));

-- Both endpoints are checked, not just the denormalised project_id. The
-- trigger already refuses cross-project links, but a policy that trusted
-- project_id alone would be relying on a trigger for a security
-- boundary; these two `can_access_phase` calls make the policy
-- self-sufficient.
create policy phase_dependencies_write on ship.phase_dependencies
  for all to authenticated
  using (
    ship.can_read_project(project_id)
    and ship.can_access_phase(predecessor_phase_id)
    and ship.can_access_phase(successor_phase_id)
  )
  with check (
    ship.can_read_project(project_id)
    and ship.can_access_phase(predecessor_phase_id)
    and ship.can_access_phase(successor_phase_id)
  );

commit;

-- =====================================================================
-- ROLLBACK
--
-- begin;
--   drop trigger  if exists phase_dependencies_zz_no_cycle    on ship.phase_dependencies;
--   drop trigger  if exists phase_dependencies_aa_sync_project on ship.phase_dependencies;
--   drop table    if exists ship.phase_dependencies;
--   drop table    if exists ship.chunk_phases;
--   drop table    if exists ship.phase_template_steps;
--   alter table ship.project_cost_settings drop column if exists default_phase_template_id;
--   drop table    if exists ship.phase_templates;
--   drop function if exists ship.assert_no_dependency_cycle();
--   drop function if exists ship.sync_phase_dependency_project();
--   drop function if exists ship.can_access_phase(uuid);
--   drop function if exists ship.phase_project_id(uuid);
-- commit;
--
-- chunk_projects.timeline_segments was never modified, so v1's timeline
-- keeps working after a rollback.
--
-- HOW TO VERIFY
--
-- -- Backfill produced one phase per former segment, summing to 100%:
-- select c.chunk_number, count(*) phases, sum(p.pct_of_tpc) pct
--   from ship.chunk_projects c join ship.chunk_phases p on p.chunk_project_id = c.id
--  group by c.chunk_number order by 1;
--
-- -- Cycle detection (expect 23514 on the third insert):
-- begin;
--   with p as (select id from ship.chunk_phases limit 3)
--   select * from p;
--   -- A->B, B->C, then C->A must fail.
-- rollback;
--
-- -- Cross-project link is refused (expect 23514):
-- insert into ship.phase_dependencies (predecessor_phase_id, successor_phase_id)
-- select a.id, b.id
--   from ship.chunk_phases a, ship.chunk_phases b
--  where ship.phase_project_id(a.id) <> ship.phase_project_id(b.id)
--  limit 1;
-- =====================================================================
