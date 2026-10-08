-- =====================================================================
-- 0023_yes_no_unanswered.sql
--
-- The five built-in Yes/No questions become tri-state:
--   'Yes' | 'No' | NULL (not answered)
--
-- Why: they were `text not null check (... in ('Yes','No'))` (0001) and the
-- form rendered them as checkboxes, so a question the person never looked
-- at was saved as 'No' -- a claim nobody made. 0014 already made the same
-- change for every built-in dropdown (D-9: blank = unanswered); these five
-- were left behind only because a checkbox has no "unanswered" state. The
-- form now asks Yes / No with nothing preselected, and a skipped question
-- is written as NULL.
--
-- Scope, deliberately narrow:
--   * DROP NOT NULL only. The existing CHECK constraints
--     (`col = ANY (ARRAY['Yes','No'])`) already accept NULL -- a CHECK
--     passes when its expression is NULL -- so they stay as they are and
--     still reject '' or any other text.
--   * No defaults are added (there are none today).
--   * Existing rows are NOT rewritten. A stored 'No' may be a genuine
--     answer; there is no way to tell, so it stays.
--
-- Nothing server-side assumes non-null: ship.apply_suggestion() copies
-- the columns verbatim and ship.suggestable_line_item_columns() only lists
-- them. Idempotent: DROP NOT NULL on an already-nullable column is a no-op.
--
-- Rollback (only if no NULLs have been written since):
--   alter table ship.line_items
--     alter column addressing_resiliency_sustainability set not null, ...;
-- =====================================================================

alter table ship.line_items
  alter column addressing_resiliency_sustainability drop not null,
  alter column addressing_deferred_maintenance      drop not null,
  alter column code_life_safety_improvement         drop not null,
  alter column accessibility_improvement            drop not null,
  alter column historic_impact                      drop not null;

comment on column ship.line_items.historic_impact is
  'Yes / No / NULL (not answered). Nullable since 0023, like the other four built-in Yes/No columns.';

notify pgrst, 'reload schema';
