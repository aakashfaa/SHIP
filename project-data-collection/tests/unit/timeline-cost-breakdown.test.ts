/**
 * The Timeline's by-quarter cost strip
 * (components/project-workspace/timeline/cost-breakdown.ts).
 *
 * The quarter view must be a re-layout of the fiscal-year totals, never a
 * second sum: same quarters, same order, same dollars.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { flattenFiscalQuarters } from '../../components/project-workspace/timeline/cost-breakdown.ts'

type Year = Parameters<typeof flattenFiscalQuarters>[0][number]

function year(fiscalYear: number, escalated: [number, number, number, number]): Year {
  const quarters = escalated.map((value, i) => ({
    quarter: i + 1,
    baseTotal: value / 2,
    escalatedTotal: value,
  }))
  return {
    fiscalYear,
    baseTotal: quarters.reduce((s, q) => s + q.baseTotal, 0),
    escalatedTotal: quarters.reduce((s, q) => s + q.escalatedTotal, 0),
    quarters,
  }
}

describe('flattenFiscalQuarters', () => {
  test('lays every quarter out in fiscal order', () => {
    const cells = flattenFiscalQuarters([year(2027, [1, 2, 3, 4]), year(2028, [5, 0, 0, 8])])
    assert.deepEqual(
      cells.map((c) => [c.fiscalYear, c.quarter, c.escalatedTotal, c.baseTotal]),
      [
        [2027, 1, 1, 0.5],
        [2027, 2, 2, 1],
        [2027, 3, 3, 1.5],
        [2027, 4, 4, 2],
        [2028, 1, 5, 2.5],
        [2028, 2, 0, 0],
        [2028, 3, 0, 0],
        [2028, 4, 8, 4],
      ]
    )
  })

  test('sums to exactly the fiscal-year totals', () => {
    const years = [year(2030, [125000.5, 0, 98000.25, 1]), year(2031, [0, 0, 0, 77])]
    const cells = flattenFiscalQuarters(years)
    for (const y of years) {
      const sum = cells
        .filter((c) => c.fiscalYear === y.fiscalYear)
        .reduce((s, c) => s + c.escalatedTotal, 0)
      assert.equal(sum, y.escalatedTotal)
    }
  })

  test('no years, no quarters', () => {
    assert.deepEqual(flattenFiscalQuarters([]), [])
  })
})
