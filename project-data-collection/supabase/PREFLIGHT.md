# Supabase Pre-Flight Audit — project `gfopaidnirrtyvfmgqwi`

Audit date: 2026-08-31. Read-only audit. No DDL/DML was executed; every statement below was a `SELECT` (or an MCP `list_*`/`get_*` read) run through the Supabase MCP server, plus one unauthenticated public GET to the project's `/auth/v1/settings` endpoint. No writes were performed and no `service_role` key or DB password was retrieved.

## 1. Verdict

**Conditionally safe to run `create schema ship`, but NOT safe to invite users into SHIP until mitigations below are applied.**

- `create schema ship` itself is a low-risk, additive DDL operation. No schema named `ship` exists today (confirmed below), and creating a new schema does not touch `public`, `auth`, or any existing table, trigger, or policy.
- **Blocker before inviting any real users to SHIP:** this project's shared `auth.users` table has an `AFTER INSERT` trigger (`on_auth_user_created` → `public.handle_new_user()`) that auto-provisions **every new signup** into the other application's `public.profiles` table, and a second mechanism (`link_project_member_invite` trigger + email-matching) that can auto-activate that profile as a member of one of the other app's construction **projects** if the person's email happens to match a pending `invited_email` row. This means: if SHIP is deployed against this same project and uses Supabase Auth signup, every SHIP user will silently materialize as a user of the other (unrelated, production) "field reports" application — see §3 for full evidence.
- **Secondary blocker:** most of the other app's `public` tables (`projects`, `field_reports`, `field_report_items`, `field_report_item_photos`, `field_report_item_references`, `profiles`) have RLS policies of the form `USING (true)` for the `authenticated` role — i.e., **any authenticated user, from any app sharing this Supabase project, can read all rows** in those tables. Only `project_members` and `field_report_setups` actually gate on project membership. This means a SHIP invitee, the moment their `auth.users` row exists and is authenticated, can read all of the other company's field-report data via the exposed PostgREST API, regardless of whether they were ever added to a project.

**Recommended path:** either (a) get the trigger/RLS hazard mitigated by the other app's owner before onboarding any SHIP users (e.g. scope the trigger to a claims/allow-list, or have SHIP use a separate Supabase project), or (b) confirm with the other app's owner that they accept this exposure. Do not treat "create the `ship` schema" and "invite users" as the same decision — the schema creation is safe today; user invitation is not, until one of the above is resolved.

---

## 2. `public` schema snapshot (before-state, for later diffing)

Non-system schemas present: `auth`, `extensions`, `graphql`, `graphql_public`, `pgbouncer`, `public`, `realtime`, `storage`, `supabase_migrations`, `vault` (all standard Supabase-managed schemas). **No `ship` schema exists** (`select count(*) from information_schema.schemata where schema_name = 'ship'` → `0`). No other custom application schema exists — the other app lives entirely inside `public`.

`public` currently contains exactly **9 tables**, all with RLS enabled (`rls_enabled: true`):

| table | columns | approx. rows (`n_live_tup`) | PK |
|---|---|---|---|
| `profiles` | 6 | 9 | `id` (FK → `auth.users.id`) |
| `projects` | 11 | 14 | `id` |
| `project_members` | 8 | 20 | `id` |
| `field_report_setups` | 11 | 0 | `id` |
| `field_reports` | 18 | 22 | `id` |
| `field_report_items` | 13 | 77 | `id` |
| `field_report_item_photos` | 12 | 121 | `id` |
| `project_floor_plans` | 16 | 16 | `id` |
| `field_report_item_references` | 7 | 6 | `id` |

Column lists (verbatim, in table order):
- `profiles`: id, email, full_name, role, created_at, updated_at
- `projects`: id, name, number, client_name, location, levels, created_by, created_at, updated_at, next_report_number, report_number_prefix
- `project_members`: id, project_id, user_id, invited_email, role, status, invited_by, created_at
- `field_report_setups`: id, project_id, pdf_path, map_snapshot_path, selected_pdf_page, overlay_offset_x, overlay_offset_y, overlay_scale, overlay_rotation_degrees, updated_by, updated_at
- `field_reports`: id, project_id, report_date, title, reporter_id, weather_summary, start_time, status, created_at, updated_at, report_number, copies, next_item_number, general_notes, include_general_notes, include_location_photos, display_number_override, include_floor_references
- `field_report_items`: id, report_id, level_name, title, sort_order, created_by, created_at, updated_at, item_number, location_detail, description, status, carried_from_item_id
- `field_report_item_photos`: id, item_id, slot, storage_path, sort_order, gps_lat, gps_lng, floor_level, floor_x, floor_y, created_by, created_at
- `project_floor_plans`: id, project_id, level_name, source_path, source_type, selected_page, rendered_image_path, image_width_px, image_height_px, center_lat, center_lng, meters_per_pixel, rotation_degrees, calibrated_at, updated_by, updated_at
- `field_report_item_references`: id, report_id, item_id, note, sort_order, created_by, created_at

This is the other application's schema — a construction "field reports" tool (projects, floor plans, field reports with photo-annotated items). It is entirely separate from anything SHIP owns; **do not modify any of the above** when building `ship`.

`storage.buckets`: one bucket, `field-report-assets` (private, `public = false`), belonging to the other app, with its own RLS policies on `storage.objects` (`field_report_assets_select_all`, `_insert_any_authenticated`, `_update_member`, `_delete_member`).

`auth.users` row count: **11**.

Other non-system schemas (`auth`, `extensions`, `graphql`, `graphql_public`, `pgbouncer`, `realtime`, `storage`, `supabase_migrations`, `vault`) are all standard Supabase platform-managed schemas — nothing custom in them beyond the standard Supabase installs.

---

## 3. Shared-`auth.users` hazard assessment — **YES, the other app auto-provisions any new user**

Definitive evidence, in order:

**a) There is a trigger on `auth.users`:**
```
trigger_name: on_auth_user_created
table: auth.users
function: public.handle_new_user()
tgtype: 5 (AFTER INSERT, FOR EACH ROW)
tgenabled: O (enabled)
def: CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()
```

**b) The trigger function body (`public.handle_new_user`, `SECURITY DEFINER`):**
```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do update set email = excluded.email;

  update public.project_members
     set user_id = new.id,
         status = 'active'
   where user_id is null
     and lower(invited_email) = lower(new.email);

  return new;
end;
$function$
```
Every single row inserted into `auth.users` — regardless of which application caused the signup — gets a matching row in `public.profiles` (the other app's user table), **and** if that email happens to already exist as a pending `invited_email` on any `project_members` row (i.e., someone at the other company invited a contractor by email before they signed up), the new user is immediately and automatically activated as a member of that construction project.

**c) A second, independent auto-linking path exists** via `public.link_project_member_invite()` (also `SECURITY DEFINER`, trigger on `project_members` insert): if a new `project_members` row is inserted with a `user_id` of null and an `invited_email`, it looks up `public.profiles` by email and — if a match exists — immediately sets `user_id` and flips `status` to `'active'`. Combined with (b), this means email-based identity linking happens from *either* direction (new auth user → matched to pending invite, or new invite → matched to existing profile).

**d) `public.profiles` shape and FK:**
```
id uuid PK, FK profiles_id_fkey -> auth.users(id)
email text (unique), full_name text, role app_role ('admin'|'member', default 'member'),
created_at timestamptz, updated_at timestamptz
```
Confirms `profiles` is a 1:1 shadow table of `auth.users`, populated purely by the trigger.

**e) RLS policies on the other app's `public` tables — mostly "any authenticated user," not membership-gated:**

| table | SELECT policy | qual |
|---|---|---|
| `profiles` | `profiles_select_all` | `true` (any authenticated user) |
| `projects` | `projects_select_all` | `true` |
| `field_reports` | `field_reports_select_all` | `true` |
| `field_report_items` | `field_report_items_select_all` | `true` |
| `field_report_item_photos` | `field_report_item_photos_select_all` | `true` |
| `field_report_item_references` | `field_report_item_references_select_all` | `true` |
| `project_floor_plans` | `project_floor_plans_select_all` | `true` |
| `project_members` | `project_members_select_member` | `is_project_member(project_id)` — **actually gated** |
| `field_report_setups` | `field_report_setups_select_member` | `is_project_member(project_id)` — **actually gated** |

So 7 of 9 tables are readable by *any* authenticated user regardless of project membership; only `project_members` and `field_report_setups` check real membership. **A SHIP invitee, once they exist in `auth.users` and have an authenticated session, can read all of the other app's projects, field reports, field-report items, and photo metadata through the exposed PostgREST API** — even without ever being added as a project member. INSERT/UPDATE/DELETE are more tightly gated (mostly `created_by = auth.uid()` or `is_project_member`/`is_project_owner`), so write exposure is lower, but read exposure is broad.

**f) Also note:** `public.add_project_owner_member()` is a further `SECURITY DEFINER` trigger function (fires on `projects` insert) that auto-adds the creator as project `owner` in `project_members` — internal to the other app's own logic, not a cross-app hazard by itself, but confirms the app is actively using trigger-based automation on shared infrastructure.

**Conclusion: definitive YES.** Any user that signs up through Supabase Auth on this project — including SHIP invitees — is automatically inserted into the other app's `profiles` table and is potentially auto-activated into one of their projects. This is the single most important finding of this audit.

---

## 4. Current settings to preserve

**Exposed schemas (PostgREST `db-schema`):** Could not be determined via the available MCP tools or SQL. There is no `pgrst.db_schemas` (or similar) entry in `pg_settings` (`select name, setting from pg_settings where name like 'pgrst.%'` returned zero rows), and no project-config/management-API tool is exposed by this MCP server (only `execute_sql`, `list_tables`, `list_extensions`, `get_advisors`, `get_project_url`, `get_publishable_keys`, edge-function and branch tools, and `query_logs` are available — no `get_project`/`list_projects`/auth-config tool). **Action required before deploying:** an operator with Dashboard access must check Project Settings → API → "Exposed schemas" directly and append `ship` to whatever list is already there (commonly `public, graphql_public`, but this must be confirmed, not assumed) — do not replace it.

**Installed extensions** (`installed_version` not null; everything else in `pg_extension`'s available list is *not* installed):
| extension | schema | version |
|---|---|---|
| `pgcrypto` | extensions | 1.3 |
| `plpgsql` | pg_catalog | 1.0 |
| `supabase_vault` | vault | 0.3.1 |
| `uuid-ossp` | extensions | 1.1 |
| `pg_stat_statements` | extensions | 1.11 |

Notably **not installed**: `citext`, `pg_cron`, `pg_net`, `pg_graphql` is listed among available-but-not-installed too (though `graphql`/`graphql_public` schemas exist as standard Supabase scaffolding — the extension itself shows `installed_version: null` in `pg_extension`, which is worth double-checking directly in the dashboard if GraphQL is relied upon). SHIP should not need to install anything new per the stated plan, but if it later wants `citext` or `pg_cron`, they are currently absent and would need adding (with the other app's awareness, since extensions are database-wide).

**Auth configuration** (from the public, unauthenticated `GET https://gfopaidnirrtyvfmgqwi.supabase.co/auth/v1/settings` endpoint — no service-role or password used):
```json
{
  "external": {"anonymous_users": false, "apple": false, "azure": false, "bitbucket": false,
    "discord": false, "facebook": false, "snapchat": false, "figma": false, "fly": false,
    "github": false, "gitlab": false, "google": false, "keycloak": false, "kakao": false,
    "linkedin": false, "linkedin_oidc": false, "notion": false, "spotify": false, "slack": false,
    "slack_oidc": false, "workos": false, "twitch": false, "twitter": false,
    "email": true, "phone": false, "zoom": false},
  "disable_signup": false,
  "mailer_autoconfirm": true,
  "phone_autoconfirm": false,
  "sms_provider": "twilio",
  "saml_enabled": false,
  "saml_private_key_next_configured": true,
  "passkeys_enabled": false
}
```
- **Only the `email` provider is enabled**; all OAuth/SMS/SAML/passkey providers are off (SMS provider is configured as `twilio` but phone auth itself is disabled).
- **Signups are open** (`disable_signup: false`).
- **`mailer_autoconfirm: true`** — email confirmation is **NOT required**; new signups are auto-confirmed. Combined with §3, this means a new SHIP signup is immediately live *and* immediately provisioned into the other app's `profiles` table with no confirmation-click delay.
- **Site URL, redirect URLs, and whether custom SMTP vs. the built-in rate-limited mailer is configured could not be determined** — these are not exposed by the public settings endpoint or by any available MCP/SQL tool. Since `mailer_autoconfirm` is true, the built-in mailer's rate limits are less likely to be hit by signup emails specifically, but this should still be confirmed in Dashboard → Authentication → Email (and → URL Configuration for Site URL / Redirect URLs) before relying on email-based flows (e.g. magic links, password reset) at any volume.

**PITR/backups, plan tier, and region:** Could not be determined — no management/billing tool is exposed by this MCP server and these are not visible via SQL. Must be checked in Dashboard → Settings → Add-ons / General before deployment, since they affect disaster-recovery guarantees for the *other* app's production data as well as SHIP's future data.

**`supabase_realtime` publication:** Empty — `select * from pg_publication_tables where pubname = 'supabase_realtime'` returned zero rows. No tables are currently broadcast over Realtime.

---

## 5. Deployment values

- **API URL:** `https://gfopaidnirrtyvfmgqwi.supabase.co`
- **Anon (legacy, JWT) key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmb3BhaWRuaXJydHl2Zm1ncXdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczOTA3MDcsImV4cCI6MjA5Mjk2NjcwN30.H1mXE1Xw6FIzwiVUFwqD6HLnzGGlYur0WQsK6PMQ9tc`
- **Publishable key (new format):** `sb_publishable_G8epwI4ExG_Xx0n3cQg1cw_R3lXnqip`

A `service_role` (secret) API key and the database password are available through the Supabase project but were **not retrieved and are not reproduced here**, per instructions.

---

## 6. Risks and recommendations (ranked)

1. **[Critical] Cross-app user auto-provisioning via `on_auth_user_created` → `handle_new_user()`.** Any SHIP signup becomes a row in the other app's `profiles` table, and can be silently auto-activated as a member of one of their construction projects if the email matches a pending invite. **Recommendation:** before inviting any real SHIP user, either (a) have the other app's owner scope `handle_new_user()` to ignore/branch on some claim (e.g., a `raw_app_metadata` flag SHIP sets at signup) so it doesn't blindly insert for every `auth.users` row, or (b) provision SHIP in a separate Supabase project instead of sharing this one, or (c) get explicit, informed sign-off from the other app's owner that this is acceptable. This is a decision for a human with authority over the other app, not something to route around silently.

2. **[Critical/High] Broad `USING (true)` SELECT policies on 7 of 9 `public` tables.** Any authenticated user — including a SHIP user with zero relationship to the other company — can read all of `projects`, `field_reports`, `field_report_items`, `field_report_item_photos`, `field_report_item_references`, `project_floor_plans`, and `profiles` via the exposed REST API. **Recommendation:** flag to the other app's owner regardless of the SHIP decision — this is a pre-existing exposure to *any* authenticated user of *any* app on this project, not something SHIP introduces, but SHIP sharing this project makes it concretely exploitable today rather than theoretical.

3. **[Medium] Six `SECURITY DEFINER` functions in `public` are callable by `anon`/`authenticated` via PostgREST RPC** (`add_project_owner_member`, `assign_item_number`, `assign_report_number`, `handle_new_user`, `is_project_member`, `is_project_owner`, `link_project_member_invite` — flagged by the security advisor). These are pre-existing findings belonging to the other app, not introduced by SHIP, but worth noting since SHIP will add its own RPCs into the same exposed API surface — keep SHIP's functions `SECURITY INVOKER` unless there's a specific reason not to, to avoid adding to this class of finding.

4. **[Medium] "Exposed schemas" list, Site URL/redirect URLs, custom SMTP, PITR/backup status, and plan/region could not be verified via available tools.** These require Dashboard or Management-API access this MCP server doesn't expose. **Recommendation:** an operator should confirm each of these directly in the Supabase Dashboard immediately before the `ship` schema is exposed via the API, and specifically **append** (not replace) `ship` to the existing exposed-schemas list.

5. **[Low] Leaked-password protection is disabled** (`auth_leaked_password_protection` advisor finding) and several RLS policies re-evaluate `auth.uid()` per-row instead of `(select auth.uid())` (performance-only). Pre-existing, unrelated to the SHIP rollout, listed here only so future advisor diffs can distinguish pre-existing findings from anything SHIP introduces. Full pre-existing advisor findings (7 security WARN, 11 performance INFO/WARN) were captured during this audit and are available on request if a baseline diff file is wanted.

6. **[Info] Row-count baseline captured in §2 above** — re-run the same `n_live_tup` query after `ship` deployment to prove the other app's tables were undisturbed.
