/**
 * Differential test: `ship.parse_cost_input()` (SQL, migration 0006) must agree
 * with `parseCostInput()` (TypeScript, lib/costs.ts) on every input.
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
import { parseCostInput } from '../lib/costs.ts'

const CONTAINER = 'supabase_db_project-data-collection'

/**
 * Cases are chosen for disagreement potential, not coverage percentage.
 * JS `Number.parseFloat` is lenient where Postgres `::numeric` throws, and
 * `.slice(-1)` on a suffix behaves oddly on single-character input — those are
 * the seams where an "exact port" stops being exact.
 */
const CASES = [
  // The ordinary path
  '$1.2m',
  '850k',
  '1,250',
  '12.5b',
  '  $ 2,400,000  ',
  '1.5K',
  '42',
  '$0.5m',
  '0',

  // Empty and blank
  '',
  '   ',

  // Non-numeric: both sides must yield 0, not throw and not NaN
  'abc',
  '$',
  'k',
  'm',
  '-',
  '.',

  // parseFloat leniency: JS takes the leading numeric prefix, Postgres would
  // throw on a bare cast. The SQL port extracts the prefix explicitly.
  '12abc',
  '3.5xyz',
  '1.2.3',

  // Exponent form — parseFloat accepts it
  '3e3',
  '1e-2',

  // Signs
  '-500',
  '-1.5m',
  '+250',

  // Suffix with nothing in front
  '.5m',
  '-k',

  // Case and whitespace mixing
  'M',
  ' 7 M ',
  '$1,000,000.00',
]

function sqlParse(values) {
  // One round trip for all cases. `format('%L', ...)` would be the tidy way to
  // quote these, but they are literals we control, so a straight escape of the
  // single quote is enough and keeps the query readable in an error message.
  const rows = values
    .map((v, i) => `(${i}, '${v.replace(/'/g, "''")}')`)
    .join(',')

  const sql = `
    select i, ship.parse_cost_input(v)::text
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
    const [i, value] = line.split('\t')
    parsed.set(Number(i), Number(value))
  }
  return values.map((_, i) => parsed.get(i))
}

const sqlResults = sqlParse(CASES)

let failures = 0
console.log('input'.padEnd(24) + 'typescript'.padEnd(18) + 'sql'.padEnd(18) + 'ok')
console.log('-'.repeat(64))

CASES.forEach((input, i) => {
  const ts = parseCostInput(input)
  const sql = sqlResults[i]

  // Both sides are money; compare at sub-cent tolerance rather than exactly,
  // since JS uses binary floating point and Postgres uses exact numeric.
  const agree = Number.isFinite(ts) && Number.isFinite(sql) && Math.abs(ts - sql) < 1e-6

  if (!agree) failures += 1
  console.log(
    JSON.stringify(input).padEnd(24) +
      String(ts).padEnd(18) +
      String(sql).padEnd(18) +
      (agree ? 'ok' : 'MISMATCH')
  )
})

console.log('-'.repeat(64))
if (failures > 0) {
  console.error(
    `\n${failures} of ${CASES.length} cases disagree.\n` +
      `lib/costs.ts and ship.parse_cost_input() must stay in lockstep — ` +
      `the UI reads one and the Excel export reads the other.`
  )
  process.exit(1)
}
console.log(`All ${CASES.length} cases agree.`)
