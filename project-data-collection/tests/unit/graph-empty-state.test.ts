import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { graphEmptyHints } from '../../components/project-workspace/timeline/graph-empty-state.ts'

describe('graphEmptyHints', () => {
  test('no baseline and no values gives both hints', () => {
    const kinds = graphEmptyHints({ baseline: null, finalSavings: 0 }).map((h) => h.kind)
    assert.deepEqual(kinds, ['baseline', 'values'])
  })

  test('a zero baseline counts as unset', () => {
    assert.equal(graphEmptyHints({ baseline: 0, finalSavings: 5 })[0].kind, 'baseline')
  })

  test('baseline set but no values gives only the values hint', () => {
    const kinds = graphEmptyHints({ baseline: 1000, finalSavings: 0 }).map((h) => h.kind)
    assert.deepEqual(kinds, ['values'])
  })

  test('values but no baseline gives only the baseline hint', () => {
    const kinds = graphEmptyHints({ baseline: null, finalSavings: 50 }).map((h) => h.kind)
    assert.deepEqual(kinds, ['baseline'])
  })

  test('everything present gives no hints', () => {
    assert.deepEqual(graphEmptyHints({ baseline: 1000, finalSavings: 50 }), [])
  })

  test("the values hint names the graph's own column", () => {
    const [hint] = graphEmptyHints(
      { baseline: 10, finalSavings: 0 },
      { label: 'Annual carbon reduction (MTCO2e)', missing: false }
    )
    assert.equal(hint.linkText, 'Add Annual carbon reduction (MTCO2e) to your line items')
  })

  test('a graph whose column is gone asks for a column, not for values', () => {
    const kinds = graphEmptyHints({ baseline: 10, finalSavings: 0 }, { label: 'carbon', missing: true }).map(
      (h) => h.kind
    )
    assert.deepEqual(kinds, ['source'])
  })
})
