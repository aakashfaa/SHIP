/**
 * WS-4: Versions (migration 0031) -- the overlay that turns the live rows plus
 * a version's payload into the schedule and cost model that version prices
 * (lib/versions.ts), and the drag arithmetic that writes a drop into a
 * version (components/project-workspace/timeline/drag.ts).
 *
 * M-05 was a data bug: each drop inside a what-if rebuilt the overlay from the
 * baseline rows, so a second drag (or a plain click) erased the first. These
 * tests replay drops in a row through the real helpers and check both
 * survive, plus the M-27 resize clamp.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  canStartDrag,
  changedPhasesForDrop,
  isNoOpDrop,
  placementForDelta,
  type DragOrigin,
} from '../../components/project-workspace/timeline/drag.ts'
import {
  LIVE_VERSION_KEY,
  applyVersionOverlay,
  listVersions,
  nextVersionName,
  packagePhasesForSave,
  replacePackagePhases,
} from '../../lib/versions.ts'
import {
  DEFAULT_COST_SETTINGS,
  computePhaseCost,
  type CostSettings,
} from '../../lib/cost-model.ts'
import type {
  ChunkPhase,
  PhaseDependency,
  ProjectCostSettings,
  Scenario,
  ScenarioPayload,
} from '../../lib/types.ts'

const P = (id: string, startMonth: number, durationMonths = 1, chunk = 'c'): ChunkPhase => ({
  id,
  chunkProjectId: chunk,
  templateStepId: null,
  name: id,
  kind: 'construction',
  sortOrder: 0,
  pctOfTpc: 50,
  startMonth,
  durationMonths,
  durationLocked: false,
  createdAt: '',
})

const strip = ({ createdAt: _c, ...rest }: ChunkPhase) => rest // eslint-disable-line @typescript-eslint/no-unused-vars

const LIVE_COST: ProjectCostSettings = {
  projectId: 'proj',
  tpcFactor: 1.33,
  baseYear: 2026,
  escalationMode: 'compound_annual',
  escalationAnnualPercent: 4,
  escalationStepYears: 5,
  escalationBasis: 'midpoint',
  escalationConfidenceYears: 5,
  defaultPhaseTemplateId: null,
  rateOverrides: [],
}

const dep = (id: string, a: string, b: string): PhaseDependency => ({
  id,
  projectId: 'proj',
  predecessorPhaseId: a,
  successorPhaseId: b,
  depType: 'FS',
  lagMonths: 0,
})

function payload(phases: ChunkPhase[], extra: Partial<ScenarioPayload> = {}): ScenarioPayload {
  return { phases: phases.map(strip), dependencies: [], costSettings: null, ...extra }
}

/** One drop on the version on screen: returns the version's next payload. */
function drop(
  live: ChunkPhase[],
  current: ScenarioPayload,
  packages: string[],
  id: string,
  delta: number
): ScenarioPayload {
  const eff = applyVersionOverlay(
    { phases: live, dependencies: [], costSettings: LIVE_COST },
    current,
    packages
  ).phases
  const phase = eff.find((p) => p.id === id)!
  const origin: DragOrigin = {
    phaseId: id,
    mode: 'move',
    startMonth: phase.startMonth,
    durationMonths: phase.durationMonths,
  }
  const placement = placementForDelta(origin, delta, 1000)
  if (isNoOpDrop(origin, placement)) return current
  const changed = changedPhasesForDrop(eff, id, placement)
  return replacePackagePhases(current, packagePhasesForSave(eff, changed))
}

describe('applyVersionOverlay: phases, per package', () => {
  test('null payload = the version in the tables, unchanged', () => {
    const live = [P('A', 0), P('B', 5)]
    const view = applyVersionOverlay({ phases: live, dependencies: [], costSettings: LIVE_COST }, null, ['c'])
    assert.deepEqual(view.phases, live)
    assert.equal(view.costSettings, LIVE_COST)
  })

  test("a version's phases replace the whole package, even with different ids", () => {
    const live = [P('A', 0, 1, 'c1'), P('B', 5, 1, 'c1'), P('X', 2, 1, 'c2')]
    // c1 re-phased in this version (a template change): one new phase.
    const view = applyVersionOverlay(
      { phases: live, dependencies: [], costSettings: LIVE_COST },
      payload([{ ...P('N', 7, 24, 'c1') }, P('X', 9, 1, 'c2')]),
      ['c1', 'c2']
    )
    assert.deepEqual(
      view.phases.map((p) => [p.id, p.chunkProjectId, p.startMonth]).sort(),
      [
        ['N', 'c1', 7],
        ['X', 'c2', 9],
      ]
    )
  })

  test('a package created after the version falls back to its live phases', () => {
    const live = [P('A', 0, 1, 'old'), P('NEW', 30, 6, 'new')]
    const view = applyVersionOverlay(
      { phases: live, dependencies: [], costSettings: LIVE_COST },
      payload([P('A', 12, 1, 'old')]),
      ['old', 'new']
    )
    assert.deepEqual(
      view.phases.map((p) => [p.id, p.startMonth]).sort(),
      [
        ['A', 12],
        ['NEW', 30],
      ]
    )
  })

  test("phases of a deleted package in a version's payload are ignored", () => {
    const live = [P('A', 0, 1, 'kept')]
    const view = applyVersionOverlay(
      { phases: live, dependencies: [], costSettings: LIVE_COST },
      payload([P('A', 4, 1, 'kept'), P('GONE', 4, 1, 'deleted')]),
      ['kept']
    )
    assert.deepEqual(view.phases.map((p) => p.id), ['A'])
  })

  test("dependencies: the version's own, plus live links between fallback phases", () => {
    const live = [P('A', 0, 1, 'c1'), P('B', 1, 1, 'c1'), P('Y', 0, 1, 'c2'), P('Z', 1, 1, 'c2')]
    const view = applyVersionOverlay(
      { phases: live, dependencies: [dep('live-ab', 'A', 'B'), dep('live-yz', 'Y', 'Z')], costSettings: LIVE_COST },
      payload([P('A', 0, 1, 'c1'), P('B', 3, 1, 'c1')], {
        dependencies: [
          { id: 'own-ab', predecessorPhaseId: 'A', successorPhaseId: 'B', depType: 'SS', lagMonths: 2 },
          { id: 'dangling', predecessorPhaseId: 'A', successorPhaseId: 'NOPE', depType: 'FS', lagMonths: 0 },
        ],
      }),
      ['c1', 'c2']
    )
    assert.deepEqual(view.dependencies.map((d) => d.id).sort(), ['live-yz', 'own-ab'])
  })
})

describe('applyVersionOverlay: cost model', () => {
  test("a version's cost settings and overrides price its schedule", () => {
    const live = [P('A', 24, 12)]
    const versionCost = {
      ...LIVE_COST,
      tpcFactor: 1.5,
      escalationAnnualPercent: 6,
      rateOverrides: [{ yearOffset: 2, ratePercent: 9 }],
    }
    const { projectId: _p, ...rest } = versionCost // eslint-disable-line @typescript-eslint/no-unused-vars
    const view = applyVersionOverlay(
      { phases: live, dependencies: [], costSettings: LIVE_COST },
      payload(live, { costSettings: rest }),
      ['c']
    )
    assert.equal(view.costSettings?.projectId, 'proj')
    assert.equal(view.costSettings?.tpcFactor, 1.5)
    assert.deepEqual(view.costSettings?.rateOverrides, [{ yearOffset: 2, ratePercent: 9 }])

    // ...and it actually changes the money, exactly as the engine says.
    const toEngine = (row: ProjectCostSettings): CostSettings => ({
      ...DEFAULT_COST_SETTINGS,
      tpcFactor: row.tpcFactor,
      baseYear: row.baseYear ?? 2026,
      escalationAnnualPercent: row.escalationAnnualPercent,
      rateOverrides: new Map(row.rateOverrides.map((o) => [o.yearOffset, o.ratePercent])),
    })
    const geometry = {
      interval: 'yearly' as const,
      years: 10,
      startCalendarYear: 2026,
      fiscalYearStartMonth: 7,
      fiscalYearLabelsBy: 'end_year' as const,
    }
    const enginePhase = { ...strip(view.phases[0]) }
    const inVersion = computePhaseCost(enginePhase, 1e6, toEngine(view.costSettings!), geometry)
    const inLive = computePhaseCost(enginePhase, 1e6, toEngine(LIVE_COST), geometry)
    assert.ok(inVersion.escalatedCost > inLive.escalatedCost)
  })

  test('a payload with no cost model (pre-0031) is priced with the live one', () => {
    const view = applyVersionOverlay(
      { phases: [P('A', 0)], dependencies: [], costSettings: LIVE_COST },
      payload([P('A', 3)]),
      ['c']
    )
    assert.equal(view.costSettings, LIVE_COST)
  })
})

describe('drags inside a version (M-05)', () => {
  test('two drags of different bars both survive', () => {
    const live = [P('A', 0), P('B', 5)]
    let v = payload(live)
    v = drop(live, v, ['c'], 'A', 3)
    v = drop(live, v, ['c'], 'B', 2)
    const byId = new Map(v.phases.map((p) => [p.id, p]))
    assert.equal(byId.get('A')!.startMonth, 3)
    assert.equal(byId.get('B')!.startMonth, 7)
  })

  test('a plain click (delta 0) changes nothing and is a no-op', () => {
    const live = [P('A', 0), P('B', 5)]
    let v = payload(live)
    v = drop(live, v, ['c'], 'A', 3)
    const after = drop(live, v, ['c'], 'B', 0)
    assert.equal(after, v, 'no new payload is built for a no-op drop')
  })

  test('dragging the same bar twice measures from its position in the version', () => {
    const live = [P('A', 0)]
    let v = payload(live)
    v = drop(live, v, ['c'], 'A', 2)
    v = drop(live, v, ['c'], 'A', 2)
    assert.equal(v.phases[0].startMonth, 4)
  })

  test('a fallback package becomes part of the version, whole, once edited', () => {
    const live = [P('A', 0, 1, 'old'), P('N1', 30, 2, 'new'), P('N2', 32, 2, 'new')]
    let v = payload([P('A', 0, 1, 'old')])
    v = drop(live, v, ['old', 'new'], 'N1', 1)
    const newPkg = v.phases.filter((p) => p.chunkProjectId === 'new')
    assert.deepEqual(
      newPkg.map((p) => [p.id, p.startMonth]).sort(),
      [
        ['N1', 31],
        ['N2', 32],
      ],
      'every phase of the touched package is written, not just the moved one'
    )
    // The live rows were not touched.
    assert.equal(live[1].startMonth, 30)
  })

  test('only the touched package is sent to the server', () => {
    const eff = [P('A', 0, 1, 'c1'), P('B', 1, 1, 'c1'), P('X', 0, 1, 'c2')]
    const sent = packagePhasesForSave(eff, [{ id: 'B', startMonth: 4, durationMonths: 1 }])
    assert.deepEqual(sent.map((p) => [p.id, p.startMonth]), [
      ['A', 0],
      ['B', 4],
    ])
  })

  test('propagation is applied when supplied and skipped when not', () => {
    const eff = [P('A', 0), P('B', 1)]
    const push = (rows: ChunkPhase[]) =>
      new Map(rows.map((r) => [r.id, { startMonth: r.id === 'B' ? Math.max(r.startMonth, rows[0].startMonth + 1) : r.startMonth }]))
    const withPush = changedPhasesForDrop(eff, 'A', { startMonth: 3, durationMonths: 1 }, push)
    assert.deepEqual(withPush.map((r) => [r.id, r.startMonth]), [['A', 3], ['B', 4]])
    const without = changedPhasesForDrop(eff, 'A', { startMonth: 3, durationMonths: 1 })
    assert.deepEqual(without.map((r) => [r.id, r.startMonth]), [['A', 3]])
  })
})

describe('version list', () => {
  const scenario = (id: string, name: string, createdAt: string) =>
    ({ id, name, createdAt }) as unknown as Scenario

  test('every version is listed as a peer, the one in the tables first', () => {
    const list = listVersions('Version 1', [
      scenario('b', 'Phased', '2026-03-01'),
      scenario('a', 'Fast track', '2026-02-01'),
    ])
    assert.deepEqual(list, [
      { key: LIVE_VERSION_KEY, scenarioId: null, name: 'Version 1' },
      { key: 'a', scenarioId: 'a', name: 'Fast track' },
      { key: 'b', scenarioId: 'b', name: 'Phased' },
    ])
  })

  test('next version name counts past the highest "Version N"', () => {
    assert.equal(nextVersionName([{ name: 'Version 1' }]), 'Version 2')
    assert.equal(nextVersionName([{ name: 'Version 1' }, { name: 'version 7' }]), 'Version 8')
    assert.equal(nextVersionName([{ name: 'Base' }, { name: 'Alt' }]), 'Version 3')
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
