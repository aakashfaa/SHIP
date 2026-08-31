-- =====================================================================
-- 0005_ship_function_grants.sql
-- SHIP -- close the PUBLIC EXECUTE gap left on three trigger functions.
--
-- FINDING (security advisor, 3x WARN anon_security_definer_function_executable)
-- ------------------------------------------------------------------------
-- 0003_ship_numbering.sql revoked PUBLIC EXECUTE on ship.discipline_prefix
-- but not on the three SECURITY DEFINER trigger functions it also
-- created: ship.fill_item_number(), ship.fill_chunk_number(),
-- ship.normalize_line_item(). They therefore kept Postgres's default
-- PUBLIC EXECUTE grant, inconsistent with the explicit
-- revoke-then-grant discipline every other function in 0002/0003/0004
-- follows.
--
-- PRACTICAL RISK: nil.
--   * `anon` has no `USAGE` on schema `ship` (never granted, see 0002),
--     so `anon` cannot even see these functions to call them.
--   * PostgREST does not expose `returns trigger` functions as
--     `/rest/v1/rpc/...` endpoints at all -- they are not callable via
--     the API regardless of EXECUTE privilege.
--   * A BEFORE-row trigger is invoked by the executor as part of the
--     triggering statement (INSERT/UPDATE on the table); the invoking
--     role's EXECUTE privilege on the trigger function is NOT checked
--     for that invocation. Trigger firing depends only on: (a) the role
--     having the relevant table privilege (INSERT/UPDATE, granted in
--     0002), and (b) the function owner (SECURITY DEFINER) having
--     EXECUTE, which is unaffected by this migration since ownership
--     privilege is separate from the PUBLIC/anon/authenticated grants
--     revoked here.
--
-- This migration is a tidy-up for consistency with 0002/0003/0004's
-- grant discipline, not an incident response. No GRANT is added back to
-- `authenticated` for these three: they are trigger-only plumbing, never
-- meant to be called directly (unlike ship.discipline_prefix, which
-- ship.fill_item_number() calls and which IS granted to authenticated
-- for other reasons -- see 0003).
--
-- Verified empirically (rolled-back transaction, impersonating a real
-- SHIP admin via `set local role authenticated` +
-- `set local request.jwt.claims`) that both triggers still fire and
-- assign numbers correctly after this revoke. See the migration PR /
-- session notes for the query output.
--
-- Re-runnable: `revoke ... from ...` is a no-op when the privilege is
-- not held (no error), so this file can be replayed safely.
-- =====================================================================

begin;

revoke all on function ship.fill_item_number()    from public;
revoke all on function ship.fill_chunk_number()    from public;
revoke all on function ship.normalize_line_item()  from public;

-- Explicit, matching the belt-and-suspenders style of 0002/0003/0004
-- (PUBLIC covers both, but naming them removes any doubt on re-read).
revoke execute on function ship.fill_item_number()    from anon;
revoke execute on function ship.fill_chunk_number()   from anon;
revoke execute on function ship.normalize_line_item() from anon;

revoke execute on function ship.fill_item_number()    from authenticated;
revoke execute on function ship.fill_chunk_number()   from authenticated;
revoke execute on function ship.normalize_line_item() from authenticated;

-- Deliberately NO grant back to `authenticated`: these three are
-- BEFORE-row trigger functions only (see 0003). They are invoked by the
-- executor as part of a table INSERT/UPDATE, which does not require the
-- invoking role to hold EXECUTE on the trigger function itself.

commit;
