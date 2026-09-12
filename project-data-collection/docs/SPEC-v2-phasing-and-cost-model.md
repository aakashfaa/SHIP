# Masterplan v2 — Phasing, Cost Model, Energy & Collaboration

Status: **built**, except the suggestions UI and PDF export (see §7).
This document is kept as the record of what was agreed and why; for what the
code actually does, read [`IMPLEMENTATION.md`](./IMPLEMENTATION.md).
Source of record: `update-info/meeting-processed-transcript.md`, `update-info/meeting-condensed-summary.md`,
`update-info/additional-context/*.png` (Megan's post-DCAMM follow-up + Steve's cost-split note).

---

## 0. What this document is

v1 of this app is a line-item collection tool with a drag/resize timeline bolted on. It works,
and it has exactly one real customer workflow behind it: a state-house envelope/energy study.

v2 turns it into a **capital phasing and cost model** that any architecture practice can run a
campus master plan on. Everything the state-house team asked for is in here, but nothing
state-house-specific is hardcoded. That is the central design constraint of this release and it
shows up as a recurring pattern: *the client's assumption becomes a default value on a
per-project settings row, never a literal in the code.*

Concretely — 1.33× TPC, 10%/90% study-to-construction, 1%/9% draft/certifiable, "ANNEX / WEST
WING / BULFINCH", 4% escalation: every one of those is a seeded default that a different firm
overrides on a different project without a code change.

---

## 1. Requirements, traced to source

Each requirement is tagged with who asked for it so we can settle arguments later.

### 1.1 Sub-task level — design separable from construction  (Steve, Megan; the headline ask)

> "it's almost like if you're doing something where you have a task, but then you almost have
> subtasks to that one. So there's the, say, the draft study for something, and that lives as a
> subtask to that one." — Steve

> "the design side just wants to be its own chunk in here then almost. Because it's almost
> independent, really, from when the construction happens. Because if you did a design this year
> and then you don't do the bulfinch for five more years, that needs to be really separate."
> — Megan

Requirements:

- **R1.1** A package (today's "chunk project") decomposes into an ordered list of **phases**.
- **R1.2** Each phase carries its own start, duration, and share of the package's total cost.
- **R1.3** Design phases may be scheduled far ahead of construction phases, with an arbitrary
  lag. Design for the whole building happens once; construction is phased per wing.
- **R1.4** The phase taxonomy is **per project**, chosen from a template. Two templates ship:
  a DCAMM-style study/design task set and a generic AIA phase set. A firm can define its own.
- **R1.5** Package total still rolls up from its line items; phases divide that total, they do
  not re-enter costs.

### 1.2 Total project cost model  (Steve)

From Steve's chat message during the meeting:

> • Draft Study to Bidding phases represent 10% of the Total Project Cost (TPC)
> &nbsp;&nbsp;o Draft Study (Study Phase Tasks 1-5) were valued at 1% TPC
> &nbsp;&nbsp;o SD & Certifiable Study (Study Phase Tasks 6 & 7) and DD, CD & Bidding (Design Phase Tasks 1-4) were valued at 9% TPC
> • Construction & Close-out (Design Phase Tasks 5 & 6) represent 90% of the Total Project Cost (TPC)
> • Costs for each phase were amortized over the duration of each phase so that the total value
> &nbsp;&nbsp;of each phase were divided by the number of months in duration.

Requirements:

- **R2.1** `TPC = ECC × tpc_factor`, `tpc_factor` a per-project setting, default `1.33`.
- **R2.2** Each phase has a `pct_of_tpc`. The template seeds these; the user edits them.
- **R2.3** Phase cost is **amortized straight-line across the phase's duration**. This is
  Steve's stated method and it is the default. (An S-curve option is explicitly deferred — see
  §9 Non-goals.)
- **R2.4** The sum of `pct_of_tpc` across a package's phases must equal 100%. The UI surfaces a
  warning when it does not; it does **not** auto-normalise, because silently rescaling a number
  a cost estimator typed is worse than showing them it is wrong.
- **R2.5** FF&E, owner's contingency and owner's soft costs are **inside** the TPC factor and
  land on the construction/closeout phase. They are not separately schedulable.

> "the FF&E, typically, that's something that it'll get rolled into the end of the project
> rather than the beginning. So I think it could still exist as a markup on the construction
> cost... I don't necessarily think that'll have to be another parameter to split out that
> you'll be able to move around." — Joe

### 1.3 Escalation  (Steve, Joe, Megan)

> "your ECCs will not have escalation factored in, right? Because the line items don't know when
> they're occurring." / "Yeah. We will keep it out, and then we can add it in." — Megan, Joe

> "I'd like to look at that, and then we can apply escalation to the projects as we think we're
> going to bid and construct them." — Joe

Requirements:

- **R3.1** Line-item costs are stored **un-escalated**, in base-year dollars. A per-project
  `base_year` records which year that is.
- **R3.2** Escalation is applied **per phase**, derived from when that phase is scheduled.
  Moving a bar changes its escalated cost. This is the whole point of the tool.
- **R3.3** Escalation rate is a per-project setting with two modes:
  - `compound_annual` — `factor = (1 + rate)^years`. The default.
  - `stepped` — `factor = (1 + rate)^floor(years / every_n_years)`. This is v1's existing
    behaviour, preserved so current projects don't silently re-price on migration.
- **R3.4** Escalation **basis** is a setting: `midpoint` (default) or `start`. Midpoint-of-
  construction is the standard estimating convention — escalating a multi-year build to its
  start date systematically under-prices it. `midpoint` uses `start + duration/2`.
- **R3.5** Per-year rate overrides. A single compound rate is a poor model for "we know the next
  two years and we're guessing after that". A project may supply an override table
  `{year → rate}`; years without an override use the default rate.
- **R3.6** Long-horizon uncertainty is presented, not computed away. Phases beyond a
  configurable `escalation_confidence_years` (default 5) are flagged in the UI as a risk
  conversation rather than a number.

> "anytime you tell me, well, this project is going to be 10 years from now, if anyone tells you
> they knew what the escalation would be, then they're lying" — Joe

### 1.4 Gantt dependencies and fixed durations  (Jeff Garriga)

> "You can't start the bulfinch upgrades until the wings project is complete. So if you push out
> the wings project, will it automatically push out the bulfinch?" — Jeff

> "The main thing is to be able to lock down a duration because I noticed when Megan, you
> squeezed up the bulfinch upgrades. It allowed you to do that... So that duration may be a fixed
> duration and you can't squeeze it." — Jeff

Requirements:

- **R4.1** Directed links between phases with type `FS | SS | FF | SF` and an integer `lag`
  in timeline slots (may be negative = lead).
- **R4.2** `duration_locked` on a phase. A locked bar can be moved but not resized; resize
  handles are removed, not just ignored.
- **R4.3** Moving a predecessor **pushes** violating successors forward automatically
  (transitively). It never pulls them earlier — slack is the planner's, not the tool's.
- **R4.4** Cycles are rejected at creation time with a readable message naming the cycle.
- **R4.5** A live violations panel lists any link currently unsatisfied (which can happen after
  a settings change shortens the timeline).

### 1.5 Tiered permissions  (Steve, Megan)

> "Tiered permissions: admin (internal), consultant edit/comment, client view-only sandbox that
> doesn't save."

> "we talked about suggestions as well. So they can comment on stuff that other consultants are
> doing, but not edit it directly." — Megan

Requirements:

- **R5.1** Four **per-project** roles: `admin`, `editor`, `consultant`, `viewer`.
  Today's role is global and binary; this is the change.

  | | line items (own) | line items (others') | packages & schedule | cost settings | members | what-if |
  |---|---|---|---|---|---|---|
  | `admin`      | CRUD | CRUD | CRUD | CRUD | CRUD | branch + publish |
  | `editor`     | CRUD | CRUD | CRUD | CRUD | read | branch + publish |
  | `consultant` | CRUD | read + **suggest** | read | read | read | branch only |
  | `viewer`     | read | read | read | read | — | ephemeral only |

  `editor` writes cost settings. An earlier draft of this table said `read`,
  which contradicted both the schema (migration 0009's
  `project_cost_settings_*` policies use `can_edit_project`) and 0006's own
  forward-looking marker ("0009 widens this ... editor or admin"). The
  implementation was self-consistent and the table was the outlier, so the
  table moved. An editor who can reschedule the whole programme but cannot
  change the escalation rate it is priced at would be an odd place to draw
  the line.

  The what-if column is the distinction migration 0011 exists to enforce:
  publishing a scenario writes the shared baseline, so it is an edit, while
  branching one is private and harmless. A viewer's sandbox is never
  persisted at all — see R6.1 and R5.3.

- **R5.2** A `consultant` editing another consultant's line item produces a **suggestion**, not
  a write. Admins/editors review, accept (which applies the patch) or reject.
- **R5.3** A `viewer` can move bars freely in an **ephemeral sandbox** that is never persisted
  anywhere. They cannot save, publish, or export the underlying model.
- **R5.4** The global `profiles.role` is retained and means "can create projects" (platform
  admin). Project-level authority comes from the per-project role.

### 1.6 Sandbox / what-if mode  (Megan, Steve — explicitly modelled on Revit)

> "similar to how we handle the Revit projects. You make a copy of the central model, and then
> every time you're saving it, you have to publish it back to the central model." — Megan

> "how do you know that you're looking at the official published one versus your own? So there's
> going to be a big button on the top right or somewhere. If it's active, that means that you're
> looking at a local copy." — Megan

Requirements:

- **R6.1** A **scenario** is a named, owned copy of the schedule-relevant state: phase
  placements, dependencies, and cost/escalation settings.
- **R6.2** Entering a scenario shows an unmissable persistent banner. Megan asked for exactly
  this and it is the single highest-risk UX detail in the release — a user who edits for twenty
  minutes without realising they are in a sandbox will not forgive us.
- **R6.3** Publish applies the scenario to the baseline in one transaction. Discard throws it
  away.
- **R6.4** Publish detects **baseline drift** (someone else changed the live model since the
  scenario was taken) and refuses, showing what changed. Same failure mode as a Revit
  sync-with-central conflict, same resolution: reload and redo.
- **R6.5** Scenarios are private to their owner by default, shareable to the project.

### 1.7 Energy reduction quantification  (Megan, post-DCAMM follow-up)

This arrived after the meeting and is a first-class v2 feature, not a nice-to-have. Megan:

> "That is to quantify and graph the energy reductions of the proposed building upgrades on the
> timeline. To do this, we could create a new data input for all the line items. We will then get
> energy saving data from our engineers to input there. Those get aggregated with each line item
> that goes into a Chunk or Project. And then we add a graph below the timeline that live updates
> with the savings similar to how the overall cost gets updated above."
>
> "We don't know the scale or the units yet, but we can get that soon."

Requirements:

- **R7.1** New numeric line-item fields: `annual_energy_savings` and `annual_cost_savings`.
- **R7.2** Units are a **per-project setting** — Megan does not know them yet, so the tool must
  not care. Supported: `kBtu`, `kWh`, `therms`, `MMBtu`, `MTCO2e`, `USD`, plus a free-text
  custom label.
- **R7.3** Savings aggregate line item → package, exactly as cost does.
- **R7.4** A package's savings come online when its **last construction-kind phase completes**.
  Design phases deliver no savings.
- **R7.5** A **step chart** below the timeline, pixel-aligned to the same column grid, drawing:
  a dashed horizontal baseline, and a descending stepped line of remaining consumption that
  drops at each package's onset. This is Megan's sketch, reproduced.
- **R7.6** An **interaction factor** (project setting, default `1.00`). ECM savings are not
  additive — a lighting retrofit and an HVAC retrofit each claim savings the other also claims.
  A single de-rate multiplier is the honest, simple model at master-plan resolution; the field
  is labelled in the UI so nobody mistakes it for a fudge factor.
- **R7.7** If no baseline is set, the chart shows cumulative savings from zero instead of
  remaining consumption from baseline, so the feature is useful before the engineers deliver.

### 1.8 Outputs  (Megan, Steve)

> "we can make that an Excel spreadsheet pretty easily that we could give to the client. And then
> we would want a PDF view of the whole phasing schedule." — Megan

> "would you want the Excel file to still have the formulas that we're using in the backend, or
> do you just want it to be a flat data sheet?" / "I think flat data is fine." — Aakash, Megan

> "we're not giving away the programming behind it per se. It becomes more of a deliverable."
> — Steve

Requirements:

- **R8.1** Excel export: multi-sheet `.xlsx`, **flat values only, zero formulas**. Sheets:
  Line Items, Packages, Phase Schedule, Annual Cost Summary, Energy Summary.
- **R8.2** PDF export of the phasing schedule, landscape, readable, with costs on it.
- **R8.3** Neither export includes cost parameters, escalation settings, or anything that
  reveals the model. This is a deliberate commercial decision by the client, not an oversight.
- **R8.4** `viewer` role cannot export.

### 1.9 Generalisation  (product requirement, not from the meeting)

The meeting itself supplies the justification:

> "I can see this happening at a campus scale... if you're doing this for a campus, then
> absolutely." — Megan
> "I think it would work for any master planning effort type project as well." — Aakash
> "That's just anything you're breaking into phases." — Megan

Requirements:

- **R9.1** `building_area_impacted` and `building_level_impacted` are currently `CHECK`
  constraints containing `'ANNEX'`, `'WEST WING'`, `'BULFINCH'`. These become **per-project
  editable taxonomies**. A new project gets a generic default set; the state-house project keeps
  its current values via data migration.
- **R9.2** `LineItemCategory` and `TimelinePriority` likewise become per-project taxonomies.
  `'5_250th ANNIVERSARY'` is not a universal planning horizon.
- **R9.3** `ConsultantType` stays a fixed list — the 14 disciplines are genuinely generic to
  architectural practice — but gains an `Other` escape hatch.
- **R9.4** No user-visible string in the app names a specific building, agency, or client.

---

## 2. Domain model

All objects live in the `ship` Postgres schema. The
[shared-database ground rules](../supabase/README.md) are unchanged and absolute: nothing
outside `ship`, no extensions, no `auth.users` triggers, every migration in one transaction.

```
project
├── project_cost_settings      1:1   tpc factor, escalation, base year, fiscal year
├── project_energy_settings    1:1   unit, baseline, interaction factor
├── project_timeline_settings  1:1   (exists) years, interval, zoom
├── project_taxonomy_values    1:N   per-project dropdown values          [R9]
├── project_roles              1:N   (project, email) → role              [R5]
├── phase_template             1:N   chosen or custom phase taxonomy      [R1.4]
│   └── phase_template_step    1:N   name, kind, pct_of_tpc, duration
├── line_item                  1:N   (exists) + ecc_amount, energy fields [R7.1]
├── chunk_project  ("package") 1:N   (exists)
│   ├── chunk_project_item     1:N   (exists) line item links + quantity
│   └── chunk_phase            1:N   THE new sub-task level               [R1.1]
├── phase_dependency           1:N   FS/SS/FF/SF + lag between phases     [R4.1]
├── suggestion                 1:N   consultant proposed changes          [R5.2]
└── scenario                   1:N   sandbox snapshots                    [R6]
```

### 2.1 `chunk_phase` — the core new entity

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `chunk_project_id` | uuid fk cascade | |
| `template_step_id` | uuid null | provenance; null once user-edited |
| `name` | text | "Draft Study", "DD–CD & Bidding", "Construction" |
| `kind` | text check | `study \| design \| construction \| closeout` |
| `sort_order` | int | |
| `pct_of_tpc` | numeric | share of the package TPC. Σ should be 100 |
| `start_slot` | numeric | position on the timeline, in slots |
| `duration_slots` | numeric | ≥ 1 |
| `duration_locked` | boolean | R4.2 — blocks resize |

`kind` drives three behaviours and must not be conflated with `name`: it decides bar colour,
whether the phase contributes to energy onset (`construction` only, R7.4), and which default
escalation basis applies.

### 2.2 Migration of the existing `timeline_segments` jsonb

`chunk_projects.timeline_segments` is a jsonb array of `{id, start, duration}` supporting a
one-level split/merge. Every existing segment becomes a `chunk_phase` with
`kind = 'construction'`, `pct_of_tpc` divided evenly across the segments, and
`duration_locked = false`. The jsonb column is **retained but no longer written**, so the
migration is reversible; a later release drops it.

### 2.3 Scenarios are snapshots, not a `scenario_id` column

The obvious design — add `scenario_id` to every table and make `NULL` mean baseline — is
rejected. It puts a second orthogonal dimension into every RLS predicate and every aggregate,
and the first forgotten `where scenario_id is null` silently double-counts a rollup. For a tool
whose entire job is producing correct totals, that is the wrong failure mode.

Instead a scenario stores one `payload jsonb`: the full set of `chunk_phase` rows,
`phase_dependency` rows and cost settings at the moment it was taken, plus a `baseline_hash`.
The client overlays it in memory. Publishing is one RPC that diffs and applies. This is a
closer match to the Revit local-copy metaphor the client asked for, and it makes the
client-viewer sandbox (R5.3) trivial: the same overlay, never persisted.

Cost: a scenario goes stale if the baseline moves. That is exactly what happens to a Revit
local copy, it is a concept the users already hold, and `baseline_hash` turns it into an honest
conflict at publish time (R6.4) rather than silent data loss.

---

## 3. The cost engine

One pure module, `lib/cost-model.ts`, with no React and no Supabase imports, so it is directly
unit-testable and reusable by the export route handlers.

```
ecc_base(package)   = Σ line_items ( ecc_amount × quantity )
tpc_base(package)   = ecc_base × settings.tpc_factor
cost_base(phase)    = tpc_base(phase.package) × phase.pct_of_tpc

years_out(phase)    = settings.basis === 'midpoint'
                      ? slot_to_years(phase.start_slot + phase.duration_slots / 2)
                      : slot_to_years(phase.start_slot)

escalation(phase)   = mode === 'compound_annual'
                      ? Π over each year y in [0, years_out) of (1 + rate_for_year(y))
                      : (1 + rate) ^ floor(years_out / every_n_years)

cost_esc(phase)     = cost_base(phase) × escalation(phase)
per_slot(phase)     = cost_esc(phase) / phase.duration_slots        -- R2.3 straight line

column_total(slot)  = Σ over phases covering slot of per_slot(phase)
```

`rate_for_year` consults the per-year override table (R3.5) and falls back to the default rate,
which is why the compound form is a product rather than a power.

Energy, same module:

```
savings(package)    = Σ line_items ( annual_energy_savings × quantity ) × interaction_factor
onset_slot(package) = max( end_slot ) over phases where kind = 'construction'
cumulative(slot)    = Σ over packages with onset_slot ≤ slot of savings(package)
remaining(slot)     = baseline − cumulative(slot)        -- or cumulative alone if no baseline
```

Every one of these is a pure function of `(packages, phases, settings)`. The Timeline tab, the
Excel route and the PDF route all call the same functions, so the three can never disagree —
which matters, because the client is handing the Excel to a state agency.

---

## 4. Permissions implementation

Per the Supabase RLS research, and consistent with the existing `0002_ship_rls.sql` approach:

- Every policy predicate is a `SECURITY DEFINER` helper with `set search_path = ''`. This is
  already the house style and it is what prevents `42P17 infinite recursion` when a policy on
  `project_roles` needs to read `project_roles`.
- Set-returning helpers (`ship.my_project_ids()`, `ship.my_editable_project_ids()`) for `SELECT`
  policies, because they are row-independent and the planner hoists them into a single
  `initPlan`. Boolean helpers taking a row column are **not** cached and run per row — used only
  in `WITH CHECK` on insert, where there is one row.
- Separate policies per command. Never `FOR ALL`. A tiered model needs read-wide/write-narrow,
  which is two different predicates by construction.
- Every `UPDATE` policy carries a `WITH CHECK` mirroring its `USING`. Without it, an editor can
  transplant a row into another project by updating its `project_id`.

Role resolution: `ship.project_role(project_id)` returns the caller's role, falling back to
`'admin'` when `profiles.role = 'admin'` (platform admins keep full access), else the
`project_roles` row, else null.

Suggestions (R5.2) follow the standard proposed-change pattern: a `suggestions` table holding a
`patch jsonb`, and a `ship.apply_suggestion(uuid)` RPC that validates the caller may edit,
checks the patch touches only an **allowlisted set of columns**, applies it with
`jsonb_populate_record` so column types are real, and flips the status — all under one
`FOR UPDATE` lock so a double-click cannot apply it twice.

---

## 5. UI

### 5.1 Timeline tab — rebuilt

The existing hand-built timeline is **kept and extended**, not replaced with a library. It
already has the two things a library would fight us on: cost-rollup columns in the header, and
now an energy chart that must align pixel-for-pixel with the same column grid. Both are
consequences of `CELL_WIDTH` being ours. Adopting `dhtmlx-gantt` (GPL/commercial) or
`gantt-task-react` would mean re-implementing those on top of someone else's layout engine.

Changes:

- Package rows become **expandable** into phase sub-rows. Collapsed shows a summary bar spanning
  the package's full extent; expanded shows one bar per phase.
- Bars colour by `kind`: study/design in a lighter tint, construction in the existing dark
  navy→teal, closeout hatched.
- **Dependency arrows**: one absolutely-positioned SVG overlay across the whole grid, orthogonal
  elbow routing, arrowhead marker. Forward links route `right → down → right`; the backward case
  (successor starts before predecessor ends) routes around the bar.
- **Lock affordance**: locked phases render a padlock and drop their resize handles entirely.
- **Fiscal-year labels** on the column header when interval is yearly, driven by
  `fiscal_year_start_month` (default July, so `FY29` spans Jul 2028 – Jun 2029).
- **Energy panel** below the grid: same `LABEL_COLUMN_WIDTH + timelineWidth`, same
  `CELL_WIDTH` columns, dashed baseline, stepped descent, hover readout per column.
- **Sandbox banner** (R6.2): full-width, high-contrast, sticky, naming the scenario, with
  Publish and Discard.

### 5.2 New Cost Model tab (admin/editor)

TPC factor, base year, fiscal-year start, escalation mode/rate/basis/confidence horizon,
per-year rate override table, phase template selection and per-step `pct_of_tpc` editing with a
running Σ that turns red off 100%. Energy unit, baseline and interaction factor live here too.

### 5.3 Other tabs

- **Add Data**: energy savings + cost savings fields in the cost step; `ecc_amount` alongside
  the existing free-text first-cost field.
- **Chunking**: per-package phase editor (add/remove/reorder phases, set %, lock duration).
- **Settings**: per-project member roles; taxonomy editor for areas/levels/categories/priorities.
- **Master View**: new energy columns; real Excel export replacing the `window.print()` hack.
- **Suggestions**: review queue for admins/editors; a consultant editing a foreign line item is
  routed here instead of being denied.

### 5.4 Visual language

Match what exists — this is a v2 of a product the client has already demoed and liked, not a
redesign. `rounded-[2rem]` glass cards, `border-white/70 bg-white/76 backdrop-blur-2xl`, the
navy→teal `linear-gradient(135deg,#0f172a,#1e293b,#0f766e)` for primary actions, uppercase
`tracking-[0.18em]` eyebrow labels. Three input focus themes currently coexist (black, teal,
slate-900); new work uses the **teal** variant, which is the one on the auth pages and the
newest surfaces.

---

## 6. Verification

Playwright, `@playwright/test` pinned exact, against the **local** Supabase stack with a
deterministic seed. Never against the shared remote project.

- `next build && next start`, never `next dev` — the dev overlay paints into screenshots and
  lazy route compilation makes timing non-deterministic.
- Determinism stack: `animations: 'disabled'`, `reducedMotion: 'reduce'`, a `stylePath`
  stylesheet killing transitions, `document.fonts.ready`, `page.clock.setFixedTime`,
  `timezoneId: 'UTC'`, fixed `viewport`, `deviceScaleFactor: 1`, `scale: 'css'`.
- A `setup` project signs in once and writes `playwright/.auth/*.json` (gitignored), consumed as
  `storageState`. Supabase keeps the session in **both** a chunked `sb-<ref>-auth-token` cookie
  and localStorage; `storageState` captures both, which an SSR + client-component app needs.
- Baselines are Windows-local for now (`{platform}` retained in `snapshotPathTemplate`). If this
  ever runs in CI, baselines get regenerated inside the matching
  `mcr.microsoft.com/playwright:v<ver>-noble` image — Windows and Linux text rasterisation do
  not match and loosening `threshold` until they do would make the suite worthless.

Functional checks that matter more than pixels, and get their own specs:

1. Moving a predecessor pushes its successors; slack is preserved; cycles are refused.
2. A locked phase cannot be resized but can be moved.
3. Escalation: a phase at year 0 equals base cost; moving it out N years multiplies by the
   expected compound factor; midpoint basis differs from start basis by exactly half the
   duration's worth of escalation.
4. Column totals equal Σ of per-slot amortised phase costs, and the Excel export's Annual Cost
   Summary equals the on-screen header row to the cent.
5. Energy steps drop at construction completion, not design completion.
6. A `consultant` editing a foreign line item creates a suggestion and does not mutate the row.
7. A `viewer` moving a bar changes nothing after reload.
8. Publishing a scenario onto a drifted baseline is refused.

---

## 7. Build order

Sequenced so each step is independently shippable and committable.

Migration numbers below are the ones that actually shipped, which drifted from the
plan: taxonomies needed a file of their own (`0008`), pushing roles to `0009` and
scenarios to `0010`, and an eleventh landed to close a privilege escalation found
during review. See [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for what each one does.

| # | Step | Status |
|---|---|---|
| 1 | Local Supabase stack + seed + Playwright harness | done |
| 2 | Migration `0006`: cost/energy settings, `ecc_amount`, energy columns | done |
| 3 | `lib/cost-model.ts` + unit tests | done — 53 assertions |
| 4 | Migration `0007`: `chunk_phases`, `phase_dependencies` + backfill | done |
| 5 | Timeline tab: phase rows, per-phase bars, escalation display | done |
| 6 | Dependency arrows, locks, push propagation, violations panel | done |
| 7 | Cost Model tab | done |
| 8 | Energy fields + step chart | done |
| 8b | Migration `0008`: per-project taxonomies + editor | done — not in the original plan |
| 9 | Migration `0009`: `project_roles`, `suggestions` + RLS rewrite | done |
| 10 | Suggestions UI + review queue | **not built** — schema only |
| 11 | Migration `0010`: `scenarios`; sandbox mode + banner + publish/discard | done |
| 11b | Migration `0011`: scenario authority fix | done — see §1.5 |
| 12 | Excel export | done |
| 12b | PDF export | **not built** |

Steps 1–8 are the two weeks Aakash committed to on the call for "escalation logic and the
sub-project task-wise number breakdown". Step 10 is the consultant onboarding gate and is the
largest remaining piece of work. Step 12b is the "barely a couple of days" half that is left.

---

## 8. Migrations and the shared database

Migrations are written to `supabase/migrations/` and applied **only to the local Docker stack**
via `supabase db reset` for the duration of this work. The remote project ref is shared with an
unrelated production application (see `supabase/PREFLIGHT.md`); nothing here is pushed to it
without a separate, explicit decision.

The existing files are numbered `0001`–`0005` and are applied by hand in order. v2 continues
that numbering. Every file keeps the house conventions: one `begin; … commit;`, `if not exists`
throughout, `drop policy if exists` before `create policy`, a header comment explaining *why*
rather than *what*, and a rollback block.

---

## 9. Non-goals

Explicitly out of scope, each with its reason:

- **Bundling cost-efficiency logic.** Directly declined in the meeting.
  > "to build that logic into your application here is probably a bit much at this point" — Joe
  > "that might be getting a little bit more complicated than we necessarily want" — Steve

  GCs/GRs scaling with project size is real, and it stays a verbal conversation with the client.
- **S-curve cost spreading.** Straight-line is what Steve specified. The engine is structured so
  a curve function can be swapped in later without touching callers.
- **True CPM scheduling** (critical path, float calculation, resource levelling). This is a
  planning tool at year/quarter resolution, not Primavera.
- **Real-time multi-user co-editing.** Discussed and deferred in favour of the sandbox model.
  > "I think for saying to the owner, we would always be the ones who had this up on our screen" — Steve
- **Per-measure energy interaction modelling.** A single project-level de-rate is the honest
  resolution here; anything finer needs a calibrated energy model, not a planning spreadsheet.
- **Pushing any of this to the shared remote Supabase project.**
