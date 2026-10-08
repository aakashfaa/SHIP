import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { energyEmptyHints } from '../../components/project-workspace/timeline/energy-empty-state.ts'

describe('energyEmptyHints', () => {
  test('no baseline and no savings gives both hints', () => {
    const kinds = energyEmptyHints({ baseline: null, finalSavings: 0 }).map((h) => h.kind)
    assert.deepEqual(kinds, ['baseline', 'savings'])
  })

  test('a zero baseline counts as unset', () => {
    assert.equal(energyEmptyHints({ baseline: 0, finalSavings: 5 })[0].kind, 'baseline')
  })

  test('baseline set but no savings gives only the savings hint', () => {
    const kinds = energyEmptyHints({ baseline: 1000, finalSavings: 0 }).map((h) => h.kind)
    assert.deepEqual(kinds, ['savings'])
  })

  test('savings but no baseline gives only the baseline hint', () => {
    const kinds = energyEmptyHints({ baseline: null, finalSavings: 50 }).map((h) => h.kind)
    assert.deepEqual(kinds, ['baseline'])
  })

  test('everything present gives no hints', () => {
    assert.deepEqual(energyEmptyHints({ baseline: 1000, finalSavings: 50 }), [])
  })
})
