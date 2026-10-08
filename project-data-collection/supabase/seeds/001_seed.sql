-- =====================================================================
-- seeds/001_seed.sql
-- SHIP -- the lib/mock-*.ts fixtures, translated.
--
-- Source of truth for every value below:
--   lib/mock-users.ts       SEED_USERS            (10 emails)
--   lib/mock-projects.ts    SEED_PROJECTS         (3)
--   lib/mock-line-items.ts  SEED_LINE_ITEMS       (12)
--   lib/mock-chunks.ts      SEED_CHUNK_PROJECTS   (5)
--                           SEED_TIMELINE_SETTINGS(1)
--
-- RUN THIS AS THE MIGRATION OWNER (the SQL editor's postgres role, or
-- the service_role connection). RLS is enabled on every table and there
-- is no policy that would let `authenticated` write most of this.
--
-- NO PASSWORDS, AND NOTHING IS WRITTEN TO auth.users. The TS mock stored
-- 'admin123' / 'consultant123' in localStorage; the real accounts are
-- created by Supabase self-signup, and ship.claim_invite() turns them
-- into SHIP users. All this file does is put the ten emails on the
-- allowlist.
--
-- Re-runnable: every statement is `on conflict do nothing` or an
-- idempotent upsert.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. pending_invites -- the allowlist (SEED_USERS)
-- Only admin@gmail.com is an admin. `role` here is what claim_invite()
-- stamps onto the ship.profiles row.
-- ---------------------------------------------------------------------
insert into ship.pending_invites (email, name, role) values
  ('admin@gmail.com',              'Admin User',              'admin'),
  ('consultant1@gmail.com',        'Consultant One',          'consultant'),
  ('consultant2@gmail.com',        'Consultant Two',          'consultant'),
  ('planning@atlasmech.com',       'Atlas MEP',               'consultant'),
  ('structural@coredesign.com',    'Core Design Structures',  'consultant'),
  ('electrical@voltworks.com',     'Volt Works',              'consultant'),
  ('civil@terrainlab.com',         'Terrain Lab',             'consultant'),
  ('historic@heritagestudio.com',  'Heritage Studio',         'consultant'),
  ('access@openpath.com',          'Open Path',               'consultant'),
  ('landscape@fieldoffice.com',    'Field Office',            'consultant')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------
-- 2. projects
-- `created_by` is null: nobody has an auth.users row yet at seed time,
-- and projects.created_by -> profiles.id would fail. It is nullable for
-- exactly this reason.
-- ---------------------------------------------------------------------
insert into ship.projects (id, name, created_at, created_by) values
  ('library-renovation',         'Boston Library Renovation',   date '2026-03-10', null),
  ('school-modernization',       'School Modernization Package',date '2026-03-12', null),
  ('federal-campus-master-plan', 'Federal Campus Master Plan',  date '2026-04-01', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3. project_consultants  (14 rows)
-- ---------------------------------------------------------------------
insert into ship.project_consultants (project_id, consultant_type, org_name) values
  -- library-renovation
  ('library-renovation',         'Architecture',           'FAA'),
  ('library-renovation',         'Mechanical',             'North MEP Studio'),
  ('library-renovation',         'Structural',             'FrameWorks Engineering'),
  -- school-modernization
  ('school-modernization',       'Architecture',           'FAA'),
  ('school-modernization',       'Electrical',             'Volt Systems'),
  ('school-modernization',       'Accessibility',          'Access Forward'),
  -- federal-campus-master-plan
  ('federal-campus-master-plan', 'Architecture',           'FAA'),
  ('federal-campus-master-plan', 'Mechanical',             'Atlas MEP'),
  ('federal-campus-master-plan', 'Structural',             'Core Design Structures'),
  ('federal-campus-master-plan', 'Electrical',             'Volt Works'),
  ('federal-campus-master-plan', 'Civil',                  'Terrain Lab'),
  ('federal-campus-master-plan', 'Historic Preservation',  'Heritage Studio'),
  ('federal-campus-master-plan', 'Accessibility',          'Open Path'),
  ('federal-campus-master-plan', 'Landscape',              'Field Office')
on conflict (project_id, consultant_type) do nothing;

-- ---------------------------------------------------------------------
-- 4. project_members -- consultants[].emails AND assignedUsers, merged
--
-- >>> MOCK-DATA INCONSISTENCY, RESOLVED HERE -- READ THIS <<<
-- In lib/mock-projects.ts the two arrays disagree:
--
--   library-renovation.assignedUsers   = ['consultant1@gmail.com']
--   school-modernization.assignedUsers = ['consultant2@gmail.com']
--
-- ...but neither address appears anywhere in that project's
-- consultants[].emails. In the old model assignedUsers was what granted
-- access, so those two demo logins could open those projects. In the new
-- model project_members is the single source of both, and
-- consultant_type is part of its primary key -- an assigned user with no
-- discipline has nowhere to live.
--
-- Resolution: they are seeded under 'Architecture' (the one discipline
-- present on all three projects) so the demo consultant logins keep
-- working, and each is flagged ORPHAN below with why it is there.
--
-- This is a deliberate trade, not an oversight. Keeping them costs one
-- wrong-looking address inside the Architecture consultant's email list
-- in SettingsTab. Dropping them costs the two demo consultant logins
-- their only membership in those projects -- consultant1@gmail.com and
-- consultant2@gmail.com would sign in and see nothing, because under the
-- new model project_members is what grants access. We keep them; the
-- demo matters more than the cosmetic list entry. Do not delete an
-- ORPHAN row without also giving that account membership some other way.
--
-- The reverse case needs no fix: emails that were in consultants[].emails
-- but NOT in assignedUsers (mep@northstudio.com, team@frameworks.com,
-- lead@frameworks.com, info@voltsystems.com, review@accessforward.com,
-- access@openpath.com, landscape@fieldoffice.com) become real members
-- here. That is the intended new semantics, not a data change.
-- ---------------------------------------------------------------------
insert into ship.project_members (project_id, email, consultant_type) values
  -- library-renovation
  ('library-renovation',         'admin@gmail.com',             'Architecture'),
  -- ORPHAN: consultant1@gmail.com is in library-renovation.assignedUsers
  -- but in none of its consultants[].emails, so it has no discipline of
  -- its own; 'Architecture' is a placeholder chosen only because every
  -- project has it. KEEP IT: this is the demo consultant login, and
  -- project_members is now the only thing granting project access --
  -- delete this row and consultant1@gmail.com can no longer open
  -- library-renovation at all. Cost of keeping it: the address appears in
  -- the Architecture consultant's email list in SettingsTab.
  ('library-renovation',         'consultant1@gmail.com',       'Architecture'),
  ('library-renovation',         'mep@northstudio.com',         'Mechanical'),
  ('library-renovation',         'team@frameworks.com',         'Structural'),
  ('library-renovation',         'lead@frameworks.com',         'Structural'),
  -- school-modernization
  ('school-modernization',       'admin@gmail.com',             'Architecture'),
  -- ORPHAN: same story as consultant1@gmail.com above --
  -- consultant2@gmail.com is in school-modernization.assignedUsers only,
  -- has no discipline, and is parked under the placeholder 'Architecture'.
  -- KEEP IT: it is the second demo consultant login, and removing it
  -- revokes that account's access to school-modernization. Cost of
  -- keeping it: it widens the Architecture consultant's email list in
  -- SettingsTab.
  ('school-modernization',       'consultant2@gmail.com',       'Architecture'),
  ('school-modernization',       'info@voltsystems.com',        'Electrical'),
  ('school-modernization',       'review@accessforward.com',    'Accessibility'),
  -- federal-campus-master-plan
  ('federal-campus-master-plan', 'admin@gmail.com',             'Architecture'),
  ('federal-campus-master-plan', 'planning@atlasmech.com',      'Mechanical'),
  ('federal-campus-master-plan', 'structural@coredesign.com',   'Structural'),
  ('federal-campus-master-plan', 'electrical@voltworks.com',    'Electrical'),
  ('federal-campus-master-plan', 'civil@terrainlab.com',        'Civil'),
  ('federal-campus-master-plan', 'historic@heritagestudio.com', 'Historic Preservation'),
  ('federal-campus-master-plan', 'access@openpath.com',         'Accessibility'),
  ('federal-campus-master-plan', 'landscape@fieldoffice.com',   'Landscape')
on conflict do nothing;

-- Five member emails above are NOT in SEED_USERS, so without this they
-- could never sign in -- ship.claim_invite() would reject them. This is
-- exactly what ship.ensure_invites() does inside create_project(), just
-- replayed for the fixture data. Delete this block if the seed should
-- only ever admit the ten SEED_USERS.
insert into ship.pending_invites (email, name, role)
select pm.email,
       initcap(regexp_replace(split_part(pm.email, '@', 1), '[._-]+', ' ', 'g')),
       'consultant'
  from (select distinct email from ship.project_members) pm
on conflict (email) do nothing;

-- ---------------------------------------------------------------------
-- 5. line_items  (12 rows)
--
-- DETERMINISTIC UUIDs. The TS ids were 'seed-li-001'...'seed-li-012';
-- here they map to 00000000-0000-4000-8000-0000000000NN with the same NN,
-- so section 7 can reference them as literals instead of resolving them
-- through a lookup CTE.
--
-- item_number is supplied EXPLICITLY so ship.fill_item_number() (0003)
-- passes the row straight through and the A1/M1/HP1 values survive.
-- company_name is likewise supplied, so ship.normalize_line_item() does
-- not re-derive it.
-- ---------------------------------------------------------------------
insert into ship.line_items (
  id, project_id, user_email, consultant_type, company_name, discipline, item_number,
  name, short_description, category, timeline_priority,
  building_area_impacted, building_level_impacted,
  operational_impact, benefit_to_users, benefit_to_public,
  relative_first_cost, estimated_first_cost,
  relative_operation_cost_impact, relative_operational_energy_usage, electrification_eo594,
  addressing_resiliency_sustainability, addressing_deferred_maintenance,
  code_life_safety_improvement, accessibility_improvement, historic_impact,
  potential_synergies, supporting_notes, created_at
) values
  ('00000000-0000-4000-8000-000000000001', 'federal-campus-master-plan', 'admin@gmail.com',
   'Architecture', 'FAA', 'Architecture', 'A1',
   'Campus Arrival Sequence Upgrade',
   'Rework front-of-house arrival, screening, and lobby circulation.',
   'UPGRADES / IMPROVEMENTS', '1_HIGH <5 years',
   'SITE', 'WHOLE BUILDING',
   'MODERATE', 'HIGH', 'MODERATE',
   '$$$High', '$2,400,000',
   'MINIMAL IMPACT', 'MINIMAL IMPACT', 'LOW',
   'Yes', 'No', 'Yes', 'Yes', 'No',
   ARRAY['Civil','Landscape','Security']::text[],
   'Coordinate entry canopy, site grading, and queueing.',
   timestamptz '2026-04-01T09:00:00.000Z'),

  ('00000000-0000-4000-8000-000000000002', 'federal-campus-master-plan', 'planning@atlasmech.com',
   'Mechanical', 'Atlas MEP', 'Mechanical', 'M1',
   'Central Plant Decarbonization',
   'Replace aging boilers with electric heat pump plant.',
   'END OF LIFE', '0_PRIORITY *',
   'WHOLE BUILDING', 'LEVELS BELOW GRADE',
   'HIGH', 'MODERATE', 'HIGH',
   '$$$High', '$6,800,000',
   'HIGH REDUCTION', 'HIGH REDUCTION', 'HIGH',
   'Yes', 'Yes', 'No', 'No', 'No',
   ARRAY['Electrical','Structural']::text[],
   'Phasing required to maintain heating through winter.',
   timestamptz '2026-04-01T09:15:00.000Z'),

  ('00000000-0000-4000-8000-000000000003', 'federal-campus-master-plan', 'structural@coredesign.com',
   'Structural', 'Core Design Structures', 'Structural', 'S1',
   'Roof Framing Reinforcement',
   'Targeted strengthening for mechanical yard and solar loads.',
   'DEFERRED MAINTENANCE', '1_HIGH <5 years',
   'WHOLE BUILDING', 'ROOF',
   'LOW', 'LOW', 'LOW',
   '$$Moderate', '$1,150,000',
   'N/A', 'N/A', 'LOW',
   'Yes', 'Yes', 'Yes', 'No', 'No',
   ARRAY['Mechanical','Electrical']::text[],
   'Sequence with roof replacement and photovoltaic work.',
   timestamptz '2026-04-01T09:30:00.000Z'),

  ('00000000-0000-4000-8000-000000000004', 'federal-campus-master-plan', 'electrical@voltworks.com',
   'Electrical', 'Volt Works', 'Electrical', 'E1',
   'Emergency Power Renewal',
   'Upgrade generators, ATS gear, and distribution redundancy.',
   'END OF LIFE', '0_PRIORITY *',
   'WHOLE BUILDING', 'LEVELS BELOW GRADE',
   'HIGH', 'HIGH', 'MODERATE',
   '$$$High', '$3,250,000',
   'MINIMAL IMPACT', 'N/A', 'MODERATE',
   'Yes', 'Yes', 'Yes', 'No', 'No',
   ARRAY['Mechanical','Architecture']::text[],
   'Coordinate outage windows with tenant operations.',
   timestamptz '2026-04-01T09:45:00.000Z'),

  ('00000000-0000-4000-8000-000000000005', 'federal-campus-master-plan', 'civil@terrainlab.com',
   'Civil', 'Terrain Lab', 'Civil', 'C1',
   'Stormwater Resilience Package',
   'Bioswales, detention, and site drainage replacement.',
   'UPGRADES / IMPROVEMENTS', '2_MID 5-10 years',
   'SITE', 'WHOLE BUILDING',
   'MODERATE', 'LOW', 'HIGH',
   '$$Moderate', '$1,980,000',
   'MINIMAL IMPACT', 'N/A', 'NONE',
   'Yes', 'Yes', 'No', 'No', 'No',
   ARRAY['Landscape','Architecture']::text[],
   'Integrate with plaza reconstruction and planting upgrades.',
   timestamptz '2026-04-01T10:00:00.000Z'),

  ('00000000-0000-4000-8000-000000000006', 'federal-campus-master-plan', 'historic@heritagestudio.com',
   'Historic Preservation', 'Heritage Studio', 'Historic Preservation', 'HP1',
   'Stone Facade Conservation',
   'Repair masonry, lintels, sealants, and ornamental stone.',
   'RESTORATION *', '1_HIGH <5 years',
   'WHOLE BUILDING', 'ENVELOPE (EXT. WALLS)',
   'LOW', 'MODERATE', 'HIGH',
   '$$$High', '$4,300,000',
   'MINIMAL IMPACT', 'MINIMAL IMPACT', 'NONE',
   'Yes', 'Yes', 'No', 'No', 'Yes',
   ARRAY['Architecture','Structural']::text[],
   'Requires mockups and preservation review.',
   timestamptz '2026-04-01T10:15:00.000Z'),

  ('00000000-0000-4000-8000-000000000007', 'federal-campus-master-plan', 'access@openpath.com',
   'Accessibility', 'Open Path', 'Accessibility', 'AC1',
   'Accessible Vertical Circulation Refresh',
   'Upgrade elevator cab controls, wayfinding, and refuge signage.',
   'UPGRADES / IMPROVEMENTS', '1_HIGH <5 years',
   'WHOLE BUILDING', 'LEVELS ABOVE GRADE',
   'LOW', 'HIGH', 'LOW',
   '$$Moderate', '$820,000',
   'N/A', 'N/A', 'NONE',
   'No', 'No', 'Yes', 'Yes', 'No',
   ARRAY['Architecture','Electrical']::text[],
   'Coordinate with elevator modernization sequence.',
   timestamptz '2026-04-01T10:30:00.000Z'),

  ('00000000-0000-4000-8000-000000000008', 'federal-campus-master-plan', 'landscape@fieldoffice.com',
   'Landscape', 'Field Office', 'Landscape', 'L1',
   'Perimeter Security Landscape Buffer',
   'Rework planting and low walls at public perimeter.',
   'UPGRADES / IMPROVEMENTS', '2_MID 5-10 years',
   'SITE', 'WHOLE BUILDING',
   'LOW', 'MODERATE', 'MODERATE',
   '$$Moderate', '$640,000',
   'MINIMAL IMPACT', 'N/A', 'NONE',
   'Yes', 'No', 'No', 'No', 'No',
   ARRAY['Civil','Architecture']::text[],
   'Coordinate with stormwater package.',
   timestamptz '2026-04-01T10:45:00.000Z'),

  ('00000000-0000-4000-8000-000000000009', 'federal-campus-master-plan', 'admin@gmail.com',
   'Architecture', 'FAA', 'Architecture', 'A2',
   'Workplace Restack and Swing Space',
   'Multi-floor phased restack to unlock renovation moves.',
   'STUDY / DOCUMENTATION', '0_PRIORITY *',
   'WHOLE BUILDING', 'LEVELS ABOVE GRADE',
   'MODERATE', 'HIGH', 'LOW',
   '$$Moderate', '$950,000',
   'INCREASE', 'N/A', 'NONE',
   'No', 'No', 'No', 'No', 'No',
   ARRAY['Mechanical','Electrical','Accessibility']::text[],
   'Needed to support central plant and life safety work.',
   timestamptz '2026-04-01T11:00:00.000Z'),

  ('00000000-0000-4000-8000-000000000010', 'federal-campus-master-plan', 'electrical@voltworks.com',
   'Electrical', 'Volt Works', 'Electrical', 'E2',
   'Lighting and Controls Modernization',
   'Campus-wide LED conversion and occupancy/daylight controls.',
   'UPGRADES / IMPROVEMENTS', '2_MID 5-10 years',
   'WHOLE BUILDING', 'LEVELS ABOVE GRADE',
   'MODERATE', 'MODERATE', 'LOW',
   '$$Moderate', '$1,420,000',
   'MODERATE REDUCTION', 'HIGH REDUCTION', 'MODERATE',
   'Yes', 'Yes', 'No', 'No', 'No',
   ARRAY['Architecture','Mechanical']::text[],
   'Best grouped by floor swing package.',
   timestamptz '2026-04-01T11:15:00.000Z'),

  ('00000000-0000-4000-8000-000000000011', 'federal-campus-master-plan', 'planning@atlasmech.com',
   'Mechanical', 'Atlas MEP', 'Mechanical', 'M2',
   'Floor-by-Floor Airside Renewal',
   'Replace VAVs, branch ductwork, and floor distribution by phase.',
   'DEFERRED MAINTENANCE', '2_MID 5-10 years',
   'WHOLE BUILDING', 'LEVELS ABOVE GRADE',
   'HIGH', 'HIGH', 'LOW',
   '$$$High', '$5,600,000',
   'MODERATE REDUCTION', 'MODERATE REDUCTION', 'LOW',
   'Yes', 'Yes', 'No', 'No', 'No',
   ARRAY['Electrical','Architecture']::text[],
   'Link to phased workplace restack and controls package.',
   timestamptz '2026-04-01T11:30:00.000Z'),

  ('00000000-0000-4000-8000-000000000012', 'federal-campus-master-plan', 'admin@gmail.com',
   'Architecture', 'FAA', 'Architecture', 'A3',
   'Public Meeting Center Renovation',
   'Reconfigure ceremonial and public-facing event rooms.',
   'UPGRADES / IMPROVEMENTS', '3_LOW 10-20 years',
   'ANNEX', 'L1',
   'LOW', 'HIGH', 'HIGH',
   '$$Moderate', '$1,780,000',
   'MINIMAL IMPACT', 'MINIMAL IMPACT', 'NONE',
   'No', 'No', 'Yes', 'Yes', 'Yes',
   ARRAY['Historic Preservation','Electrical','Accessibility']::text[],
   'Could be split into enabling and fit-out phases.',
   timestamptz '2026-04-01T11:45:00.000Z')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 6. chunk_projects  (5 rows)
-- 'seed-chunk-00N' -> 00000000-0000-4000-8000-00000000010N.
-- chunk_number is explicit so ship.fill_chunk_number() passes through and
-- PP10..PP14 survive.
-- timeline_segments keeps the original string segment ids -- the timeline
-- editor treats them as opaque React keys.
-- ---------------------------------------------------------------------
insert into ship.chunk_projects (
  id, project_id, chunk_number, name, timeline_segments,
  timeline_start, timeline_duration, created_at
) values
  ('00000000-0000-4000-8000-000000000101', 'federal-campus-master-plan', 'PP10',
   'Infrastructure Stabilization',
   '[{"id":"seed-chunk-001-a","start":0,"duration":4},
     {"id":"seed-chunk-001-b","start":8,"duration":2}]'::jsonb,
   0, 4, timestamptz '2026-04-01T12:00:00.000Z'),

  ('00000000-0000-4000-8000-000000000102', 'federal-campus-master-plan', 'PP11',
   'Envelope and Preservation',
   '[{"id":"seed-chunk-002-a","start":2,"duration":5}]'::jsonb,
   2, 5, timestamptz '2026-04-01T12:10:00.000Z'),

  ('00000000-0000-4000-8000-000000000103', 'federal-campus-master-plan', 'PP12',
   'Campus Site Resilience',
   '[{"id":"seed-chunk-003-a","start":5,"duration":3}]'::jsonb,
   5, 3, timestamptz '2026-04-01T12:20:00.000Z'),

  ('00000000-0000-4000-8000-000000000104', 'federal-campus-master-plan', 'PP13',
   'Interior Access and Restack',
   '[{"id":"seed-chunk-004-a","start":1,"duration":2},
     {"id":"seed-chunk-004-b","start":6,"duration":4}]'::jsonb,
   1, 2, timestamptz '2026-04-01T12:30:00.000Z'),

  ('00000000-0000-4000-8000-000000000105', 'federal-campus-master-plan', 'PP14',
   'Public Meeting Center',
   '[{"id":"seed-chunk-005-a","start":10,"duration":3}]'::jsonb,
   10, 3, timestamptz '2026-04-01T12:40:00.000Z')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 7. chunk_project_items  (13 rows)
-- The old ChunkProject.itemLinks array, as real rows. `position` keeps
-- the array order the fixture had.
-- ---------------------------------------------------------------------
insert into ship.chunk_project_items (chunk_project_id, line_item_id, quantity, position) values
  -- PP10 Infrastructure Stabilization
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', '1',   0),
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000003', '1',   1),
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000004', '1',   2),
  -- PP11 Envelope and Preservation
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000006', '1',   0),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000003', '0.5', 1),
  -- PP12 Campus Site Resilience
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001', '1',   0),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000005', '1',   1),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000008', '1',   2),
  -- PP13 Interior Access and Restack
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000007', '1',   0),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000009', '1',   1),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000010', '1',   2),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000011', '1',   3),
  -- PP14 Public Meeting Center
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000012', '1',   0)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 8. project_timeline_settings
-- SEED_TIMELINE_SETTINGS only covers federal-campus-master-plan. The
-- other two get the defaults from 0001, which are the same values
-- getTimelineSettingsForProject() falls back to in lib/store.ts, so the
-- Timeline tab behaves identically either way.
-- NOTE the column is `interval_unit`, not `interval` (reserved word).
-- ---------------------------------------------------------------------
-- start_calendar_year is NOT NULL since migration 0018 and is a fixed
-- fact about the project (M-25): the year it was created, never the
-- year the seed happens to run.
insert into ship.project_timeline_settings
  (project_id, years, interval_unit, zoom_level, escalation_percent, escalation_every_years,
   start_calendar_year)
values
  ('federal-campus-master-plan', 15, 'yearly', 3, 0, 5, 2026)
on conflict (project_id) do nothing;

insert into ship.project_timeline_settings (project_id, start_calendar_year)
select p.id, extract(year from p.created_at)::integer from ship.projects p
on conflict (project_id) do nothing;

-- =====================================================================
-- 9. !!!! COUNTER BACKFILL -- DO NOT SKIP THIS !!!!
--
-- Everything above inserted line items and chunks with EXPLICIT numbers,
-- which means ship.fill_item_number() / ship.fill_chunk_number() were
-- short-circuited and the counter tables are still empty. If you stop
-- here, the very first real insert allocates A1 / PP10 again and dies
-- with:
--     23505 duplicate key value violates unique constraint
--           "line_items_project_id_item_number_key"
--
-- Forgetting this step is the single most likely way to break a fresh
-- environment, and it will not show up until a human adds their first
-- line item.
--
-- Remember the semantics from 0003: next_value is the NEXT number to
-- hand out, so it is max(existing) + 1, NOT max(existing).
--
-- `greatest(...)` on conflict makes this safe to re-run at any time,
-- including after real data exists: a re-run can only ever move a
-- counter forward, never back onto a number that has already been used.
-- =====================================================================

insert into ship.item_number_counters as c (project_id, discipline, next_value)
select li.project_id,
       li.discipline,
       max(coalesce(nullif(regexp_replace(li.item_number, '^\D+', '', 'g'), '')::int, 0)) + 1
  from ship.line_items li
 where li.item_number ~ '^[A-Za-z]+[0-9]+$'
 group by li.project_id, li.discipline
on conflict (project_id, discipline)
  do update set next_value = greatest(c.next_value, excluded.next_value);

-- Chunks are base 10 (PP10 is the first one), so a project with no chunks
-- gets no row here and falls through to the default of 10 in 0001.
insert into ship.chunk_number_counters as c (project_id, next_value)
select cp.project_id,
       max(coalesce(nullif(regexp_replace(cp.chunk_number, '^\D+', '', 'g'), '')::int, 9)) + 1
  from ship.chunk_projects cp
 group by cp.project_id
on conflict (project_id)
  do update set next_value = greatest(c.next_value, excluded.next_value);

-- Every project should own a chunk counter, matching what
-- ship.create_project() seeds.
insert into ship.chunk_number_counters (project_id)
select p.id from ship.projects p
on conflict (project_id) do nothing;

commit;

-- =====================================================================
-- Expected state after this file (run these to check):
--
--   select count(*) from ship.pending_invites;    -- 15
--   select count(*) from ship.projects;           -- 3
--   select count(*) from ship.project_consultants;-- 14
--   select count(*) from ship.project_members;    -- 17
--   select count(*) from ship.line_items;         -- 12
--   select count(*) from ship.chunk_projects;     -- 5
--   select count(*) from ship.chunk_project_items;-- 13
--   select count(*) from ship.project_timeline_settings; -- 3
--   select count(*) from ship.chunk_number_counters;     -- 3
--
--   select * from ship.item_number_counters
--    order by project_id, discipline;
--   -- federal-campus-master-plan | Accessibility          | 2
--   -- federal-campus-master-plan | Architecture           | 4
--   -- federal-campus-master-plan | Civil                  | 2
--   -- federal-campus-master-plan | Electrical             | 3
--   -- federal-campus-master-plan | Historic Preservation  | 2
--   -- federal-campus-master-plan | Landscape              | 2
--   -- federal-campus-master-plan | Mechanical             | 3
--   -- federal-campus-master-plan | Structural             | 2
--   -- i.e. the next Architecture item is A4 and the next chunk is PP15.
-- =====================================================================
