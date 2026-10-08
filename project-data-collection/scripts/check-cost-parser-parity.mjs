/**
 * Differential test: `ship.parse_cost_input()` (SQL, migration 0019) must agree
 * with `parseCostAmount()` (TypeScript, lib/costs.ts) on every input --
 * including on WHICH inputs are unreadable: both sides return NULL for blank,
 * unreadable, negative and over-cap input (D-16), and NULL must line up with
 * NULL. A case where one side reads a number and the other refuses is exactly
 * as bad as two different numbers.
 *
 * The migration claims to be "an exact port". That claim silently rots the
 * first time someone edits one side — and the failure mode is quiet and
 * expensive: the UI shows one package total while the Excel export the client
 * hands to a state agency shows another, because one reads the text column
 * through the TS parser and the other sums the numeric column the SQL parser
 * filled in. This script is what stops that.
 *
 * Run against the local stack:
 *   npm run check:parser
 *
 * Add a case here whenever either parser grows a rule.
 */

import { execFileSync } from 'node:child_process'
import { parseCostAmount } from '../lib/costs.ts'

const CONTAINER = 'supabase_db_project-data-collection'

/**
 * Cases are chosen for disagreement potential, not coverage percentage --
 * the seams where an "exact port" stops being exact: regex dialects
 * (JS vs Postgres ARE), whitespace classes, case folding, float vs exact
 * numeric, and every input the M-09 audit caught being silently misread.
 * Each case's comment says what BOTH sides must return.
 */
const CASES = [
  // The ordinary path -> the amount
  '$1.2m',
  '850k',
  '1,250',
  '12.5b',
  '  $ 2,400,000  ',
  '1.5K',
  '42',
  '$0.5m',
  '0',
  '$0',
  '$1,000,000.00',
  '1,200,000.50',
  '1200000',
  '.5m',
  ' 7 M ',
  'M',

  // Shorthand words and spacing (D-16) -> the amount
  '1.2 million',
  '100 million',
  '5 mil',
  '2 thousand',
  '1.5 billion',
  '1 b',
  '$3MIL',
  '$ 1.25 Million',
  '1.15m', // float trap: 1.15 * 1e6 is 1149999.9999999998 in JS
  '0.1k',
  '1.005k',

  // Whitespace classes: tab/newline and the NBSP Excel pastes -> amount
  '\t5 mil\n',
  '\u00a01k\u00a0',

  // Cap: exactly $10T is allowed, anything above is NULL
  '10000b',
  '10,000,000,000,000',
  '10001b',
  '10,000,000,000,001',
  '99999999999999999999999',

  // Empty and blank -> NULL (unanswered)
  '',
  '   ',

  // Non-numeric -> NULL (unreadable, not $0)
  'abc',
  '$',
  'k',
  'm',
  '-',
  '.',
  'TBD',
  'n/a',
  '~1m',
  'approx 1m',
  '\u20ac1000',
  '\u00a32k',
  '1/2m',
  '(1,000)',

  // Trailing words used to kill the multiplier ("$1.2M (incl...)" -> $1.20)
  '$1.2M (incl. contingency)',
  '$2M+',
  '1.5M est',
  '$1.5 M USD',
  '12abc',
  '3.5xyz',
  '1.2.3',
  '1.000.000',
  '1,5',
  '1,2345',
  '12,34,567',
  '1,000.',
  '5.',

  // Exponents: no longer part of the grammar (1e309 used to be stored as
  // a 309-digit ecc_amount on the SQL side and 0 on the TS side)
  '3e3',
  '1e-2',
  '5.e3',
  '1e309',
  '1e400',

  // Signs -> NULL (negatives rejected, '+' is not in the grammar)
  '-500',
  '-1.5m',
  '-250k',
  '$-5',
  '- $5',
  '+250',
  '-k',

  // Over-long input -> NULL
  '1'.repeat(101),
]

function toEscapeString(value) {
  return Array.from(value)
    .map((ch) => {
      if (ch === "'") return "''"
      if (ch === '\\') return '\\\\'
      const code = ch.codePointAt(0)
      if (code < 0x20 || code > 0x7e) return '\\u' + code.toString(16).padStart(4, '0')
      return ch
    })
    .join('')
}

function sqlParse(values) {
  // One round trip for all cases. E'' strings with \uXXXX escapes so the
  // tab / newline / NBSP / currency-symbol cases reach Postgres as the real
  // characters, whatever the console code page on the way through docker.
  const rows = values
    .map((v, i) => `(${i}, E'${toEscapeString(v)}')`)
    .join(',')

  const sql = `
    select i, coalesce(ship.parse_cost_input(v)::text, 'NULL')
      from (values ${rows}) as t(i, v)
     order by i;
  `

  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-F', '\t', '-c', sql],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
  )

  const parsed = new Map()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [i, value] = line.replace(/\r$/, '').split('\t')
    parsed.set(Number(i), value === 'NULL' ? null : Number(value))
  }
  return values.map((_, i) => parsed.get(i))
}

const sqlResults = sqlParse(CASES)

let failures = 0
console.log('input'.padEnd(24) + 'typescript'.padEnd(18) + 'sql'.padEnd(18) + 'ok')
console.log('-'.repeat(64))

CASES.forEach((input, i) => {
  const ts = parseCostAmount(input).amount
  const sql = sqlResults[i]

  // Both sides are money; compare at sub-cent tolerance rather than exactly,
  // since JS uses binary floating point and Postgres uses exact numeric.
  // NULL (blank / unreadable) must line up with NULL; `undefined` means the
  // SQL row never came back, which is a failure too.
  const agree =
    ts === null || sql === null || sql === undefined
      ? ts === null && sql === null
      : Number.isFinite(ts) && Number.isFinite(sql) && Math.abs(ts - sql) < 1e-6

  if (!agree) failures += 1
  const label = JSON.stringify(input.length > 22 ? input.slice(0, 19) + '...' : input)
  console.log(
    label.padEnd(24) + String(ts).padEnd(18) + String(sql).padEnd(18) + (agree ? 'ok' : 'MISMATCH')
  )
})

console.log('-'.repeat(64))
if (failures > 0) {
  console.error(
    `\n${failures} of ${CASES.length} cases disagree.\n` +
      `lib/costs.ts parseCostAmount() and ship.parse_cost_input() must stay in ` +
      `lockstep — the UI reads one and the Excel export reads the other.`
  )
  process.exit(1)
}
console.log(`All ${CASES.length} cases agree.`)
