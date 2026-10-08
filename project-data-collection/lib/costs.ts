/**
 * Cost and quantity input parsing.
 *
 * `estimated_first_cost` is free text on purpose -- consultants type "$1.2M",
 * "850k" or "1,250,000" -- and every dollar on the Timeline, in the Excel
 * export and in the printed report is derived from it. The SQL twin,
 * `ship.parse_cost_input()` (migration 0019), fills `line_items.ecc_amount`
 * from the same text, and the two MUST agree: the screen reads one, the
 * export sums the other. `npm run check:parser` diffs them on every case we
 * have ever been bitten by -- add a case there whenever this grammar changes.
 *
 * The grammar is deliberately STRICT (decision D-16). The old parser took
 * "the leading number, then a k/m/b if it happens to be the last character",
 * which read "$1.2M (incl. contingency)" as $1.20, "100 million" as $100,
 * "TBD" and "~1m" as $0 and "-250k" as minus a quarter of a million -- all
 * silently, and both parsers agreed, so the parity check stayed green while
 * agreeing on the wrong number. Now anything outside the grammar is
 * UNREADABLE: the form flags it, the SQL side stores NULL (not 0), and the
 * export counts it. A wrong number that looks plausible is far worse than a
 * flagged blank.
 *
 * Accepted (case-insensitive, surrounding whitespace ignored):
 *
 *   [$] NUMBER [SUFFIX]
 *
 *   NUMBER  1200000 | 1,200,000 | 1,200,000.50 | 1.2 | .5
 *           Commas must be real thousands groups: "1,5" and "1,2345" are
 *           unreadable rather than guessed at (a European "1,5" is 1.5,
 *           an American one is a typo -- we can't tell, so we ask).
 *   SUFFIX  k | thousand            x 1,000
 *           m | mil | million       x 1,000,000
 *           b | billion             x 1,000,000,000
 *           Whitespace between the number and the suffix is allowed
 *           ("1.2 million", "$ 2,400,000").
 *
 * Rejected: negatives ("-250k", "$-5"), parentheses, other currencies,
 * exponents ("3e3"), ranges, trailing words ("$2M+", "1.5M est"), anything
 * over MAX_COST_AMOUNT, and anything longer than MAX_COST_INPUT_LENGTH.
 *
 * Whitespace is an explicit class (space, tab, CR/LF, FF, VT and the
 * non-breaking space Excel pastes) rather than JS `\s` / `.trim()`, because
 * those cover a dozen Unicode spaces Postgres' `[[:space:]]` does not, and
 * any difference between the two sides is a parity bug.
 */

/** $10 trillion. Nothing on a campus plan costs this; a value this big is a typo. */
export const MAX_COST_AMOUNT = 1e13

/** Longer than this is prose, not an amount. Mirrored in SQL. */
export const MAX_COST_INPUT_LENGTH = 100

export type CostParseError = 'unreadable' | 'negative' | 'too_large'

/**
 * Result of reading a cost string.
 *
 * - `ok: true, empty: true,  amount: null`   blank -- unanswered, not $0
 * - `ok: true, empty: false, amount: n`      a readable amount (0 is allowed)
 * - `ok: false, reason`                      flag it; never treat it as $0
 */
export type CostParseResult =
  | { ok: true; empty: boolean; amount: number | null }
  | { ok: false; empty: false; amount: null; reason: CostParseError }

const WS = '[ \\t\\n\\r\\f\\v\\u00a0]'

// Mirrored character-for-character in 0019's ship.parse_cost_input().
const COST_PATTERN = new RegExp(
  `^\\$?${WS}*` +
    `((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?|\\.[0-9]+)` +
    `${WS}*` +
    `(k|thousand|m|mil|million|b|billion)?$`,
  'i'
)

const NEGATIVE_PATTERN = new RegExp(`^(?:-${WS}*\\$?|\\$${WS}*-)${WS}*`)

const TRIM_PATTERN = new RegExp(`^${WS}+|${WS}+$`, 'g')

const SUFFIX_EXPONENT: Record<string, number> = {
  '': 0,
  k: 3,
  thousand: 3,
  m: 6,
  mil: 6,
  million: 6,
  b: 9,
  billion: 9,
}

function stripWhitespace(value: string) {
  return value.replace(TRIM_PATTERN, '')
}

/**
 * Read the non-negative part of a cost string, or null. The multiplier is
 * applied by shifting the decimal exponent of the literal ("1.15" + "e6")
 * rather than by multiplying binary floats -- `1.15 * 1e6` is
 * 1149999.9999999998, `Number("1.15e6")` is exactly 1150000, which is what
 * Postgres' exact numeric gets too.
 */
function readUnsignedCost(text: string): number | null {
  const match = COST_PATTERN.exec(text)
  if (!match) return null
  const digits = match[1].replace(/,/g, '')
  const exponent = SUFFIX_EXPONENT[(match[2] ?? '').toLowerCase()]
  const amount = Number(`${digits}e${exponent}`)
  return Number.isFinite(amount) ? amount : null
}

/** Strict cost parser. See the file comment for the grammar. */
export function parseCostAmount(value: string | null | undefined): CostParseResult {
  const text = stripWhitespace(value ?? '')
  if (!text) return { ok: true, empty: true, amount: null }
  if (text.length > MAX_COST_INPUT_LENGTH) {
    return { ok: false, empty: false, amount: null, reason: 'unreadable' }
  }

  const negative = NEGATIVE_PATTERN.exec(text)
  if (negative) {
    // Say "negative" only when the rest is otherwise a readable amount;
    // "-abc" is just unreadable.
    const rest = readUnsignedCost(text.slice(negative[0].length))
    return {
      ok: false,
      empty: false,
      amount: null,
      reason: rest === null ? 'unreadable' : 'negative',
    }
  }

  const amount = readUnsignedCost(text)
  if (amount === null) return { ok: false, empty: false, amount: null, reason: 'unreadable' }
  if (amount > MAX_COST_AMOUNT) {
    return { ok: false, empty: false, amount: null, reason: 'too_large' }
  }
  return { ok: true, empty: false, amount }
}

/** True when the text is non-blank but can't be read as a cost. */
export function isUnreadableCost(value: string | null | undefined) {
  return !parseCostAmount(value).ok
}

/**
 * Compatibility wrapper for callers that need a plain number to multiply:
 * blank AND unreadable both contribute 0. Anything that shows a total built
 * from this should also count `isUnreadableCost` and say so -- 0 here is a
 * placeholder, not an answer.
 */
export function parseCostInput(value: string) {
  return parseCostAmount(value).amount ?? 0
}

const PREVIEW_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

/** "$1,200,000" / "$1,200,000.5" -- every digit, for the live input preview. */
export function formatCostAmount(amount: number) {
  return PREVIEW_FORMAT.format(amount)
}

export const COST_PARSE_MESSAGES: Record<CostParseError, string> = {
  unreadable: "Can't read this amount. Use a number like 1,200,000, $1.2M or 850k.",
  negative: "Costs can't be negative.",
  too_large: 'That is more than $10 trillion. Check the amount.',
}

export type InputFeedback =
  | { kind: 'empty'; message: '' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

/**
 * What to show under a cost input as the user types:
 * `{ kind: 'ok', message: '= $1,200,000' }` for "1.2m",
 * `{ kind: 'error', message: "Can't read this amount..." }` for "TBD",
 * `{ kind: 'empty', message: '' }` for blank.
 */
export function costInputFeedback(value: string | null | undefined): InputFeedback {
  const result = parseCostAmount(value)
  if (!result.ok) return { kind: 'error', message: COST_PARSE_MESSAGES[result.reason] }
  if (result.amount === null) return { kind: 'empty', message: '' }
  return { kind: 'ok', message: `= ${formatCostAmount(result.amount)}` }
}

/** Just the preview line: "= $1,200,000", an error sentence, or ''. */
export function formatCostPreview(value: string | null | undefined) {
  return costInputFeedback(value).message
}

/* ------------------------------------------------------------- quantity -- */

export type QuantityParseError = 'unreadable' | 'negative'

/**
 * - `ok: true, empty: true,  quantity: null`  blank -- the column default,
 *                                              priced as one unit
 * - `ok: true, empty: false, quantity: n`     readable; 0 really is zero
 * - `ok: false, reason`                       don't save it; flag legacy rows
 */
export type QuantityParseResult =
  | { ok: true; empty: boolean; quantity: number | null }
  | { ok: false; empty: false; quantity: null; reason: QuantityParseError }

// Same number grammar as costs (real thousands groups only), then an
// optional trailing unit word: "12", "1,200", "1,200 sf", "3 ea", "2.5 units".
const QUANTITY_PATTERN = new RegExp(
  `^((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?|\\.[0-9]+)` +
    `(?:${WS}*[a-z][a-z.]*(?:${WS}+[a-z][a-z.]*)*)?$`,
  'i'
)

/** Strict quantity parser (M-10). */
export function parseQuantity(value: string | null | undefined): QuantityParseResult {
  const text = stripWhitespace(value ?? '')
  if (!text) return { ok: true, empty: true, quantity: null }
  if (text.length > MAX_COST_INPUT_LENGTH) {
    return { ok: false, empty: false, quantity: null, reason: 'unreadable' }
  }

  const negative = /^-/.test(text)
  const match = QUANTITY_PATTERN.exec(negative ? stripWhitespace(text.slice(1)) : text)
  if (!match) return { ok: false, empty: false, quantity: null, reason: 'unreadable' }
  if (negative) return { ok: false, empty: false, quantity: null, reason: 'negative' }

  const quantity = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(quantity)) {
    return { ok: false, empty: false, quantity: null, reason: 'unreadable' }
  }
  return { ok: true, empty: false, quantity }
}

/**
 * Compatibility wrapper for pricing. Blank is one unit (the column default
 * is '' and every existing link means "one of these"); 0 is zero; an
 * unreadable or negative quantity contributes 0 -- the same rule as an
 * unreadable cost -- and should be counted and shown, never guessed at.
 * (Before M-10, "0", "-2", "abc" and "1,200" all silently became 1.)
 */
export function parseQuantityInput(value: string) {
  const result = parseQuantity(value)
  if (!result.ok) return 0
  return result.quantity ?? 1
}

export const QUANTITY_PARSE_MESSAGES: Record<QuantityParseError, string> = {
  unreadable: 'Enter a number, like 12 or 1,200 (a unit after it is fine).',
  negative: "Quantity can't be negative.",
}

const QUANTITY_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })

/**
 * What to show next to a quantity input: `{ kind: 'ok', message: '= 1,200' }`,
 * an error sentence, or `{ kind: 'empty', message: '' }` (blank means 1).
 */
export function quantityInputFeedback(value: string | null | undefined): InputFeedback {
  const result = parseQuantity(value)
  if (!result.ok) return { kind: 'error', message: QUANTITY_PARSE_MESSAGES[result.reason] }
  if (result.quantity === null) return { kind: 'empty', message: '' }
  return { kind: 'ok', message: `= ${QUANTITY_FORMAT.format(result.quantity)}` }
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value)
}
