-- =====================================================================
-- 0019_cost_parser.sql  --  strict cost parser (M-09 / D-16)
--
-- Redefines ship.parse_cost_input() to the STRICT grammar in lib/costs.ts
-- (`parseCostAmount`), makes line_items.ecc_amount nullable, and
-- recomputes it for every existing row.
--
-- Why. 0006's parser was "an exact port" of the old TS parser, and both
-- read the leading number and then a k/m/b only if it was the very last
-- character. So "$1.2M (incl. contingency)" was stored as $1.20,
-- "100 million" as $100, "TBD"/"~1m"/"EUR 1000" as $0 and "-250k" as
-- -$250,000 -- and the parity check passed, because both sides agreed on
-- the wrong number. ecc_amount is the basis of every Timeline and Excel
-- figure, so those misreads went straight into deliverables.
--
-- The new contract (decision D-16), identical on both sides:
--
--   [$] NUMBER [SUFFIX], case-insensitive, surrounding whitespace ignored
--     NUMBER  1200000 | 1,200,000 | 1,200,000.50 | 1.2 | .5
--             (commas must be real thousands groups)
--     SUFFIX  k | thousand  (x1e3)   m | mil | million  (x1e6)
--             b | billion   (x1e9)   -- whitespace before it allowed
--
--   blank                         -> NULL  (unanswered, D-9)
--   anything else outside that    -> NULL  (UNREADABLE -- not 0)
--   negative, > 1e13, > 100 chars -> NULL
--
-- NULL rather than 0 is the point: a $0 package looks like a real answer
-- and sails into a spreadsheet; a NULL ecc_amount next to non-blank
-- estimated_first_cost text is detectable ("N items with unreadable
-- cost") by the export, the Timeline and anyone with psql:
--
--   select id, estimated_first_cost from ship.line_items
--    where ecc_amount is null and btrim(estimated_first_cost) <> '';
--
-- lib/mappers.ts reads a NULL ecc_amount as 0 for arithmetic
-- (`toNumber(...) ?? 0`); the unreadable FLAG comes from re-parsing the
-- text with lib/costs.ts `parseCostAmount`, which is why the two parsers
-- must agree exactly. `npm run check:parser` diffs them -- add a case
-- there whenever either side changes.
--
-- Whitespace is the explicit class [ \t\n\r\f\v ] on both sides
-- (JS `\s` and `.trim()` cover a dozen Unicode spaces that Postgres'
-- [[:space:]] does not;   is the non-breaking space Excel pastes).
-- =====================================================================

create or replace function ship.parse_cost_input(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text   text;
  v_match  text[];
  v_amount numeric;
begin
  v_text := regexp_replace(
    coalesce(p_value, ''),
    '^[ \t\n\r\f\v ]+|[ \t\n\r\f\v ]+$',
    '',
    'g'
  );

  if v_text = '' or length(v_text) > 100 then
    return null;
  end if;

  -- Mirrors COST_PATTERN in lib/costs.ts character for character. A
  -- leading '-' simply fails to match, which is how negatives are
  -- rejected (TS reports them as 'negative' for the form message; both
  -- sides store nothing).
  v_match := regexp_match(
    v_text,
    '^\$?[ \t\n\r\f\v ]*'
      || '((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?|\.[0-9]+)'
      || '[ \t\n\r\f\v ]*'
      || '(k|thousand|m|mil|million|b|billion)?$',
    'i'
  );

  if v_match is null then
    return null;
  end if;

  v_amount := replace(v_match[1], ',', '')::numeric
              * case lower(coalesce(v_match[2], ''))
                  when 'k'        then 1000
                  when 'thousand' then 1000
                  when 'm'        then 1000000
                  when 'mil'      then 1000000
                  when 'million'  then 1000000
                  when 'b'        then 1000000000
                  when 'billion'  then 1000000000
                  else 1
                end;

  -- $10 trillion: MAX_COST_AMOUNT in lib/costs.ts.
  if v_amount > 10000000000000 then
    return null;
  end if;

  return v_amount;
end;
$$;

revoke all    on function ship.parse_cost_input(text) from public;
grant execute on function ship.parse_cost_input(text) to authenticated;

-- ---------------------------------------------------------------------
-- ecc_amount: NULL now means "blank or unreadable", never "zero".
-- ---------------------------------------------------------------------
alter table ship.line_items
  alter column ecc_amount drop not null,
  alter column ecc_amount set default null;

comment on column ship.line_items.ecc_amount is
  'Parsed, un-escalated Expected Construction Cost per unit, derived from estimated_first_cost by ship.sync_line_item_ecc() using ship.parse_cost_input() (0019 strict grammar). NULL = blank or UNREADABLE text (never silently 0); a NULL here with non-blank estimated_first_cost is an unreadable cost to flag. Do not write directly.';

-- ---------------------------------------------------------------------
-- Recompute every existing row under the new grammar.
--
-- Done with this table's user triggers temporarily DISABLED, and only
-- those that were enabled to begin with (so a trigger someone disabled
-- on purpose stays disabled). Two reasons:
--   * the row is otherwise untouched, so the normalize / numbering /
--     taxonomy-check triggers have no business running -- and
--     line_items_dd_check_taxonomy would REJECT the update for any legacy
--     row whose category has since been archived, aborting the migration;
--   * 0014's immutability guard treats ecc_amount as a system column and
--     a migration has no signed-in platform admin, so a direct
--     `set ecc_amount = ...` would be refused.
-- sync_line_item_ecc itself is not needed: we set the same value it
-- would compute.
-- ---------------------------------------------------------------------
do $$
declare
  v_trigger    record;
  v_disabled   text[] := '{}';
  v_name       text;
  v_unreadable integer;
begin
  for v_trigger in
    select tgname
      from pg_catalog.pg_trigger
     where tgrelid = 'ship.line_items'::regclass
       and not tgisinternal
       and tgenabled <> 'D'
  loop
    execute format('alter table ship.line_items disable trigger %I', v_trigger.tgname);
    v_disabled := v_disabled || v_trigger.tgname::text;
  end loop;

  update ship.line_items
     set ecc_amount = ship.parse_cost_input(estimated_first_cost)
   where ecc_amount is distinct from ship.parse_cost_input(estimated_first_cost);

  foreach v_name in array v_disabled loop
    execute format('alter table ship.line_items enable trigger %I', v_name);
  end loop;

  select count(*)
    into v_unreadable
    from ship.line_items
   where ecc_amount is null
     and btrim(coalesce(estimated_first_cost, '')) <> '';

  if v_unreadable > 0 then
    raise notice '0019: % line item(s) have an estimated_first_cost the strict parser cannot read; ecc_amount is NULL for them (flagged, not $0).', v_unreadable;
  end if;
end;
$$;
