-- =====================================================================
-- 0021_project_view_settings.sql
-- SHIP -- per-project display settings, chosen by a project admin and
-- shared by everyone who can open the project.
--
-- SHARED PROJECT WARNING (ref gfopaidnirrtyvfmgqwi)
-- Same ground rules as 0001-0020: everything in `ship`, no extensions,
-- one transaction. Additive only -- nothing earlier is edited.
--
-- WHAT THIS ADDS
-- --------------
-- ship.projects.view_settings jsonb -- which Master View and Chunking
-- columns are hidden, and how the Timeline cost row / energy chart /
-- packages render. The SHAPE is owned by the app (lib/view-settings.ts,
-- normalizeViewSettings): anything missing or malformed renders as the
-- default, so the database only guarantees "a JSON object of sane size"
-- and does not try to mirror the TypeScript type.
--
-- WHO MAY READ / WRITE
-- --------------------
-- * Read: anyone who can read the project row (projects_select, 0009) --
--   consultants and client viewers included. That is the point: the
--   admin chooses once, every viewer sees the same layout.
-- * Write: ONLY through ship.update_project_view_settings(), which
--   requires platform admin or project admin (same check as
--   update_project, 0013 / D-8).
--
--   projects_update (0009) already limits UPDATE to project admins, but
--   0002 granted table-wide UPDATE to authenticated, so a project admin
--   could write any jsonb straight through PostgREST, skipping the size
--   check. Table UPDATE is therefore replaced with a column grant on the
--   columns that existed before this file (behaviour for those is
--   unchanged); view_settings is deliberately left out. The CHECK
--   constraint below backs the size/type rule for every other path
--   (INSERT by a platform admin, SQL run as postgres).
--
-- DOES NOT touch projects.updated_at: update_project() uses it as the
-- stale-write guard for the roster, and saving a display preference must
-- not make a concurrent Settings roster save fail with 40001.
--
-- MERGE, NOT REPLACE: p_settings carries only the views being saved
-- (e.g. {"masterView": {...}}); its top-level keys are merged into the
-- stored object and every other view is kept. A key sent as JSON null is
-- removed (that view falls back to the app default). So an admin saving
-- Master View can never wipe the Phasing/Timeline defaults, and two
-- admins saving different views at once both land. The row is locked
-- (FOR UPDATE) for the read-merge-write.
--
-- CONTRACT (lib/store.ts codes against this exact signature)
--   ship.update_project_view_settings(p_project_id text, p_settings jsonb)
--     returns jsonb  -- the stored (merged) value
--   raises 42501 not a project admin, 22023 not an object / too large,
--   P0002 no such project.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Column + constraint.
-- ---------------------------------------------------------------------
alter table ship.projects
  add column if not exists view_settings jsonb not null default '{}'::jsonb;

alter table ship.projects
  drop constraint if exists projects_view_settings_shape;

alter table ship.projects
  add constraint projects_view_settings_shape
  check (jsonb_typeof(view_settings) = 'object'
         and octet_length(view_settings::text) <= 32768);

comment on column ship.projects.view_settings is
  'Per-project display settings (lib/view-settings.ts ProjectViewSettings). Set by a project admin via ship.update_project_view_settings() (0021); read by every member. A JSON object of at most 32KB; the app normalizes anything missing.';

-- ---------------------------------------------------------------------
-- 2. Close the direct-UPDATE path for view_settings.
--    Column privileges cannot subtract from a table-level grant, so the
--    table grant is replaced by an explicit list of the pre-0021 columns.
-- ---------------------------------------------------------------------
revoke update on ship.projects from public, anon, authenticated;
grant update (id, name, created_at, created_by, updated_at) on ship.projects to authenticated;

-- ---------------------------------------------------------------------
-- 3. The write RPC.
-- ---------------------------------------------------------------------
create or replace function ship.update_project_view_settings(
  p_project_id text,
  p_settings   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current jsonb;
  v_merged  jsonb;
  v_stored  jsonb;
begin
  if not (ship.is_admin() or ship.is_project_admin(p_project_id)) then
    raise exception 'ship.update_project_view_settings: you must be an admin of project % to change its display settings', p_project_id
      using errcode = '42501';
  end if;

  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'ship.update_project_view_settings: p_settings must be a JSON object'
      using errcode = '22023';
  end if;

  select view_settings into v_current
    from ship.projects
   where id = p_project_id
     for update;

  if not found then
    raise exception 'ship.update_project_view_settings: no such project %', p_project_id
      using errcode = 'P0002';
  end if;

  -- Top-level merge; a null value removes that key. Size checked on the
  -- result, since that is what gets stored.
  select coalesce(jsonb_object_agg(key, value) filter (where value <> 'null'::jsonb), '{}'::jsonb)
    into v_merged
    from jsonb_each(coalesce(v_current, '{}'::jsonb) || p_settings);

  if octet_length(v_merged::text) > 32768 then
    raise exception 'ship.update_project_view_settings: settings are too large (% bytes, max 32768)',
      octet_length(v_merged::text)
      using errcode = '22023';
  end if;

  update ship.projects
     set view_settings = v_merged
   where id = p_project_id
  returning view_settings into v_stored;

  return v_stored;
end;
$$;

comment on function ship.update_project_view_settings(text, jsonb) is
  'Merges p_settings'' top-level keys into ship.projects.view_settings (a null value removes the key). Platform admin or project admin only (D-8). Returns the stored value. See 0021.';

revoke all on function ship.update_project_view_settings(text, jsonb) from public, anon;
grant execute on function ship.update_project_view_settings(text, jsonb) to authenticated;

commit;
