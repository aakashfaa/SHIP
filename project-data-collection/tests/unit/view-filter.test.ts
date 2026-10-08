/**
 * Personal view filters on top of the project default
 * (lib/view-filter-layers.ts): non-admins can only hide more, admins can see
 * past the default, and later admin changes still reach everyone.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyColumnsLayer,
  applyTimelineLayer,
  columnsLayerFor,
  isEmptyLayer,
  parseColumnsLayer,
  parseTimelineLayer,
  timelineLayerFor,
} from '../../lib/view-filter-layers.ts'

const sorted = (xs: string[]) => [...xs].sort()

describe('column layers', () => {
  const base = { hiddenColumns: ['secret'] }

  test('non-admin: can hide more, cannot show an admin-hidden column', () => {
    const layer = columnsLayerFor(base, { hiddenColumns: ['notes'] }, false)
    assert.deepEqual(layer, { hide: ['notes'], show: [] })
    assert.deepEqual(sorted(applyColumnsLayer(base, layer, false).hiddenColumns), ['notes', 'secret'])
    // Even a forged "show" in storage is ignored for a non-admin.
    assert.deepEqual(
      sorted(applyColumnsLayer(base, { hide: [], show: ['secret'] }, false).hiddenColumns),
      ['secret']
    )
  })

  test('admin: can show what the default hides', () => {
    const layer = columnsLayerFor(base, { hiddenColumns: [] }, true)
    assert.deepEqual(layer, { hide: [], show: ['secret'] })
    assert.deepEqual(applyColumnsLayer(base, layer, true).hiddenColumns, [])
  })

  test('later admin changes still reach someone with a personal layer', () => {
    const layer = columnsLayerFor(base, { hiddenColumns: ['secret', 'notes'] }, false)
    const newDefault = { hiddenColumns: ['cost'] }
    assert.deepEqual(sorted(applyColumnsLayer(newDefault, layer, false).hiddenColumns), ['cost', 'notes'])
  })

  test('matching the default stores nothing; junk parses to empty', () => {
    assert.ok(isEmptyLayer(columnsLayerFor(base, base, false)))
    assert.ok(isEmptyLayer(parseColumnsLayer({ hiddenColumns: ['x'] })))
    assert.ok(isEmptyLayer(parseColumnsLayer('nope')))
  })
})

describe('timeline layers', () => {
  const base = { costBreakdown: 'fiscal-year' as const, showEnergy: true, showPackages: false }

  test('non-admin: can turn off, cannot turn on what the admin turned off', () => {
    const layer = timelineLayerFor(base, { costBreakdown: 'quarter', showEnergy: false, showPackages: true }, false)
    assert.deepEqual(layer, { costBreakdown: 'quarter', showEnergy: false })
    assert.deepEqual(applyTimelineLayer(base, layer, false), {
      costBreakdown: 'quarter',
      showEnergy: false,
      showPackages: false,
    })
    assert.equal(applyTimelineLayer(base, { showPackages: true }, false).showPackages, false)
  })

  test("non-admin: an admin 'none' cost row stays off", () => {
    const off = { ...base, costBreakdown: 'none' as const }
    assert.deepEqual(timelineLayerFor(off, { ...off, costBreakdown: 'quarter' }, false), {})
    assert.equal(applyTimelineLayer(off, { costBreakdown: 'quarter' }, false).costBreakdown, 'none')
  })

  test('admin: any override applies', () => {
    const layer = timelineLayerFor(base, { costBreakdown: 'none', showEnergy: true, showPackages: true }, true)
    assert.deepEqual(applyTimelineLayer(base, layer, true), {
      costBreakdown: 'none',
      showEnergy: true,
      showPackages: true,
    })
  })

  test('parse keeps only valid keys', () => {
    assert.deepEqual(parseTimelineLayer({ costBreakdown: 'weekly', showEnergy: false, x: 1 }), { showEnergy: false })
  })
})
