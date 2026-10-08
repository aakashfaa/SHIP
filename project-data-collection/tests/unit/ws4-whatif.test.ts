/**
 * WS-4: the what-if drag arithmetic (components/project-workspace/timeline/drag.ts).
 *
 * M-05 was a data bug: each drop inside a what-if rebuilt the overlay from the
 * baseline rows, so a second drag (or a plain click) erased the first. These
 * tests replay two drops in a row through the real helpers and check both
 * survive, plus the M-27 resize clamp.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  canStartDrag,
  changedPhasesForDrop,
  isNoOpDrop,
  mergeDropIntoOverlay,
  placementForDelta,
  summariseRebase,
  type DragOrigin,
} from '../../components/project-workspace/timeline/drag.ts'

type Row = {
  id: string
  chunkProjectId: string
  name: string
  kind: 'study' | 'design' | 'construction' | 'closeout'
  sortOrder: number
  pctOfTpc: number
  startMonth: number
  durationMonths: number
  durationLocked: boolean
}

const P = (id: string, startMonth: number, durationMonths = 1): Row => ({
  id,
  chunkProjectId: 'c',
  name: id,
  kind: 'construction',
  sortOrder: 0,
  pctOfTpc: 50,
  startMonth,
  durationMonths,
  durationLocked: false,
})

function effective(baseline: Row[], overlay: Map<string, Row>): Row[] {
  return baseline.map((p) => ({ ...p, ...(overlay.get(p.id) ?? {}) }))
}

function drop(baseline: Row[], overlay: Map<string, Row>, id: string, delta: number) {
  const eff = effective(baseline, overlay)
  const phase = eff.find((p) => p.id === id)!
  const origin: DragOrigin = {
    phaseId: id,
    mode: 'move',
    startMonth: phase.startMonth,
    durationMonths: phase.durationMonths,
  }
  const placement = placementForDelta(origin, delta, 10)
  if (isNoOpDrop(origin, placement)) return overlay
  const changed = changedPhasesForDrop(eff, id, placement)
  return mergeDropIntoOverlay(overlay, changed, (pid) => baseline.find((p) => p.id === pid))
}

describe('what-if drags (M-05)', () => {
  test('two drags of different bars both survive', () => {
    const baseline = [P('A', 0), P('B', 5)]
    // create_scenario snapshots every phase into the overlay.
    let overlay = new Map(baseline.map((p) => [p.id, { ...p }]))
    overlay = drop(baseline, overlay, 'A', 3)
    overlay = drop(baseline, overlay, 'B', 2)
    assert.equal(overlay.get('A')!.startMonth, 3)
    assert.equal(overlay.get('B')!.startMonth, 7)
  })

  test('a plain click (delta 0) changes nothing and is a no-op', () => {
    const baseline = [P('A', 0), P('B', 5)]
    let overlay = new Map(baseline.map((p) => [p.id, { ...p }]))
    overlay = drop(baseline, overlay, 'A', 3)
    const after = drop(baseline, overlay, 'B', 0)
    assert.equal(after, overlay, 'no new overlay is built for a no-op drop')
    assert.equal(after.get('A')!.startMonth, 3)
  })

  test('dragging the same bar twice measures from its what-if position', () => {
    const baseline = [P('A', 0)]
    let overlay = new Map(baseline.map((p) => [p.id, { ...p }]))
    overlay = drop(baseline, overlay, 'A', 2)
    overlay = drop(baseline, overlay, 'A', 2)
    assert.equal(overlay.get('A')!.startMonth, 4)
  })

  test('only changed ids are touched; other overlay entries are the same objects', () => {
    const baseline = [P('A', 0), P('B', 5)]
    const overlay = new Map(baseline.map((p) => [p.id, { ...p, startMonth: p.startMonth + 1 }]))
    const next = mergeDropIntoOverlay(overlay, [{ id: 'A', startMonth: 4, durationMonths: 1 }], () =>
      undefined
    )
    assert.notEqual(next, overlay)
    assert.equal(next.get('B'), overlay.get('B'))
    assert.equal(next.get('A')!.startMonth, 4)
  })

  test('propagation is applied when supplied and skipped when not', () => {
    const eff = [P('A', 0), P('B', 1)]
    const push = (rows: Row[]) =>
      new Map(rows.map((r) => [r.id, { startMonth: r.id === 'B' ? Math.max(r.startMonth, rows[0].startMonth + 1) : r.startMonth }]))
    const withPush = changedPhasesForDrop(eff, 'A', { startMonth: 3, durationMonths: 1 }, push)
    assert.deepEqual(withPush.map((r) => [r.id, r.startMonth]), [['A', 3], ['B', 4]])
    const without = changedPhasesForDrop(eff, 'A', { startMonth: 3, durationMonths: 1 })
    assert.deepEqual(without.map((r) => [r.id, r.startMonth]), [['A', 3]])
  })
})

describe('resize clamp (M-27)', () => {
  const origin = (mode: DragOrigin['mode'], startMonth: number, durationMonths: number) => ({
    phaseId: 'A',
    mode,
    startMonth,
    durationMonths,
  })

  test('resize-end never produces duration < 1', () => {
    for (const delta of [-50, -3, -1, 0, 1, 50]) {
      const p = placementForDelta(origin('resize-end', 9, 1), delta, 10)
      assert.ok(p.durationMonths >= 1, `delta ${delta} -> ${p.durationMonths}`)
    }
  })

  test('resize of a phase starting beyond the horizon is refused; move is allowed', () => {
    assert.equal(canStartDrag(origin('resize-end', 12, 2), 10), false)
    assert.equal(canStartDrag(origin('resize-start', 10, 2), 10), false)
    assert.equal(canStartDrag(origin('move', 12, 2), 10), true)
    // Moving it brings it back inside the timeline.
    assert.deepEqual(placementForDelta(origin('move', 12, 2), 0, 10), {
      startMonth: 8,
      durationMonths: 2,
    })
  })

  test('resize-start keeps start >= 0 and duration >= 1', () => {
    assert.deepEqual(placementForDelta(origin('resize-start', 2, 3), -9, 10), {
      startMonth: 0,
      durationMonths: 5,
    })
    assert.deepEqual(placementForDelta(origin('resize-start', 2, 3), 9, 10), {
      startMonth: 4,
      durationMonths: 1,
    })
  })
})

describe('rebase summary (M-07 UI)', () => {
  test('reports kept moves and pulled-in live changes', () => {
    const before = [P('A', 3), P('B', 5)] // user moved A (live had 0); B untouched
    const live = [P('A', 0), P('B', 6)] // colleague moved B
    const after = [P('A', 3), P('B', 6)] // 3-way merge result
    const s = summariseRebase(before, after, live)
    assert.deepEqual(s.kept, ['A'])
    assert.deepEqual(s.pulledIn, ['B'])
  })
})
