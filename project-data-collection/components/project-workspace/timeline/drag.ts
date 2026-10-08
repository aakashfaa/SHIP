/**
 * The pure arithmetic behind dragging a phase bar, and behind folding a drop
 * into a what-if's overlay.
 *
 * It lives outside TimelineTab for one reason: the what-if drag bug (M-05) was
 * a data bug, not a rendering one -- every drop rebuilt the overlay from the
 * BASELINE rows, so each move silently erased the one before it. A bug of that
 * shape is only caught by feeding two drops through the real code in a row and
 * looking at the result, and that is far cheaper to do against plain functions
 * than against a component. `tests/unit/ws4-whatif.test.ts` does exactly that.
 *
 * Nothing here imports at runtime (only types, which are erased), so Node's
 * test runner can load it directly. Dependency propagation is passed IN as a
 * callback rather than imported, for the same reason.
 */

import type { ChunkPhase, ScenarioPhase } from '@/lib/types'

export type DragMode = 'move' | 'resize-start' | 'resize-end'

export type DragOrigin = {
  phaseId: string
  mode: DragMode
  startMonth: number
  durationMonths: number
}

export type Placement = { startMonth: number; durationMonths: number }

/**
 * May this drag start at all?
 *
 * A RESIZE of a phase that already starts at or beyond the end of the timeline
 * is refused. There is no column to resize it into: the old clamp
 * (`slotCount - startSlot`) went to zero or below, and the bar was saved with a
 * duration the database rejects outright -- or, inside a what-if, accepts into
 * the jsonb payload and then fails the whole publish (M-27). Moving such a phase
 * is still allowed, because moving it is how you bring it back into range.
 */
export function canStartDrag(origin: DragOrigin, horizonMonths: number): boolean {
  if (horizonMonths <= 0) return false
  if (origin.mode === 'move') return true
  return origin.startMonth < horizonMonths
}

/**
 * Where the bar sits after the pointer has moved `deltaMonths`.
 *
 * Everything here is in MONTHS (D-1). The caller snaps the pointer to whole
 * columns of the current zoom and converts -- one column at Year zoom is a
 * 12-month delta -- so a drag moves in the zoom's unit while what gets stored
 * is months, and a phase that sits mid-column keeps its offset.
 *
 * Every branch guarantees `startMonth >= 0` and `durationMonths >= 1`, which
 * are exactly the two invariants the database (and the scenario payload RPC)
 * enforce. The final `Math.max(1, …)` on resize-end is the M-27 clamp: without
 * it a phase whose start is past the last column ends up with duration <= 0.
 */
export function placementForDelta(
  origin: DragOrigin,
  deltaMonths: number,
  horizonMonths: number
): Placement {
  if (origin.mode === 'move') {
    const maxStart = Math.max(0, horizonMonths - origin.durationMonths)
    return {
      startMonth: Math.min(Math.max(origin.startMonth + deltaMonths, 0), maxStart),
      durationMonths: origin.durationMonths,
    }
  }

  if (origin.mode === 'resize-start') {
    const end = origin.startMonth + origin.durationMonths
    const nextStart = Math.min(Math.max(origin.startMonth + deltaMonths, 0), end - 1)
    return { startMonth: nextStart, durationMonths: Math.max(1, end - nextStart) }
  }

  const nextDuration = Math.max(
    1,
    Math.min(Math.max(origin.durationMonths + deltaMonths, 1), horizonMonths - origin.startMonth)
  )
  return { startMonth: origin.startMonth, durationMonths: nextDuration }
}

/** True when a drop put the bar back exactly where it started -- a click, or a
 *  drag that went nowhere. Such a drop must not write anything: in a what-if
 *  the old code treated a plain click as a full re-save of the overlay. */
export function isNoOpDrop(origin: DragOrigin, placement: Placement): boolean {
  return (
    placement.startMonth === origin.startMonth && placement.durationMonths === origin.durationMonths
  )
}

type PhaseLike = Pick<ChunkPhase, 'id' | 'startMonth' | 'durationMonths'>

/**
 * The rows a drop changes, measured against the phases the user was LOOKING
 * AT when they dropped -- inside a what-if that is the effective (overlaid)
 * schedule, never the baseline.
 *
 * `propagate`, when given, pushes successors a move has left in violation and
 * returns each phase's resulting start. It is optional because dependency
 * auto-push is behind `DEPENDENCY_LINKS_ENABLED` (D-14).
 */
export function changedPhasesForDrop<P extends PhaseLike>(
  effective: P[],
  phaseId: string,
  placement: Placement,
  propagate?: (phases: P[]) => Map<string, { startMonth: number }>
): P[] {
  const dropped = effective.map((phase) =>
    phase.id === phaseId ? { ...phase, ...placement } : phase
  )

  const propagated = propagate ? propagate(dropped) : null
  const next = propagated
    ? dropped.map((phase) => {
        const moved = propagated.get(phase.id)
        if (!moved || moved.startMonth === phase.startMonth) return phase
        return { ...phase, startMonth: moved.startMonth }
      })
    : dropped

  return next.filter((phase, index) => {
    const before = effective[index]
    return (
      phase.startMonth !== before.startMonth || phase.durationMonths !== before.durationMonths
    )
  })
}

/**
 * Folds the changed rows of one drop into a COPY of the existing overlay.
 *
 * This is the M-05 fix in one function. The previous version wrote an entry
 * for every phase on screen, taken from the baseline rows, which overwrote each
 * earlier move in the what-if with its live-plan position. Here only the ids
 * the drop actually changed are touched; every other entry -- including every
 * earlier move -- is carried over untouched.
 *
 * `fallback` supplies the full row for a phase the overlay has no entry for
 * yet (a phase created on the live plan after the branch).
 */
export function mergeDropIntoOverlay(
  overlay: ReadonlyMap<string, ScenarioPhase>,
  changed: Array<Pick<ChunkPhase, 'id' | 'startMonth' | 'durationMonths'>>,
  fallback: (id: string) => ScenarioPhase | undefined
): Map<string, ScenarioPhase> {
  const next = new Map(overlay)
  for (const row of changed) {
    const existing = next.get(row.id) ?? fallback(row.id)
    if (!existing) continue
    next.set(row.id, {
      ...existing,
      startMonth: Math.max(0, Math.round(row.startMonth)),
      durationMonths: Math.max(1, Math.round(row.durationMonths)),
    })
  }
  return next
}

/**
 * What a rebase ("Pull in the latest plan and keep my moves") actually did,
 * in words the banner can show.
 *
 * - `kept`: phases where the rebased what-if still differs from the live plan
 *   -- the user's moves that survived.
 * - `pulledIn`: phases whose what-if value changed because the rebase brought
 *   in the live plan's newer value.
 */
export type RebaseSummary = {
  kept: string[]
  pulledIn: string[]
}

type Comparable = Pick<
  ScenarioPhase,
  'id' | 'name' | 'startMonth' | 'durationMonths' | 'pctOfTpc' | 'durationLocked'
>

function samePlacement(a: Comparable, b: Comparable): boolean {
  return (
    a.startMonth === b.startMonth &&
    a.durationMonths === b.durationMonths &&
    a.pctOfTpc === b.pctOfTpc &&
    a.durationLocked === b.durationLocked
  )
}

export function summariseRebase(
  before: Comparable[],
  after: Comparable[],
  live: Comparable[],
  labelFor: (phase: Comparable) => string = (phase) => phase.name
): RebaseSummary {
  const beforeById = new Map(before.map((p) => [p.id, p]))
  const liveById = new Map(live.map((p) => [p.id, p]))
  const kept: string[] = []
  const pulledIn: string[] = []

  for (const phase of after) {
    const livePhase = liveById.get(phase.id)
    const previous = beforeById.get(phase.id)
    if (livePhase && !samePlacement(phase, livePhase)) kept.push(labelFor(phase))
    if (!previous || !samePlacement(phase, previous)) pulledIn.push(labelFor(phase))
  }

  return { kept, pulledIn }
}
