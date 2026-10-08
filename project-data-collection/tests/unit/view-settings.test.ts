/**
 * Per-project display settings (lib/view-settings.ts, migration 0021).
 *
 * The stored jsonb is written by one client version and read by every later
 * one, and by consultants/viewers whose screens must never break because an
 * admin's save was partial or old. normalizeViewSettings is the only thing
 * standing between that jsonb and the UI, so it must turn ANY input into a
 * complete, valid ProjectViewSettings.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_VIEW_SETTINGS,
  normalizeViewSettings,
  visibleColumns,
  type ViewColumn,
} from '../../lib/view-settings.ts'

describe('normalizeViewSettings', () => {
  test('null, undefined, primitives and arrays all become the defaults', () => {
    for (const raw of [null, undefined, 0, 1, '', 'x', true, [], [1, 2], {}]) {
      assert.deepEqual(normalizeViewSettings(raw), DEFAULT_VIEW_SETTINGS, `input ${JSON.stringify(raw)}`)
    }
  })

  test('a complete valid value round-trips unchanged', () => {
    const value = {
      masterView: { hiddenColumns: ['cost', 'notes'] },
      chunking: { hiddenColumns: ['energy'] },
      timeline: { costBreakdown: 'quarter' as const, showEnergy: false, showPackages: false },
    }
    assert.deepEqual(normalizeViewSettings(value), value)
    assert.deepEqual(normalizeViewSettings(JSON.parse(JSON.stringify(value))), value)
  })

  test('every costBreakdown option is accepted; anything else falls back to fiscal-year', () => {
    for (const ok of ['fiscal-year', 'quarter', 'none'] as const) {
      assert.equal(normalizeViewSettings({ timeline: { costBreakdown: ok } }).timeline.costBreakdown, ok)
    }
    for (const bad of ['year', 'Quarter', '', null, 3, {}]) {
      assert.equal(normalizeViewSettings({ timeline: { costBreakdown: bad } }).timeline.costBreakdown, 'fiscal-year')
    }
  })

  test('booleans must be real booleans; anything else is the default (true)', () => {
    const n = normalizeViewSettings({ timeline: { showEnergy: 'false', showPackages: 0 } })
    assert.equal(n.timeline.showEnergy, true)
    assert.equal(n.timeline.showPackages, true)
    const off = normalizeViewSettings({ timeline: { showEnergy: false, showPackages: false } })
    assert.equal(off.timeline.showEnergy, false)
    assert.equal(off.timeline.showPackages, false)
  })

  test('hidden column lists keep only strings, and a non-array is empty', () => {
    const n = normalizeViewSettings({
      masterView: { hiddenColumns: ['a', 1, null, 'b', { k: 'c' }] },
      chunking: { hiddenColumns: 'a' },
    })
    assert.deepEqual(n.masterView.hiddenColumns, ['a', 'b'])
    assert.deepEqual(n.chunking.hiddenColumns, [])
  })

  test('a partial value fills only what is missing', () => {
    const n = normalizeViewSettings({ chunking: { hiddenColumns: ['x'] } })
    assert.deepEqual(n.chunking.hiddenColumns, ['x'])
    assert.deepEqual(n.masterView, DEFAULT_VIEW_SETTINGS.masterView)
    assert.deepEqual(n.timeline, DEFAULT_VIEW_SETTINGS.timeline)
  })

  test('malformed sections (timeline as string, masterView as array) do not throw', () => {
    const n = normalizeViewSettings({ timeline: 'quarter', masterView: ['a'], chunking: null })
    assert.deepEqual(n, DEFAULT_VIEW_SETTINGS)
  })

  test('unknown keys are dropped', () => {
    const n = normalizeViewSettings({ extra: 1, timeline: { costBreakdown: 'none', junk: true } }) as Record<string, unknown>
    assert.equal('extra' in n, false)
    assert.equal('junk' in (n.timeline as object), false)
  })

  test('the result does not share arrays with the input', () => {
    const input = { masterView: { hiddenColumns: ['a'] } }
    const n = normalizeViewSettings(input)
    n.masterView.hiddenColumns.push('b')
    assert.deepEqual(input.masterView.hiddenColumns, ['a'])
  })
})

describe('visibleColumns', () => {
  const columns: ViewColumn[] = [
    { key: 'number', label: '#', locked: true },
    { key: 'name', label: 'Name', locked: true },
    { key: 'cost', label: 'Cost' },
    { key: 'energy', label: 'Energy' },
    { key: 'notes', label: 'Notes' },
  ]

  test('nothing hidden shows every column in catalog order', () => {
    assert.deepEqual(visibleColumns(columns, []).map((c) => c.key), ['number', 'name', 'cost', 'energy', 'notes'])
  })

  test('hidden columns are removed, order is preserved', () => {
    assert.deepEqual(visibleColumns(columns, ['energy']).map((c) => c.key), ['number', 'name', 'cost', 'notes'])
    assert.deepEqual(visibleColumns(columns, ['notes', 'cost']).map((c) => c.key), ['number', 'name', 'energy'])
  })

  test('locked columns survive even when listed as hidden', () => {
    assert.deepEqual(visibleColumns(columns, ['number', 'name', 'cost', 'energy', 'notes']).map((c) => c.key), ['number', 'name'])
  })

  test('hidden keys that are not in the catalog (removed questions) are ignored', () => {
    assert.deepEqual(visibleColumns(columns, ['gone', 'also-gone']).map((c) => c.key), ['number', 'name', 'cost', 'energy', 'notes'])
  })

  test('a column added to the catalog later is visible by default', () => {
    const later = [...columns, { key: 'new-question', label: 'New' }]
    assert.ok(visibleColumns(later, ['cost']).some((c) => c.key === 'new-question'))
  })
})
