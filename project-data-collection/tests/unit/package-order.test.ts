/**
 * Package order and number rules (lib/package-order.ts, migration 0030):
 * packages sort by the user-owned sort_order, numbers are free text that
 * must be non-blank and unique within the project, and keyboard moves are
 * clamped single-step reorders.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PACKAGE_NUMBER_MAX_LENGTH,
  comparePackages,
  moveItem,
  packagePositions,
  sameOrder,
  sortPackages,
  validatePackageNumber,
} from '../../lib/package-order.ts'

const pkg = (id: string, sortOrder: number, createdAt = '2026-01-01T00:00:00Z', chunkNumber = id) => ({
  id,
  sortOrder,
  createdAt,
  chunkNumber,
})

describe('sortPackages', () => {
  test('orders by sort_order, independent of the number', () => {
    const list = [pkg('a', 2, undefined, 'PP10'), pkg('b', 0, undefined, 'PP14'), pkg('c', 1, undefined, 'A-2')]
    assert.deepEqual(sortPackages(list).map((p) => p.chunkNumber), ['PP14', 'A-2', 'PP10'])
  })

  test('ties fall back to created_at, then id', () => {
    const list = [
      pkg('z', 0, '2026-01-02T00:00:00Z'),
      pkg('y', 0, '2026-01-01T00:00:00Z'),
      pkg('x', 0, '2026-01-02T00:00:00Z'),
    ]
    assert.deepEqual(sortPackages(list).map((p) => p.id), ['y', 'x', 'z'])
  })

  test('does not mutate its input', () => {
    const list = [pkg('a', 1), pkg('b', 0)]
    sortPackages(list)
    assert.deepEqual(list.map((p) => p.id), ['a', 'b'])
  })

  test('comparePackages is 0 only for the same package', () => {
    assert.equal(comparePackages(pkg('a', 0), pkg('a', 0)), 0)
    assert.ok(comparePackages(pkg('a', 0), pkg('b', 0)) < 0)
  })

  test('packagePositions maps ids to display index', () => {
    const positions = packagePositions([pkg('a', 5), pkg('b', 1), pkg('c', 3)])
    assert.deepEqual([...positions.entries()], [['b', 0], ['c', 1], ['a', 2]])
  })
})

describe('moveItem', () => {
  test('moves up and down by one', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'c', 'b'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c'])
  })

  test('moves across the list', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 3), ['b', 'c', 'd', 'a'])
  })

  test('clamps at the ends and returns the same array when nothing moves', () => {
    const list = ['a', 'b']
    assert.equal(moveItem(list, 0, -1), list)
    assert.equal(moveItem(list, 1, 5), list)
    assert.equal(moveItem([], 0, 1).length, 0)
  })

  test('sameOrder', () => {
    assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true)
    assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false)
    assert.equal(sameOrder(['a'], ['a', 'b']), false)
  })
})

describe('validatePackageNumber', () => {
  const others = [
    { id: '1', chunkNumber: 'PP10' },
    { id: '2', chunkNumber: 'PP11' },
    { id: '3', chunkNumber: 'A-2' },
  ]

  test('any non-blank, unique text is fine, trimmed', () => {
    assert.equal(validatePackageNumber('PP3', others, '1'), null)
    assert.equal(validatePackageNumber('  12 ', others, '1'), null)
    assert.equal(validatePackageNumber('B-7', others, null), null)
  })

  test('keeping its own number is fine', () => {
    assert.equal(validatePackageNumber('PP10', others, '1'), null)
    assert.equal(validatePackageNumber(' PP10 ', others, '1'), null)
  })

  test('blank is refused', () => {
    assert.match(validatePackageNumber('   ', others, '1') ?? '', /Enter a package number/)
  })

  test('a number used by another package is refused, after trimming', () => {
    assert.match(validatePackageNumber('PP11', others, '1') ?? '', /already used/)
    assert.match(validatePackageNumber(' A-2', others, '1') ?? '', /already used/)
  })

  test('exact match like the database constraint: case differs is allowed', () => {
    assert.equal(validatePackageNumber('pp11', others, '1'), null)
  })

  test('too long is refused', () => {
    assert.equal(validatePackageNumber('x'.repeat(PACKAGE_NUMBER_MAX_LENGTH), others, '1'), null)
    assert.match(
      validatePackageNumber('x'.repeat(PACKAGE_NUMBER_MAX_LENGTH + 1), others, '1') ?? '',
      /at most/
    )
  })
})
