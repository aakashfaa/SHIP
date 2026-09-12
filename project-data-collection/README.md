# SHIP — Master Plan Dashboard

SHIP is a capital phasing and cost model for architecture practices.
Consultants across 14 disciplines submit line items for a project. Those
get grouped into packages — numbered `PP10`, `PP11`, and so on — which
decompose into phases (study, design, construction, closeout) laid out on
a timeline that escalates cost from wherever each phase lands.

It started as a digital version of the `SHIP Options Matrix_250702.xlsm`
workbook at the root of this repository. v2 turned it into a planning
tool: design schedulable years ahead of the construction it belongs to,
per-project cost and escalation parameters, Gantt dependencies, per-project
permission tiers, a Revit-style what-if sandbox, an energy-reduction
chart, and Excel export.

## Documentation

| Read this | For |
| --- | --- |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | **Start here.** What exists, where it lives, what will bite you |
| [`docs/SPEC-v2-phasing-and-cost-model.md`](docs/SPEC-v2-phasing-and-cost-model.md) | What was agreed and who asked for each piece |
| [`supabase/LOCAL-DEV.md`](supabase/LOCAL-DEV.md) | Running the local database |
| [`supabase/README.md`](supabase/README.md) | The `ship` schema, migration by migration |
| [`supabase/PREFLIGHT.md`](supabase/PREFLIGHT.md) | Why the remote project is off limits |

## Where the app lives

The Next.js app is in this `project-data-collection/` subdirectory, not
the repository root. Run every command below from inside this directory.
This also means that if you're setting up the Vercel project, its **Root
Directory** must be set to `project-data-collection` — otherwise the
build will fail to find `package.json`.

## Stack

- [Next.js 16](https://nextjs.org/) (App Router)
- React 19
- Tailwind CSS v4 (CSS-first config — there is no `tailwind.config.js`)
- [Supabase](https://supabase.com/) (Postgres + Auth)

Node.js 20.9 or later is required, per Next.js 16.

## Local setup

Development runs against a **local Supabase stack in Docker**, not the
hosted project. Start Docker Desktop, then:

```bash
npm install
npm run db:start     # boots Postgres + Auth, applies migrations and seeds
npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000). Sign in
with any of the seeded accounts (password `localdev123` for all four) —
each one holds a different project role, which is the quickest way to see
the permission tiers:

| email | role |
| --- | --- |
| `admin@gmail.com` | admin |
| `planning@atlasmech.com` | editor |
| `consultant1@gmail.com` | consultant |
| `electrical@voltworks.com` | viewer |

`.env.local` already points at the local stack. The previous
remote-pointing values are preserved in `.env.remote.local.bak`; see
[`supabase/LOCAL-DEV.md`](supabase/LOCAL-DEV.md) before switching back.

## Database

All database objects live in a dedicated `ship` Postgres schema, with
migrations tracked under `supabase/migrations/`. The hosted Supabase
project backing this app is **shared with an unrelated production
application**, so:

- Nothing may be created in the `public` schema.
- No Postgres extensions may be installed.
- No trigger may ever be created on `auth.users`.

Keep all schema changes scoped to `ship` and coordinate before touching
anything at the project level (extensions, auth settings, etc.).

**Migrations 0006–0011 have not been applied to the hosted project.** They
are developed and verified locally; promoting them is a separate,
deliberate decision. [`supabase/PREFLIGHT.md`](supabase/PREFLIGHT.md) has
the audit explaining why.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local dev server |
| `npm run build` | Production build |
| `npm run start` | Serve a production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Type-check the app and the tests |
| `npm run db:start` / `db:stop` | Boot / shut down the local Supabase stack |
| `npm run db:reset` | Wipe, re-apply migrations and seeds, re-create dev users |
| `npm run db:psql` | Interactive psql against the local database |
| `npm run test` | Playwright suite (22 tests, incl. visual baselines) |
| `npm run test:unit` | Cost-engine unit tests (53 assertions, no browser or DB) |
| `npm run check:parser` | Verify the SQL and TypeScript cost parsers agree |
| `npm run test:all` | typecheck + unit + Playwright |
