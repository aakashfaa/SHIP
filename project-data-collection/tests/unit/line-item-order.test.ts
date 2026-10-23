/**
 * Drag-to-reorder in Add Data (migration 0029): the pure helpers in
 * lib/line-item-order.ts. The real renumbering is SQL and is covered by
 * supabase/tests/0029_line_item_order.sql.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { moveId, previewItemNumbers, sameOrder } from '../../lib/line-item-order.ts'

describe('moveId', () => {
  const ids = ['a', 'b', 'c', 'd']

  test('moves one place up and down', () => {
    assert.deepEqual(moveId(ids, 'c', -1), ['a', 'c', 'b', 'd'])
    assert.deepEqual(moveId(ids, 'b', 1), ['a', 'c', 'b', 'd'])
  })

  test('returns null at the ends and for unknown ids', () => {
    assert.equal(moveId(ids, 'a', -1), null)
    assert.equal(moveId(ids, 'd', 1), null)
    assert.equal(moveId(ids, 'zz', 1), null)
  })

  test('does not mutate its input', () => {
    moveId(ids, 'a', 1)
    assert.deepEqual(ids, ['a', 'b', 'c', 'd'])
  })
})

describe('sameOrder', () => {
  test('compares element by element', () => {
    assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true)
    assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false)
    assert.equal(sameOrder(['a'], ['a', 'b']), false)
  })
})

describe('previewItemNumbers', () => {
  test("Megan's case: moving A4 below A7 shifts A5..A7 up", () => {
    // New visual order after dragging the old A4 to the bottom.
    const items = [
      { id: 'a5', itemNumber: 'A5' },
      { id: 'a6', itemNumber: 'A6' },
      { id: 'a7', itemNumber: 'A7' },
      { id: 'a4', itemNumber: 'A4' },
    ]
    const preview = previewItemNumbers(items)
    assert.deepEqual(
      items.map((i) => preview.get(i.id)),
      ['A4', 'A5', 'A6', 'A7']
    )
  })

  test('each prefix is numbered on its own, custom prefixes included', () => {
    const items = [
      { id: 'm2', itemNumber: 'M2' },
      { id: 'a1', itemNumber: 'A1' },
      { id: 'av3', itemNumber: 'AV3' },
      { id: 'm1', itemNumber: 'M1' },
      { id: 'av1', itemNumber: 'AV1' },
    ]
    const preview = previewItemNumbers(items)
    assert.equal(preview.get('m2'), 'M1')
    assert.equal(preview.get('m1'), 'M2')
    assert.equal(preview.get('a1'), 'A1')
    assert.equal(preview.get('av3'), 'AV1')
    assert.equal(preview.get('av1'), 'AV3')
  })

  test('compares numbers numerically, not as text (A10 after A9)', () => {
    const items = [
      { id: 'x', itemNumber: 'A10' },
      { id: 'y', itemNumber: 'A9' },
    ]
    const preview = previewItemNumbers(items)
    assert.equal(preview.get('x'), 'A9')
    assert.equal(preview.get('y'), 'A10')
  })

  test('an unparseable number is left as it is', () => {
    const preview = previewItemNumbers([{ id: 'q', itemNumber: '' }])
    assert.equal(preview.get('q'), '')
  })
})
