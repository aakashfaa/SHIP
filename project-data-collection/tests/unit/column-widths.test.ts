/** Master View personal column widths: clamping and tolerant parsing. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  clampColumnWidth,
  columnWidthsStorageKey,
  parseColumnWidths,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from '../../lib/column-widths.ts'

describe('clampColumnWidth', () => {
  test('keeps values inside the range and rounds', () => {
    assert.equal(clampColumnWidth(200.4), 200)
  })
  test('clamps to the min and max', () => {
    assert.equal(clampColumnWidth(5), MIN_COLUMN_WIDTH)
    assert.equal(clampColumnWidth(5000), MAX_COLUMN_WIDTH)
  })
  test('falls back to the min for NaN', () => {
    assert.equal(clampColumnWidth(Number.NaN), MIN_COLUMN_WIDTH)
  })
})

describe('parseColumnWidths', () => {
  test('empty, junk and non-object input give no widths', () => {
    assert.deepEqual(parseColumnWidths(null), {})
    assert.deepEqual(parseColumnWidths('not json'), {})
    assert.deepEqual(parseColumnWidths('[1,2]'), {})
    assert.deepEqual(parseColumnWidths('42'), {})
  })
  test('drops non-numeric entries and clamps the rest', () => {
    assert.deepEqual(parseColumnWidths('{"a":150,"b":"x","c":10,"d":9999}'), {
      a: 150,
      c: MIN_COLUMN_WIDTH,
      d: MAX_COLUMN_WIDTH,
    })
  })
})

test('storage key is per project', () => {
  assert.equal(columnWidthsStorageKey('p1'), 'ship.masterView.colWidths.p1')
})
