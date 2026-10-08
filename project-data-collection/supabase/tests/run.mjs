/**
 * Runs the SQL regression tests in supabase/tests/ against the LOCAL stack.
 *
 *   node supabase/tests/run.mjs                 # every NNNN_*.sql file
 *   node supabase/tests/run.mjs 0013 0015       # only files starting with these
 *
 * Each test file is piped, after _helpers.sql, into psql inside the local
 * Postgres container. Every test file is a single transaction that ends in
 * ROLLBACK, so the run leaves no rows behind. A failed assertion raises,
 * psql stops (ON_ERROR_STOP), and this script exits non-zero.
 *
 * Needs the seeded auth users (`npm run db:users`) because the tests sign in
 * as them.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const container = process.env.SHIP_DB_CONTAINER ?? 'supabase_db_project-data-collection'
const filters = process.argv.slice(2)

const helpers = readFileSync(join(here, '_helpers.sql'), 'utf8')
const files = readdirSync(here)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .filter((f) => filters.length === 0 || filters.some((p) => f.startsWith(p)))
  .sort()

/**
 * `-- @include <path relative to the repo root>` on a line of its own is
 * replaced by that file. It exists for one-off DATA migrations (0020): the
 * only honest test of a conversion is to stage the "before" data inside the
 * test's transaction, run the migration's real text over it -- twice, to
 * prove the run-once guard -- and roll everything back.
 */
const repoRoot = join(here, '..', '..')
function expandIncludes(sql) {
  return sql.replace(/^--\s*@include\s+(\S+)\s*$/gm, (_, path) =>
    readFileSync(join(repoRoot, path), 'utf8')
  )
}

let failed = 0
for (const file of files) {
  const sql = helpers + '\n' + expandIncludes(readFileSync(join(here, file), 'utf8'))
  process.stdout.write(`\n=== ${file}\n`)
  const res = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' }
  )
  // PASS lines are NOTICEs, which psql writes to stderr.
  process.stdout.write(String(res.stdout ?? ''))
  process.stdout.write(String(res.stderr ?? ''))
  if (res.status !== 0) failed++
}

if (failed) {
  console.error(`\n${failed} test file(s) FAILED`)
  process.exit(1)
}
console.log(`\nAll ${files.length} test file(s) passed`)
