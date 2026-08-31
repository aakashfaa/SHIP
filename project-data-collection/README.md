# SHIP — Master Plan Dashboard

SHIP is a capital-planning data-collection tool. Consultants across 14
disciplines submit line items for a project. An admin then groups those
line items into chunk projects — packages numbered `PP10`, `PP11`, and so
on — and lays them out on a cost-escalating timeline. In effect, the app
digitizes the `SHIP Options Matrix_250702.xlsm` workbook that sits at the
root of this repository, turning what used to be a shared spreadsheet
into a proper multi-user workflow.

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

```bash
cp .env.example .env.local
```

Fill in `.env.local` with the Supabase project URL and anon key (ask a
maintainer if you don't have these). Then:

```bash
npm install
npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000).

## Database

All database objects live in a dedicated `ship` Postgres schema, with
migrations tracked under `supabase/migrations/`. The Supabase project
backing this app is **shared with an unrelated project**, so:

- Nothing may be created in the `public` schema.
- No Postgres extensions may be installed.

Keep all schema changes scoped to `ship` and coordinate before touching
anything at the project level (extensions, auth settings, etc.).

## Scripts

| Command         | Description                        |
| ---------------- | ----------------------------------- |
| `npm run dev`    | Start the local dev server          |
| `npm run build`  | Production build                    |
| `npm run start`  | Serve a production build            |
| `npm run lint`   | Run ESLint                          |
