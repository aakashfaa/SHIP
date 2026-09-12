# Local Supabase stack

All v2 schema work is developed and verified **here**, against a disposable
local Postgres in Docker — never against the remote project.

The reason is in [`PREFLIGHT.md`](./PREFLIGHT.md): remote project ref
`gfopaidnirrtyvfmgqwi` is shared with an unrelated production application, its
`auth.users` carries their signup trigger, and most of their `public` tables
are readable by any authenticated user of the database. Applying a migration
there is a decision with someone else's blast radius attached. Applying one
here costs nothing and is undone by `npm run db:reset`.

---

## Commands

```bash
npm run db:start     # boot the stack (applies migrations/*.sql, then seeds/*.sql)
npm run db:reset     # wipe, re-apply everything, re-create the dev users
npm run db:users     # (re)create sign-in-able dev users only
npm run db:psql      # interactive psql against the local database
npm run db:stop      # shut the stack down
```

`db:reset` is the one you want after editing any file in `migrations/`. It is
destructive to local data only.

## Endpoints

| | URL |
|---|---|
| API (PostgREST + GoTrue) | http://127.0.0.1:55421 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:55422/postgres` |
| Studio | http://127.0.0.1:55423 |
| **Mailpit** | http://127.0.0.1:55424 |

Mailpit captures every outbound email. Invites and magic links from
`app/api/admin/invite/route.ts` land there instead of being delivered, which
also means local work cannot burn the remote project's shared
~2–4 emails/hour quota.

## Dev users

`npm run db:users` creates these through GoTrue's admin API. Password for all
three is `localdev123`.

| email | role |
|---|---|
| `admin@gmail.com` | platform admin — sees every project |
| `consultant1@gmail.com` | consultant |
| `planning@atlasmech.com` | consultant (Mechanical) |

These addresses are in `seeds/001_seed.sql`'s `pending_invites` list on
purpose. The script deliberately does **not** insert `ship.profiles` rows —
those are minted by `ship.claim_invite()` on first sign-in, so signing in
locally exercises the real invite gate instead of routing around it.

---

## Windows notes

Three things bit during setup. All are fixed in committed config, but they
will bite again on a fresh machine.

### 1. Ports are remapped out of Supabase's defaults

Windows reserves TCP ranges for Hyper-V/WinNAT, and on this machine
**54223–54322** is reserved — which swallows Supabase's default API port
(54321) and DB port (54322). The failure is opaque:

```
failed to start docker container: ports are not available: exposing port
TCP 0.0.0.0:54322 -> 127.0.0.1:0: listen tcp 0.0.0.0:54322: bind: An attempt
was made to access a socket in a way forbidden by its access permissions.
```

Check your own machine's reserved ranges before assuming these ports are free:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

`config.toml` therefore uses **55420–55429**. If that block is reserved on
your machine too, move it and update `.env.local` to match.

### 2. Git Bash mangles container paths

Running `docker run --entrypoint /bin/sh ...` from Git Bash produces:

```
exec: "C:/Program Files/Git/usr/bin/sh": stat ...: no such file or directory
```

MSYS rewrites anything that looks like a POSIX path into a Windows path
*before* Docker sees it. Prefix such commands with `MSYS_NO_PATHCONV=1`, or
run them from PowerShell.

### 3. A corrupt image layer survives `docker rmi` + re-pull

If the disk fills while Docker is pulling, layers can be written truncated
while the metadata still records them as complete. The symptom is a container
that dies instantly with **no logs at all**, and:

```
exec /usr/local/bin/docker-entrypoint.sh: exec format error
```

which really means the file is zero bytes. Confirm with:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint /bin/sh <image> \
  -c "ls -la /usr/local/bin/docker-entrypoint.sh"
```

`docker rmi` + `docker pull` does **not** fix it — the content store is
addressed by digest, so the re-pull deduplicates straight back onto the bad
blob. You need a content GC (`docker image prune -a`) first, and if the layer
is bad at the registry, pin a known-good tag instead.

> As of this writing `public.ecr.aws/supabase/postgres:17.6.1.167` ships a
> zero-byte entrypoint, while `17.6.1.143` is intact. The workaround is to
> alias the good image to the tag the CLI expects:
>
> ```bash
> docker pull public.ecr.aws/supabase/postgres:17.6.1.143
> docker tag  public.ecr.aws/supabase/postgres:17.6.1.143 \
>             public.ecr.aws/supabase/postgres:17.6.1.167
> ```
>
> Re-check when bumping the pinned `supabase` CLI version in `package.json`;
> this alias is a workaround for a broken upstream image, not a permanent
> arrangement.

---

## Switching back to the remote project

`.env.local` points at the local stack. The previous remote-pointing values
are preserved verbatim in `.env.remote.local.bak`:

```bash
cp .env.remote.local.bak .env.local
```

Both files are gitignored. Note that the local keys in `.env.local` are the
Supabase CLI's well-known demo keys — identical on every machine, and useless
against anything but a local container.

## Migration file naming

The files here are `0001_…` … `0005_…`, not the CLI's
`<YYYYMMDDHHMMSS>_name.sql` convention. That was deliberate — see
[`README.md`](./README.md) — because they are applied to the remote project
**by hand**, in order, and the timestamp format invites `supabase db push`,
which operates on the whole database and must never be pointed at the shared
project.

The CLI sorts migrations lexicographically and parses the leading digits as
the version, so `0001_…` works fine for `db reset` locally. Keep the
numbering; do not rename these to timestamps.
