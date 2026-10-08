# Masterplan v2 — what was built

Companion to [`SPEC-v2-phasing-and-cost-model.md`](./SPEC-v2-phasing-and-cost-model.md).
The spec says what we agreed to build and who asked for each piece. This says
what actually exists, where it lives, and what will bite you.

Status: **everything in the build order except the suggestions UI.** That is
deliberately parked — see [Not built](#not-built). Migrations `0006`–`0020`
(0013–0020 are the pre-launch audit fixes — see
[Pre-launch hardening](#pre-launch-hardening-00130020)), 226 unit tests, 140 SQL
assertions, 38 Playwright tests.

Nothing here has been applied to the remote Supabase project. All of it runs
against a local Docker stack ([`supabase/LOCAL-DEV.md`](../supabase/LOCAL-DEV.md)).

---

## Run it

```bash
npm run db:start     # boot local Supabase (migrations + seeds + dev users)
npm run dev          # http://localhost:3000
```

Four accounts, one per project role, password `localdev123` for all:

| email | role on `federal-campus-master-plan` |
|---|---|
| `admin@gmail.com` | admin (also platform admin) |
| `planning@atlasmech.com` | editor |
| `consultant1@gmail.com` | consultant |
| `electrical@voltworks.com` | viewer |

Signing in as each is the fastest way to see the permission work: the same
Timeline renders four different ways.

If `.env.local` holds a real `RESEND_API_KEY`, `npm run dev` sends real email
and builds links from its `APP_URL`. To keep local mail in Mailpit, blank them
for the process: `RESEND_API_KEY= APP_URL=http://localhost:3000 npm run dev`.

```bash
npm run test:all     # typecheck + 226 unit tests + 38 Playwright tests
npm run check:parser # SQL/TS cost-parser parity (76 cases)
npm run db:reset     # wipe and re-seed
node supabase/tests/run.mjs   # 140 SQL assertions, run as the seeded roles
```

Run `npm run db:reset` before `npm test`. Every visual baseline encodes the
seeded dollar figures, and `timeline-v2.spec.ts` refuses to go on unless the
federal plan totals **$56,003,188**. The specs that write (what-ifs, drags,
invites, line items, packages, field order) put everything back, so the suite
runs twice in a row against one reset. Only the item and package number
counters move on, because numbers are never reused.

The suite never sends real email. `playwright.config.ts` starts its own
`next start` with `RESEND_API_KEY` blank, `APP_URL` pointing at the test server
and `MAILPIT_URL` set, overriding whatever `.env.local` holds, and it refuses
to reuse a server it did not start.

---

## The shape of it

```
line items ──┐
             ├─► package (chunk_project) ──► phases ──► months on the timeline ──► money
quantity ────┘                                 │
                                               └──► construction ends ──► energy step
```

A **line item** is a piece of scope with a cost and (new in v2) an energy
saving. A **package** groups line items. v2's headline change: a package now
decomposes into **phases**, each with its own position on the timeline and its
own share of the package's cost. That is what lets design sit years ahead of
the construction it belongs to, which is the thing the client actually plans
around.

Phases **divide** the package total; they never add to it. No amount of phase
editing can double-count a line item.

---

## Where things live

| Concern | File |
|---|---|
| All cost/escalation/energy/scheduling arithmetic | `lib/cost-model.ts` |
| Row ↔ domain mapping | `lib/mappers.ts` |
| Every Supabase read/write | `lib/store.ts` |
| Caller's role on a project | `lib/project-role.ts` |
| Timeline (grid, bars, arrows, chart, sandbox) | `components/project-workspace/TimelineTab.tsx` + `timeline/` |
| Form field values for export / Master View | `lib/form-values.ts` |
| Auth emails (invite, added-to-project, confirm, reset) | `lib/email/` + `app/api/admin/invite`, `app/api/auth/*`, `app/auth/*` |
| Phase editing | `components/project-workspace/PhaseEditor.tsx` |
| Cost + energy parameters | `components/project-workspace/CostModelTab.tsx` |
| Vocabularies editor | `components/project-workspace/TaxonomyEditor.tsx` |
| Excel export | `lib/export/` + `app/api/projects/[id]/export/xlsx/route.ts` |
| Schema | `supabase/migrations/0006`–`0020` |
| SQL regression tests | `supabase/tests/` (`node supabase/tests/run.mjs`) |

`lib/cost-model.ts` has **no React and no Supabase imports**, and that is a hard
rule rather than a preference. The Timeline tab, the Excel route and (when it
lands) the PDF route must produce the same numbers, and the only way to
guarantee that is for all three to call the same pure functions. The client is
handing the Excel output to a state agency; "the screen said one thing and the
export said another" is not a bug we get to have. It also means the engine is
unit-testable without a browser or a database — `tests/unit/cost-model.test.ts`
and `tests/unit/waveb-months.test.ts`.

---

## The cost engine

```
ecc_base(package)   = Σ line_items ( ecc_amount × quantity )      -- base-year $
tpc_base(package)   = ecc_base × tpc_factor                        -- default 1.33
cost_base(phase)    = tpc_base × phase.pct_of_tpc

years_out(phase)    = (timeline_anchor_year − base_year)
                    + ( basis == 'midpoint'
                        ? start_month + duration_months/2
                        : start_month ) / 12

escalation(phase)   = Π over each year y in [0, years_out) of (1 + rate_for(y))
cost_esc(phase)     = cost_base × escalation
per_month(phase)    = cost_esc / duration_months                   -- straight line
```

**Schedules are stored in months, and the zoom never touches money (0020).**
Phase start, duration and dependency lag used to be stored in "slots" whose
size the zoom set, so dragging the Zoom slider re-priced the whole plan and the
Excel export (the federal seed read $179.7M at 5-year zoom, $56.0M at Year and
$43.3M at Month). The columns `start_slot` / `duration_slots` / `lag_slots`
keep their names but now hold **months**. The engine reads only months; a
column at any zoom is just a span of months, and its total is the overlap of
each phase with that span. Zoom is per-viewer view state: anyone, viewers
included, can change it, and it writes nothing. The project's stored zoom is
only the view a page opens at. Drags snap to one column of the current zoom
and store months; the phase editor takes durations in months.

**Fiscal years and quarters are counted month by month.**
`computeFiscalYearTotals` is the one function behind the Timeline's "By fiscal
year" strip (with Q1–Q4) and the export's Annual Cost Summary. The grid's
column headers show the calendar span and the fiscal span it covers
(`CY2026 / FY26–27`), so a column total and an FY total are different, honest
numbers. The FY cards add up to the headline exactly.

**The horizon extends to the furthest phase** (`resolveHorizon`, M-27). It is
never shorter than the project's Timeline Length, and the screen and the
workbook both say when it has been stretched. Before this, money scheduled past
the end counted in the headline but fell out of the columns, the FY strip and
the Annual Summary.

Five things in there are load-bearing and easy to get wrong:

**Escalation is applied per phase, from where it lands on the timeline.** Line
items are stored un-escalated in base-year dollars, permanently. Moving a bar
changes its escalated cost — that is the entire point of the tool.

**The basis defaults to the midpoint of the phase, not its start.** Construction
dollars are spent across the whole duration, so roughly half are committed after
the halfway point. Escalating a multi-year build only to its start date
systematically under-prices it. This is the standard estimating convention;
`start` is offered because some owners mandate it, not because it is better.

**Compound escalation is a product over years, not `(1+r)^n`.** That is what
makes per-year overrides meaningful. A single rate cannot express what an
estimator actually knows — the next year or two are forecastable and the back
end of a fifteen-year plan is not.

**The gap between `base_year` and the timeline anchor is carried.** An estimate
priced in 2026 used on a plan anchored at 2028 already carries two years before
anyone drags anything. Easy to forget; there is a test for it.

**Column totals are computed by interval overlap, not integer rounding.** A
phase rarely lines up with a column (a 7-month phase at Year zoom). A total that does not match the sum of the bars
above it is exactly the kind of discrepancy that destroys trust in a costing
tool, so there is an explicit invariant test.

Energy works the same way, with one deliberate difference: savings come online
when a package's **last construction phase completes**. Design phases deliver
nothing — you do not save energy by drawing a boiler. That is why `kind` is a
closed set (`study | design | construction | closeout`) rather than free text:
it drives bar colour, energy onset, and default escalation basis, none of which
should depend on what someone typed in a text box. A firm can rename their
construction phase "Build-out" without breaking the chart.

---

## Permissions

Four **per-project** roles, resolved by `ship.project_role()`:

| | line items (own) | others' | schedule | cost settings | members | what-if |
|---|---|---|---|---|---|---|
| `admin` | CRUD | CRUD | CRUD | CRUD | CRUD | branch + publish |
| `editor` | CRUD | CRUD | CRUD | CRUD | read | branch + publish |
| `consultant` | CRUD | read | read | read | read | branch only |
| `viewer` | read | read | read | read | — | ephemeral only |

**RLS is the boundary. `lib/project-role.ts` only decides what to render.** Every
gate in the UI is re-made in the database on the way to the data. The reason to
gate in the UI at all is that a button whose every save is silently filtered to
zero rows reads as the app being broken.

A project `admin` (not only a platform admin) can rename their project, edit
its roster and invite people to it (0013, D-8). Only a platform admin can make
someone a platform admin. Removing an email from the roster now revokes that
person's `project_roles` row; before 0013 a "removed" consultant kept full
access.

Two things worth knowing:

A **consultant can drag inside their own what-if** even though they cannot touch
the baseline, because that writes the scenario row rather than `chunk_phases`.
"May edit the baseline" and "may move a bar" are genuinely different questions,
and `TimelineTab` keeps them separate (`canEditBaseline` vs `canDrag`).

A **viewer gets a real sandbox**, not a frozen page — Steve asked for "they could
play with things a little bit, but it won't save". They can drag anything; the
drop goes nowhere. Migration 0011 refuses the writes as well, so the UI is never
the thing being relied on.

### The escalation that was found and fixed

Migration 0010 shipped `publish_scenario()` with a comment saying *"anyone who
may **edit** the project's schedule may publish"* above a check for
`can_read_project()`. Migration 0009 had already redefined that as "has any role
at all" — which includes `viewer`. And because the function is `SECURITY
DEFINER`, its write to `chunk_phases` bypassed the RLS policy that would have
caught it.

A read-only user could author any payload into their own scenario and publish it
over the entire live schedule. Migration **0011** fixes it: `publish_scenario`
now checks `can_edit_project`, `create_scenario` checks
`can_contribute_project`. Verified per role by impersonation in SQL.

The lesson worth carrying: a `SECURITY DEFINER` function is a hole straight
through RLS, so its own authorization check *is* the policy. Audit those
separately from the policies.

---

## Pre-launch hardening (0013–0020)

The pre-launch audit found holes in
access, integrity, money and auth. What changed, by area:

**Migrations.** Apply in order after 0012; [`supabase/README.md`](../supabase/README.md)
has rollback notes for each.

| File | What it does |
|---|---|
| `0013_access_hardening` | roster removal revokes access; project admins manage their own project (D-8); stale roster saves refused (40001); `claim_invite` needs a confirmed email; `project_access_notices` for the added-to-project toast; service role gets `ship` usage |
| `0014_line_item_integrity` | system columns (item number, company, discipline, `ecc_amount`…) immutable for non-platform-admins, `project_id` for everyone; packages cannot link another project's items; blank savings and dropdowns are NULL, not 0 (D-9) |
| `0015_scenario_hardening` | `base_payload` makes rebase a real three-way merge; payload writes go through `save_scenario_payload`; publish needs the owner or a shared what-if |
| `0016_form_builder_hardening` | only the seeder creates built-in fields; column keys allow-listed; projects with built-ins can be deleted |
| `0017_bulk_write_rpcs` | `reorder_form_fields` / `reorder_field_options` (the up/down arrows always failed before) |
| `0018_project_lifecycle` | every project gets cost, energy and timeline rows with a fixed year, so totals no longer move on 1 January |
| `0019_cost_parser` | strict `parse_cost_input`; unreadable legacy text becomes NULL and is flagged |
| `0020_canonical_time_unit` | converts every stored schedule position to months (see [The cost engine](#the-cost-engine)). **Snapshot the hosted database first; it converts in place.** Run-once, logged per project |
| `0021_project_view_settings` | per-project display settings (`projects.view_settings`), shared by every member; written only via `update_project_view_settings` (project/platform admin). **Pending on hosted** — apply after 0020, then `notify pgrst, 'reload schema';` |

**Auth and email.** Our server sends every auth email itself through the
Resend REST API (`lib/email/`); nothing calls `inviteUserByEmail`, client
`signUp` or `resetPasswordForEmail`. Without `RESEND_API_KEY` it delivers to the
local Mailpit (outside production, or when `MAILPIT_URL` is set); in production
it refuses rather than sending nowhere. Links are built from `APP_URL`, never
the request's Host header. Routes:

- `/auth/confirm` verifies a `token_hash` link server-side, claims the invite,
  and sends invite and recovery links on to `/auth/set-password` (8+ characters).
- `/auth/forgot` + `/api/auth/forgot`, `/auth/sign-up` + `/api/auth/sign-up`
  (allow-list check, neutral answers so accounts cannot be enumerated),
  `/api/auth/resend-confirmation`.
- Inviting an address that already has an account sends a plain "You've been
  added to <project>" link and records an in-app notice, shown as a toast at
  next sign-in. No admin is ever shown a login link for an existing account.
- `?next=` only accepts same-site relative paths. Email confirmation is on,
  minimum password 8 (`supabase/config.toml`; `supabase/PREFLIGHT.md` §7 lists
  the hosted settings).

**UI.** Deletes (line items, packages, phases, what-ifs) are a two-step inline
confirm. Number fields keep what was typed and parse on blur; cost fields take
`$`, thousands separators and k / M / B shorthand with a live "= $1,200,000"
preview. Master View scrolls horizontally with # and Name / Description
pinned, and its PDF export no longer runs a project name as HTML. What-if drags
no longer wipe earlier moves, and the Excel export follows the open what-if.

**Next.js 16.4** (16.2.0 carried about 30 advisories). `allowedDevOrigins`
lets `next dev` pages opened at 127.0.0.1 hydrate.

---

## Generalisation

The tool is being built for architecture practices generally, but it has one
customer whose vocabulary was baked into the schema. The pattern used
throughout: **the client's assumption becomes a default value on a per-project
settings row, never a literal in the code.**

- `tpc_factor` (1.33), escalation rate (4%), fiscal-year start (July), the
  1/9/90 phase split — all per-project defaults. Research could not find any of
  them published as a DCAMM or state standard; they are plausible practitioner
  heuristics, which is exactly why they must be editable.
- Phase structure is a **template**. Three ship: DCAMM's 1/9/90, the generic AIA
  set, and a bare Design + Construction split.
- Building areas, levels, categories and priorities were `CHECK` constraints
  containing `'ANNEX'`, `'WEST WING'`, `'BULFINCH'`, `'5_250th ANNIVERSARY'`.
  They are now per-project rows, edited in Settings → *Line item vocabularies*.

That last one had a consequence worth spelling out: once migration 0008 dropped
those constraints, the TypeScript unions (`LineItemCategory`,
`BuildingAreaImpacted`, …) were **lying** — they described one building's wings
as the set of legal values and would reject a legal value from any other firm's
campus. Those four `LineItem` fields are now `string`. The unions survive as the
*default* vocabulary, which is a genuinely different thing from the legal one.

---

## Verification

| Gate | What it covers |
|---|---|
| `npm run typecheck` | app + test configs separately |
| `npm run lint` | eslint-config-next 16.4, incl. the react-hooks rules |
| `npm run test:unit` | 226 tests: cost engine, months/zoom invariants, parsers, export, mappers, auth helpers, what-if merge |
| `npm run check:parser` | 76 inputs through both cost parsers |
| `node supabase/tests/run.mjs` | 140 SQL assertions over 0013–0020, as the seeded roles, each file one rolled-back transaction |
| `npm run test` | 38 Playwright tests, incl. per-role visual baselines, invite and reset email round trips, what-if drags, delete confirms, form reorder |

**`check:parser` exists because the same parse happens twice.** (Since 0019
both parsers are strict: `[$] NUMBER [k|m|b|thousand|million|billion]`, no
negatives, and anything else is *unreadable* — `ecc_amount` NULL, flagged in
the UI and the export — rather than a silent $0. The old lenient parser read
"1.2 million" as $1.20 and "TBD" as $0, and both copies agreed, which is why
parity alone did not catch it.)
`estimated_first_cost` is free text so an estimator can type `$1.2m`;
`ecc_amount` is the parsed numeric the database sums. `lib/costs.ts` and
`ship.parse_cost_input()` must agree or the UI and the export disagree about
money. It earned its keep immediately: the first SQL implementation returned
**0 for every input**, because `substring(s from pattern)` returns the first
*capture group* when the pattern has one, and the optional exponent group was
capturing. Without a differential test that ships silently.

Visual baselines keep the `{platform}` suffix. Windows rasterises text through
DirectWrite/Segoe UI and a Linux container through FreeType/Liberation Sans;
sharing one baseline set means either permanent whole-page text diffs or a
threshold loosened far enough that the suite stops detecting real regressions.

---

## Gotchas

Things that cost time once and will cost it again.

**Migrations run before seeds.** The CLI applies `migrations/` then `seeds/`, so
any backfill inside a migration is a no-op on a fresh database. That is why
`seeds/002_v2_phases.sql` and `003_v2_taxonomy.sql` exist — they are the fixture
equivalents of backfills in 0007 and 0008.

**A seed guard on a column that became nullable silently stops matching.**
0014 made `annual_energy_savings` blank by default (NULL, D-9). The energy
seed's `where … annual_energy_savings = 0` then matched no rows, and the
federal fixture lost every saving: the chart read "Saved 0" while the dollar
total, and so the fixture guard, stayed correct. Guard with `coalesce(…, 0)`.

**Profiles exist only after a first sign-in.** `npm run db:reset` creates
`auth.users`, not `ship.profiles`; `claim_invite()` mints those on sign-in.
`supabase/tests/run.mjs` claims the four seeded users itself before it runs,
or every platform-admin assertion fails on a fresh database.

**`next start` is production.** With NODE_ENV=production, `lib/email` needs
`APP_URL` and uses Mailpit only when `MAILPIT_URL` is set. `@next/env` never
lets a `.env` file replace a key already in the process environment, even an
empty one, which is how the Playwright config blanks a real `RESEND_API_KEY`.

**Seed the taxonomy values line items already carry, not just the defaults.**
0008's validation trigger fails *open* only while a project has zero rows for a
kind. Give a project the generic defaults and nothing else, and every line item
holding `'ANNEX'` becomes uneditable — surfaced by an `UPDATE` that did not even
touch that field.

**`ship` must be in the local API's exposed schemas.** Without it the app signs
in fine and then lands on `/no-access`, because the schema-pinned client's
`claim_invite()` RPC 404s. It looks exactly like an authorization failure and is
not one.

**Windows reserves TCP 54223–54322**, which swallows Supabase's default 54321 and
54322. The local stack is remapped to 55420–55429. Check
`netsh interface ipv4 show excludedportrange protocol=tcp` before assuming a
port is free.

**`public.ecr.aws/supabase/postgres:17.6.1.167` ships a zero-byte entrypoint.**
The container dies instantly with no logs and `exec format error`. 17.6.1.143 is
intact and is aliased to the tag the CLI expects. Re-check when bumping the CLI.

**`pct_of_tpc` is not constrained to sum to 100.** A `CHECK` cannot span rows,
and a trigger that auto-normalised would silently rescale a number a cost
estimator typed. The UI shows a running total that goes amber off 100; the
fixture ships one package at 90% so that state is always reachable.

**Postgres 2-D arrays are not arrays-of-arrays.** `arr[i]` on a 2-D array yields
NULL, not a row. Cost an afternoon in `002_v2_phases.sql`.

---

## Not built

Deliberately, and with the reasoning, so nobody re-litigates it from scratch.

**Suggestions UI.** The schema is complete — `suggestions` table, four RLS
policies, `apply_suggestion()` / `reject_suggestion()` RPCs, a column allowlist.
No client code calls any of it. This is the consultant workflow from R5.2 and is
the real gate on consultant onboarding; it is the largest remaining piece.

**Bundling cost-efficiency logic.** Declined on the record by both Joe and
Steve. GCs/GRs scaling with project size is real and stays a verbal conversation
with the client.

**S-curve cost spreading.** Straight-line is what was specified. The engine keeps
the spreading function swappable.

**True CPM scheduling** (critical path, float, resource levelling). This is a
planning tool at year/quarter grain, not Primavera.

**Anything applied to the remote Supabase project.** That ref is shared with an
unrelated production application ([`supabase/PREFLIGHT.md`](../supabase/PREFLIGHT.md)).
Promoting these migrations is a separate, deliberate decision.

---

## Known rough edges

Not bugs exactly, but things a reader should know before they trip over them.

- **Admins and editors cannot edit other people's line items** in the UI, though
  the database allows it. D-13 says they should, from Master View (M-62, not
  done yet).
- **An editor cannot see the member list.** The Settings tab is admin-gated; the
  matrix gives editors read access to members. Narrower than intended.
- **`TaxonomyEditor` accepts a `readOnly` prop that nothing passes**, because it
  is only reachable from the admin-only Settings tab. Dead today, and a trap if
  someone surfaces the editor elsewhere without wiring it.
- **Dependency links are switched off.** They could not be created or deleted
  from the UI (`createPhaseDependency` / `deletePhaseDependency` have no
  callers), yet seeded links drew arrows and pushed bars on drag. One constant,
  `DEPENDENCY_LINKS_ENABLED = false` in
  `components/project-workspace/timeline/layout.ts`, turns off both the arrows
  and the drag auto-push (D-14). No dependency code or data was removed; flip
  it back when there is a UI to manage links.
