-- =====================================================================
-- 0006_ship_cost_and_energy.sql
-- SHIP v2 -- per-project cost parameters, energy parameters, and the
-- numeric line-item columns both of them roll up from.
--
-- See docs/SPEC-v2-phasing-and-cost-model.md sections 1.2, 1.3 and 1.7
-- for the requirements this implements and who asked for each of them.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- -------------------------------------------------
-- Same ground rules as 0001-0005 and they have not relaxed: everything
-- in schema `ship`, no `create extension`, no trigger on `auth.users`,
-- no grant outside `ship`, nothing added to `supabase_realtime`, one
-- `begin; ... commit;`. See supabase/README.md.
--
-- This file is developed and applied against the LOCAL Docker stack
-- (supabase/LOCAL-DEV.md). It has NOT been applied to the remote
-- project and must not be until that is a separate, deliberate call.
--
-- WHY THREE TABLES INSTEAD OF WIDENING project_timeline_settings
-- --------------------------------------------------------------
-- The existing settings row answers "when do things happen". Cost
-- factors answer "what do they cost" and energy factors answer "what do
-- they save". They are edited by different people at different times --
-- a cost estimator supplies the TPC factor and escalation curve, an
-- energy engineer supplies the baseline and savings -- and they have
-- different write permissions once 0009 lands. Keeping them apart means
-- a future per-column grant is possible; one wide row forecloses that.
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
--   * Bundling cost-efficiency logic. Declined on the record: "to build
--     that logic into your application here is probably a bit much at
--     this point" (Joe), "that might be getting a little bit more
--     complicated than we necessarily want" (Steve). GCs/GRs scaling
--     with project size is real and stays a verbal conversation.
--   * S-curve cost spreading. Straight-line is what was specified:
--     "Costs for each phase were amortized over the duration of each
--     phase so that the total value of each phase were divided by the
--     number of months in duration." The engine keeps the spreading
--     function swappable, but the schema does not model a curve yet.
--   * FF&E as a separately schedulable item. It rides inside
--     tpc_factor and lands on construction: "it just gets tacked on to
--     the end to keep it clean" (Joe).
--
-- EVERY DEFAULT IN THIS FILE IS A DEFAULT, NOT A RULE
-- ---------------------------------------------------
-- 1.33x TPC, 4%/yr escalation, a July fiscal year: these are one
-- client's current working assumptions, and research could not find any
-- of them published as a DCAMM or state standard -- they are plausible
-- practitioner heuristics. The tool is being built for architecture
-- practices generally, so they live in a settings row that a different
-- firm overrides on a different project without a code change.
--
-- Re-runnable: `create table if not exists`, `add column if not
-- exists`, `create or replace function`, `drop policy if exists` +
-- `create policy`, `drop trigger if exists` + `create trigger`.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- ship.parse_cost_input(text) -> numeric
--
-- An exact port of parseCostInput() in lib/costs.ts, in the same spirit
-- as ship.discipline_prefix() porting getDisciplinePrefix() in 0003.
--
-- WHY THIS EXISTS AT ALL: line_items.estimated_first_cost is `text`,
-- because the UI lets an estimator type "$1.2m" or "850k" the way they
-- would into a spreadsheet. That is good for data entry and useless for
-- SQL -- you cannot sum it, order by it, or export it without every
-- consumer re-implementing the same parser and disagreeing about edge
-- cases. `ecc_amount` below is the parsed form, maintained by trigger,
-- so the database is the single place that parse happens.
--
-- The text column stays the input of record. This is a derived column,
-- not a replacement, which is why the UI does not need to change for it
-- to start working.
--
-- IMMUTABLE and pure: no table access, so it cannot recurse and needs
-- no SECURITY DEFINER. `set search_path = ''` is still mandatory house
-- style -- every name below resolves from pg_catalog.
-- ---------------------------------------------------------------------
create or replace function ship.parse_cost_input(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_norm       text;
  v_suffix     text;
  v_multiplier numeric;
  v_numeric    text;
  v_parsed     numeric;
begin
  -- .trim().toLowerCase().replace(/[$,\s]/g, '')
  v_norm := lower(btrim(coalesce(p_value, '')));
  v_norm := regexp_replace(v_norm, '[$,[:space:]]', '', 'g');

  if v_norm = '' then
    return 0;
  end if;

  v_suffix := right(v_norm, 1);
  v_multiplier := case v_suffix
                    when 'k' then 1000
                    when 'm' then 1000000
                    when 'b' then 1000000000
                    else 1
                  end;

  v_numeric := case when v_multiplier = 1 then v_norm else left(v_norm, -1) end;

  -- JS Number.parseFloat is lenient (leading numeric prefix wins, trailing
  -- junk ignored) where Postgres ::numeric throws. Pull the leading numeric
  -- literal out explicitly so the two agree, and fall back to 0 -- which is
  -- what `Number.isFinite(parsed) ? ... : 0` does on the TS side.
  --
  -- The exponent group MUST be non-capturing. `substring(s from pattern)`
  -- returns the FIRST CAPTURE GROUP when the pattern contains one, not the
  -- whole match -- so a capturing `([eE]...)` here returns NULL for every
  -- input without an exponent, i.e. almost all of them, and the function
  -- silently parses every cost in the database as 0.
  v_numeric := substring(v_numeric from '^[+-]?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?');

  if v_numeric is null or v_numeric = '' then
    return 0;
  end if;

  begin
    v_parsed := v_numeric::numeric;
  exception when others then
    return 0;
  end;

  return v_parsed * v_multiplier;
end;
$$;

revoke all    on function ship.parse_cost_input(text) from public;
grant execute on function ship.parse_cost_input(text) to authenticated;

-- ---------------------------------------------------------------------
-- line_items -- new numeric columns
--
-- ecc_amount             Expected Construction Cost for ONE unit of this
--                        line item, in base-year dollars, parsed from
--                        estimated_first_cost by trigger. Quantity is
--                        applied at rollup time (it lives on the
--                        chunk_project_items join row, because the same
--                        line item can appear in two packages at
--                        different quantities).
--
--                        UN-ESCALATED, deliberately and permanently:
--                        "your ECCs will not have escalation factored
--                        in, right? Because the line items don't know
--                        when they're occurring." (Megan) / "Yeah. We
--                        will keep it out, and then we can add it in."
--                        (Joe). Escalation is a function of WHERE a
--                        phase sits on the timeline and is applied at
--                        rollup, never stored here.
--
-- annual_energy_savings  Annual saving once this measure is in service,
--                        in whatever unit the project declares in
--                        project_energy_settings.unit_label. Units are
--                        deliberately not constrained -- see that table.
--
-- annual_cost_savings    Annual utility cost saving, USD. Separate from
--                        the energy figure because a fuel switch can cut
--                        cost while raising site energy, or vice versa,
--                        and collapsing them would hide that.
--
-- energy_notes           Where the number came from. An energy figure
--                        with no provenance is not usable in a
--                        deliverable six months later.
--
-- All four are nullable-free with a 0/'' default so existing rows need
-- no backfill beyond the ecc_amount trigger below.
-- ---------------------------------------------------------------------
alter table ship.line_items
  add column if not exists ecc_amount            numeric not null default 0,
  add column if not exists annual_energy_savings numeric not null default 0,
  add column if not exists annual_cost_savings   numeric not null default 0,
  add column if not exists energy_notes          text    not null default '';

comment on column ship.line_items.ecc_amount is
  'Parsed, un-escalated Expected Construction Cost per unit, derived from estimated_first_cost by ship.sync_line_item_ecc(). Do not write directly.';
comment on column ship.line_items.annual_energy_savings is
  'Annual energy saving per unit, in project_energy_settings.unit_label units. Zero means "no saving"; it does not mean "unknown".';

-- ---------------------------------------------------------------------
-- ship.sync_line_item_ecc()  -- BEFORE INSERT OR UPDATE
--
-- Keeps ecc_amount in lockstep with estimated_first_cost.
--
-- NOT a generated column, though this is exactly what one is for:
-- `generated always as (ship.parse_cost_input(estimated_first_cost))
-- stored` would be tidier. It is rejected because a stored generated
-- column permanently pins the table to that function's signature and
-- volatility -- you cannot `create or replace` the parser afterwards
-- without dropping and re-adding the column on a table that by then has
-- real data. A trigger keeps the parser replaceable, which matters for
-- something whose job is to match a TypeScript function that will
-- itself keep changing.
--
-- Not SECURITY DEFINER: it touches no table, only NEW.
-- ---------------------------------------------------------------------
create or replace function ship.sync_line_item_ecc()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.ecc_amount := ship.parse_cost_input(new.estimated_first_cost);
  return new;
end;
$$;

revoke all on function ship.sync_line_item_ecc() from public, anon, authenticated;

-- Trigger name is `line_items_cc_sync_ecc`. Postgres fires BEFORE-row
-- triggers in ALPHABETICAL NAME ORDER, and 0003 relies on that:
-- `line_items_aa_normalize` fills discipline, then
-- `line_items_bb_fill_item_number` reads it. `cc` puts this one last,
-- which is where it belongs -- it depends on nothing and nothing
-- depends on it. Do not rename it to sort before `aa`.
drop trigger if exists line_items_cc_sync_ecc on ship.line_items;
create trigger line_items_cc_sync_ecc
  before insert or update on ship.line_items
  for each row execute function ship.sync_line_item_ecc();

-- Backfill existing rows. The trigger only fires on write, so rows that
-- predate it would sit at the 0 default and silently zero out every
-- rollup. `where ecc_amount = 0` keeps the re-run cheap but is NOT the
-- correctness condition -- a genuinely zero-cost item re-parses to 0
-- anyway, so re-running this is idempotent either way.
update ship.line_items
   set ecc_amount = ship.parse_cost_input(estimated_first_cost)
 where ecc_amount = 0
   and btrim(coalesce(estimated_first_cost, '')) <> '';

-- ---------------------------------------------------------------------
-- project_timeline_settings -- calendar anchoring
--
-- v1's timeline is unanchored: slot 0 is "Year 1" and means nothing in
-- particular. Escalation and fiscal-year reporting both need it to mean
-- a real year.
--
-- start_calendar_year      The calendar year slot 0 begins in.
--
-- fiscal_year_start_month  1-12. Default 7 because the first client
--                          reports to a state whose fiscal year runs
--                          July 1 - June 30, and their whole planning
--                          conversation is in fiscal years ("I think we
--                          can move the east wing renovations to fiscal
--                          year '33"). A firm working for a
--                          calendar-year client sets this to 1.
--
-- fiscal_year_labels_by    Which calendar year names the fiscal year.
--                          Massachusetts FY2029 runs Jul 2028 - Jun
--                          2029, i.e. it is named for the year it ENDS
--                          in -- the common convention, but not a
--                          universal one, so it is a setting.
-- ---------------------------------------------------------------------
alter table ship.project_timeline_settings
  add column if not exists start_calendar_year     integer,
  add column if not exists fiscal_year_start_month integer not null default 7,
  add column if not exists fiscal_year_labels_by   text    not null default 'end_year';

-- Added separately from the columns: `add column if not exists` is
-- re-runnable but `add constraint` is not, and a constraint that
-- already exists must not abort the migration.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'project_timeline_settings_fy_month_ck') then
    alter table ship.project_timeline_settings
      add constraint project_timeline_settings_fy_month_ck
      check (fiscal_year_start_month between 1 and 12);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'project_timeline_settings_fy_labels_ck') then
    alter table ship.project_timeline_settings
      add constraint project_timeline_settings_fy_labels_ck
      check (fiscal_year_labels_by in ('start_year', 'end_year'));
  end if;
end
$$;

-- Existing rows get the current year rather than a hardcoded one, so a
-- project created before this migration lands on a sane anchor instead
-- of 1970 or null.
update ship.project_timeline_settings
   set start_calendar_year = extract(year from current_date)::integer
 where start_calendar_year is null;

-- ---------------------------------------------------------------------
-- project_cost_settings  (9 columns)
--
-- One row per project. Absent row = defaults, exactly like
-- project_timeline_settings, so nothing has to be created up front.
--
-- tpc_factor
--   Total Project Cost = ECC x this. Soft costs -- design fees, owner's
--   contingency, FF&E, OPM fees, permitting, commissioning, testing --
--   all live inside it. 1.33 is the first client's working figure and
--   sits mid-range against published soft-cost benchmarks (roughly
--   20-30% of TPC, i.e. 1.25x-1.43x), but it is not a DCAMM-published
--   constant and renovation/historic work runs materially higher.
--
-- base_year
--   The calendar year ecc_amount is priced in. Escalation is measured
--   from here, NOT from the project start -- an estimate handed over in
--   2026 and used in a 2028 plan must not silently gain two years of
--   escalation because someone moved the timeline anchor.
--
-- escalation_mode
--   'compound_annual' -- (1+r)^years. The estimating norm.
--   'stepped'         -- (1+r)^floor(years/step). This is v1's existing
--                        "X% every N years" behaviour, kept so applying
--                        this migration does not silently re-price every
--                        project that already had escalation set.
--
-- escalation_basis
--   'midpoint' (default) or 'start'. Midpoint-of-construction is the
--   standard convention and the default for a real reason: construction
--   dollars are spent across the whole duration, so roughly half are
--   committed after the midpoint. Escalating a multi-year build only to
--   its start date systematically under-prices it; escalating to
--   completion over-prices it. 'start' is offered because some owners
--   mandate it, not because it is better.
--
-- escalation_confidence_years
--   Beyond this horizon the UI stops presenting escalation as a number
--   and starts presenting it as a risk band. This is a product
--   guardrail against false precision, and it is in the schema rather
--   than hardcoded because the honest horizon differs by market.
--   "anytime you tell me, well, this project is going to be 10 years
--   from now, if anyone tells you they knew what the escalation would
--   be, then they're lying" (Joe).
-- ---------------------------------------------------------------------
create table if not exists ship.project_cost_settings (
  project_id                  text primary key
                                references ship.projects(id) on delete cascade,
  tpc_factor                  numeric not null default 1.33
                                check (tpc_factor > 0 and tpc_factor <= 10),
  base_year                   integer not null default extract(year from current_date)::integer
                                check (base_year between 1900 and 2200),
  escalation_mode             text    not null default 'compound_annual'
                                check (escalation_mode in ('compound_annual', 'stepped')),
  escalation_annual_percent   numeric not null default 4.0
                                check (escalation_annual_percent >= 0
                                       and escalation_annual_percent <= 100),
  escalation_step_years       integer not null default 5
                                check (escalation_step_years > 0),
  escalation_basis            text    not null default 'midpoint'
                                check (escalation_basis in ('midpoint', 'start')),
  escalation_confidence_years integer not null default 5
                                check (escalation_confidence_years >= 0),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references ship.profiles(id) on delete set null
);

comment on table ship.project_cost_settings is
  'Per-project cost parameters. Every default here is one firm''s working assumption, not a published standard -- see the migration header.';

-- ---------------------------------------------------------------------
-- escalation_rate_overrides  (3 columns)
--
-- A single compound rate is a bad model for what estimators actually
-- know: the next year or two are forecastable and the back end of a
-- fifteen-year plan is not. This table lets a project pin specific
-- years -- "6.5% next year, 5% the year after, then fall back to the
-- default" -- which is why the cost engine computes compound escalation
-- as a PRODUCT over years rather than a power.
--
-- year_offset is years from project_cost_settings.base_year, not a
-- calendar year, so re-basing the estimate does not orphan the
-- overrides.
-- ---------------------------------------------------------------------
create table if not exists ship.escalation_rate_overrides (
  project_id   text    not null references ship.projects(id) on delete cascade,
  year_offset  integer not null check (year_offset >= 0 and year_offset <= 100),
  rate_percent numeric not null check (rate_percent >= 0 and rate_percent <= 100),
  primary key (project_id, year_offset)
);

-- ---------------------------------------------------------------------
-- project_energy_settings  (6 columns)
--
-- Requested after the meeting, following the DCAMM demo:
--   "That is to quantify and graph the energy reductions of the
--    proposed building upgrades on the timeline. [...] we add a graph
--    below the timeline that live updates with the savings similar to
--    how the overall cost gets updated above." (Megan)
--
-- unit_label
--   FREE TEXT, and that is the point: "We don't know the scale or the
--   units yet, but we can get that soon." (Megan). A CHECK constraint
--   here would guarantee a migration the week the engineers deliver.
--   Practice uses kBtu, kWh, therms, MMBtu, EUI (kBtu/sf/yr), MTCO2e and
--   plain dollars depending on who is asking, and a tool for
--   architecture practices generally needs all of them.
--
-- baseline_annual
--   NULLABLE on purpose. Without it the chart plots cumulative savings
--   from zero; with it, remaining consumption falling away from a
--   baseline, which is what the sketch showed. The feature has to be
--   useful before the baseline arrives, or it will not get adopted
--   before the baseline arrives.
--
-- interaction_factor
--   ECM savings are NOT additive. A lighting retrofit cuts internal heat
--   gain, which cuts the cooling savings a separately-modelled HVAC
--   measure claims; ASHRAE audit practice is explicit that summing
--   individually-calculated measures against one unmodified baseline
--   overstates the total. Properly resolving that needs a calibrated
--   energy model, which is not what this tool is. A single honest
--   de-rate, labelled as such in the UI, is the right resolution at
--   master-plan grain. Default 1.00 = no de-rate, so nobody gets a
--   quiet haircut they did not ask for.
-- ---------------------------------------------------------------------
create table if not exists ship.project_energy_settings (
  project_id         text primary key
                       references ship.projects(id) on delete cascade,
  unit_label         text    not null default 'kBtu/yr' check (btrim(unit_label) <> ''),
  baseline_annual    numeric check (baseline_annual is null or baseline_annual >= 0),
  interaction_factor numeric not null default 1.0
                       check (interaction_factor > 0 and interaction_factor <= 2),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references ship.profiles(id) on delete set null
);

comment on column ship.project_energy_settings.interaction_factor is
  'De-rate for interactive effects between measures. 1.00 = savings taken as summed. Not a fudge factor -- see the migration header.';

-- ---------------------------------------------------------------------
-- Grants
--
-- Same two-part rule as 0002: RLS filters, GRANT authorises, and both
-- are required. `anon` gets nothing, ever.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on ship.project_cost_settings      to authenticated;
grant select, insert, update, delete on ship.escalation_rate_overrides  to authenticated;
grant select, insert, update, delete on ship.project_energy_settings    to authenticated;

alter table ship.project_cost_settings     enable row level security;
alter table ship.escalation_rate_overrides enable row level security;
alter table ship.project_energy_settings   enable row level security;

-- ---------------------------------------------------------------------
-- Policies
--
-- Read: anyone who can read the project. Consultants need to see the
-- factors to understand the numbers they are being shown; hiding them
-- would make the tool feel like it was lying.
--
-- Write: ship.is_admin() ONLY, for now.
--
-- >>> 0009 WIDENS THIS. When per-project roles land, these three write
-- >>> policies become `editor or admin on this project`. They are the
-- >>> only thing to change -- swap ship.is_admin() for the project-role
-- >>> helper in the USING and WITH CHECK, and leave the select policies
-- >>> alone. Until then a global admin is the only writer, which is
-- >>> strictly narrower than the end state and therefore safe.
--
-- Every UPDATE policy carries a WITH CHECK mirroring its USING. Without
-- it, a writer can move a settings row to another project by updating
-- project_id: USING passes (the row is currently theirs) and the new
-- value is never validated. Same class of bug on all three tables.
-- ---------------------------------------------------------------------
drop policy if exists project_cost_settings_select on ship.project_cost_settings;
drop policy if exists project_cost_settings_insert on ship.project_cost_settings;
drop policy if exists project_cost_settings_update on ship.project_cost_settings;
drop policy if exists project_cost_settings_delete on ship.project_cost_settings;

create policy project_cost_settings_select on ship.project_cost_settings
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy project_cost_settings_insert on ship.project_cost_settings
  for insert to authenticated
  with check (ship.is_admin());

create policy project_cost_settings_update on ship.project_cost_settings
  for update to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

create policy project_cost_settings_delete on ship.project_cost_settings
  for delete to authenticated
  using (ship.is_admin());

drop policy if exists escalation_rate_overrides_select on ship.escalation_rate_overrides;
drop policy if exists escalation_rate_overrides_insert on ship.escalation_rate_overrides;
drop policy if exists escalation_rate_overrides_update on ship.escalation_rate_overrides;
drop policy if exists escalation_rate_overrides_delete on ship.escalation_rate_overrides;

create policy escalation_rate_overrides_select on ship.escalation_rate_overrides
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy escalation_rate_overrides_insert on ship.escalation_rate_overrides
  for insert to authenticated
  with check (ship.is_admin());

create policy escalation_rate_overrides_update on ship.escalation_rate_overrides
  for update to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

create policy escalation_rate_overrides_delete on ship.escalation_rate_overrides
  for delete to authenticated
  using (ship.is_admin());

drop policy if exists project_energy_settings_select on ship.project_energy_settings;
drop policy if exists project_energy_settings_insert on ship.project_energy_settings;
drop policy if exists project_energy_settings_update on ship.project_energy_settings;
drop policy if exists project_energy_settings_delete on ship.project_energy_settings;

create policy project_energy_settings_select on ship.project_energy_settings
  for select to authenticated
  using (ship.can_read_project(project_id));

create policy project_energy_settings_insert on ship.project_energy_settings
  for insert to authenticated
  with check (ship.is_admin());

create policy project_energy_settings_update on ship.project_energy_settings
  for update to authenticated
  using      (ship.is_admin())
  with check (ship.is_admin());

create policy project_energy_settings_delete on ship.project_energy_settings
  for delete to authenticated
  using (ship.is_admin());

commit;

-- =====================================================================
-- ROLLBACK
--
-- begin;
--   drop table if exists ship.escalation_rate_overrides;
--   drop table if exists ship.project_energy_settings;
--   drop table if exists ship.project_cost_settings;
--
--   drop trigger  if exists line_items_cc_sync_ecc on ship.line_items;
--   drop function if exists ship.sync_line_item_ecc();
--
--   alter table ship.line_items
--     drop column if exists ecc_amount,
--     drop column if exists annual_energy_savings,
--     drop column if exists annual_cost_savings,
--     drop column if exists energy_notes;
--
--   alter table ship.project_timeline_settings
--     drop constraint if exists project_timeline_settings_fy_month_ck,
--     drop constraint if exists project_timeline_settings_fy_labels_ck,
--     drop column     if exists start_calendar_year,
--     drop column     if exists fiscal_year_start_month,
--     drop column     if exists fiscal_year_labels_by;
--
--   drop function if exists ship.parse_cost_input(text);
-- commit;
--
-- HOW TO VERIFY (impersonate; the SQL editor bypasses RLS entirely)
--
-- -- The parser agrees with lib/costs.ts on the cases that matter:
-- select ship.parse_cost_input('$1.2m'),   -- 1200000
--        ship.parse_cost_input('850k'),    -- 850000
--        ship.parse_cost_input('1,250'),   -- 1250
--        ship.parse_cost_input(''),        -- 0
--        ship.parse_cost_input('abc'),     -- 0
--        ship.parse_cost_input('12.5b');   -- 12500000000
--
-- -- The trigger maintains ecc_amount, and it is not writable around:
-- begin;
--   update ship.line_items set estimated_first_cost = '2.5m'
--    where id = (select id from ship.line_items limit 1);
--   select estimated_first_cost, ecc_amount from ship.line_items limit 1;
--   -- expected: 2.5m | 2500000
--   update ship.line_items set ecc_amount = 999 where id = (select id from ship.line_items limit 1);
--   select ecc_amount from ship.line_items limit 1;
--   -- expected: still 2500000 -- the trigger recomputes from the text column
-- rollback;
--
-- -- A consultant reads the factors but cannot change them:
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"<their auth.users id>","email":"planning@atlasmech.com","role":"authenticated"}';
--   select * from ship.project_cost_settings;         -- their projects only
--   update ship.project_cost_settings set tpc_factor = 2.0;
--   -- expected: 0 rows (filtered by the USING clause, not an error)
-- rollback;
-- =====================================================================
