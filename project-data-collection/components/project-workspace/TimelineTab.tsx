'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  formatCurrency,
  isUnreadableCost,
  parseCostInput,
  parseQuantityInput,
} from '@/lib/costs'
import {
  DEFAULT_COST_SETTINGS,
  applyScenarioOverlay,
  DEFAULT_ENERGY_SETTINGS,
  computeEnergySeries,
  computeFiscalYearTotals,
  computeSlotCosts,
  fiscalYearLabel,
  findDependencyViolations,
  propagateDependencies,
  slotCount as computeSlotCount,
  summarisePackage,
  type CostSettings,
  type EnergySettings,
  type PackageInput,
  type Phase,
  type PhaseDependency as EnginePhaseDependency,
  type TimelineGeometry,
} from '@/lib/cost-model'
import {
  createScenario,
  deleteScenario,
  getChunkPhasesForProject,
  getChunkProjectsForProject,
  getCostSettingsForProject,
  getEnergySettingsForProject,
  getLineItemsForProject,
  getPhaseDependenciesForProject,
  getScenariosForProject,
  getTimelineSettingsForProject,
  publishScenario,
  rebaseScenario,
  saveScenarioPayload,
  updateChunkPhase,
  updateTimelineSettingsForProject,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import type { ProjectPermissions } from '@/lib/project-role'
import type {
  ChunkPhase,
  ChunkProject,
  LineItem,
  PhaseDependency,
  Project,
  ProjectCostSettings,
  ProjectEnergySettings,
  ProjectTimelineSettings,
  Scenario,
  ScenarioPayload,
  ScenarioPhase,
  TimelineInterval,
} from '@/lib/types'
import TimelineGrid, {
  phaseRowTop,
  type DragMode,
  type RowLayout,
} from './timeline/TimelineGrid'
import EnergyChart from './timeline/EnergyChart'
import type { ArrowLink } from './timeline/DependencyArrows'
import ExportBar from './ExportBar'
import SandboxBar from './timeline/SandboxBar'
import {
  BAR_HEIGHT,
  CELL_WIDTH,
  DEPENDENCY_LINKS_ENABLED,
  PACKAGE_ROW_HEIGHT,
  PHASE_ROW_HEIGHT,
  barRect,
} from './timeline/layout'
import {
  canStartDrag,
  changedPhasesForDrop,
  isNoOpDrop,
  mergeDropIntoOverlay,
  placementForDelta,
  summariseRebase,
  type DragOrigin,
  type Placement,
} from './timeline/drag'

const SETTINGS_PERSIST_DEBOUNCE_MS = 400

/**
 * Zoom is LOCKED for now (M-01, interim).
 *
 * Phases are stored in "slots", and a slot means whatever the project's zoom
 * says it means -- a year at Year zoom, a month at Month zoom. Moving the
 * slider therefore did not zoom anything: it reinterpreted every stored phase,
 * re-priced the whole plan (about -24% going Year -> Month on a test plan) and
 * saved that for every user and for the Excel export. Until schedules are
 * stored in one fixed unit (the months conversion, a coordinated later wave),
 * the slider is disabled and `handleZoomChange` refuses to write, so
 * `interval_unit` cannot change from this screen. The code path stays so that
 * wave only has to flip this flag and add the conversion.
 */
const ZOOM_LOCKED = true

const ZOOM_LEVELS: Array<{ level: number; interval: TimelineInterval; label: string }> = [
  { level: 1, interval: '5-yearly', label: '5 year' },
  { level: 2, interval: '3-yearly', label: '3 year' },
  { level: 3, interval: 'yearly', label: 'Year' },
  { level: 4, interval: 'quarterly', label: 'Quarter' },
  { level: 5, interval: 'monthly', label: 'Month' },
]

function intervalForZoom(zoomLevel: number): TimelineInterval {
  return ZOOM_LEVELS.find((z) => z.level === zoomLevel)?.interval ?? 'yearly'
}

function zoomLabel(zoomLevel: number): string {
  return ZOOM_LEVELS.find((z) => z.level === zoomLevel)?.label ?? 'Year'
}

function slotLabel(index: number, interval: TimelineInterval): string {
  switch (interval) {
    case 'monthly':
      return `Y${Math.floor(index / 12) + 1} M${(index % 12) + 1}`
    case 'quarterly':
      return `Y${Math.floor(index / 4) + 1} Q${(index % 4) + 1}`
    case 'yearly':
      return `Year ${index + 1}`
    case 'bi-yearly':
      return `Y${index * 2 + 1}-${index * 2 + 2}`
    case '3-yearly':
      return `Y${index * 3 + 1}-${index * 3 + 3}`
    case '5-yearly':
      return `Y${index * 5 + 1}-${index * 5 + 5}`
    default:
      return `${index + 1}`
  }
}

/** Domain row → engine row. The engine deliberately knows nothing about
 *  Supabase or the wire format, so this is the one place the two meet. */
function toEnginePhase(phase: ChunkPhase): Phase {
  return {
    id: phase.id,
    chunkProjectId: phase.chunkProjectId,
    name: phase.name,
    kind: phase.kind,
    sortOrder: phase.sortOrder,
    pctOfTpc: phase.pctOfTpc,
    startSlot: phase.startSlot,
    durationSlots: phase.durationSlots,
    durationLocked: phase.durationLocked,
  }
}

function toEngineDependency(dep: PhaseDependency): EnginePhaseDependency {
  return {
    id: dep.id,
    predecessorPhaseId: dep.predecessorPhaseId,
    successorPhaseId: dep.successorPhaseId,
    depType: dep.depType,
    lagSlots: dep.lagSlots,
  }
}

/** `fallbackBaseYear` is only used when the row's base year is missing
 *  (null, M-25). That state is shown as a warning on screen rather than
 *  quietly priced as if it were real -- see `missingYears` below. */
function toCostSettings(
  row: ProjectCostSettings | null,
  fallbackBaseYear: number
): CostSettings {
  if (!row) return DEFAULT_COST_SETTINGS
  return {
    tpcFactor: row.tpcFactor,
    baseYear: row.baseYear ?? fallbackBaseYear,
    escalationMode: row.escalationMode,
    escalationAnnualPercent: row.escalationAnnualPercent,
    escalationStepYears: row.escalationStepYears,
    escalationBasis: row.escalationBasis,
    escalationConfidenceYears: row.escalationConfidenceYears,
    rateOverrides: new Map(row.rateOverrides.map((o) => [o.yearOffset, o.ratePercent])),
  }
}

function toEnergySettings(row: ProjectEnergySettings | null): EnergySettings {
  if (!row) return DEFAULT_ENERGY_SETTINGS
  return {
    unitLabel: row.unitLabel,
    baselineAnnual: row.baselineAnnual,
    interactionFactor: row.interactionFactor,
  }
}

/** Up to four names, then "and N more" -- a rebase can touch dozens of phases
 *  and the banner must stay a sentence, not a report. */
function listNames(names: string[]): string {
  const shown = names.slice(0, 4).join(', ')
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown
}

function describeRebase(pulledIn: string[], kept: string[]): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const pulled =
    pulledIn.length === 0
      ? 'Nothing in the live plan needed pulling in.'
      : `Pulled in the live plan’s newer values for ${plural(pulledIn.length, 'phase')}: ${listNames(pulledIn)}.`
  const yours =
    kept.length === 0
      ? 'None of your moves differ from the live plan any more.'
      : `Kept your ${plural(kept.length, 'move')}: ${listNames(kept)}.`
  return `${pulled} ${yours} You can publish now.`
}

type Props = {
  project: Project
  /** Resolved by the shell so the whole workspace agrees on one answer and
   *  the role RPC is not re-issued on every tab switch. */
  permissions: ProjectPermissions
}

/** The bar being dragged right now and where it currently sits. Applied on
 *  top of everything else in `effectivePhases`, so the bar follows the cursor
 *  in every mode -- including inside a what-if, where it used to sit still
 *  until the drop because the drag was written to the baseline rows that the
 *  overlay then covered up (M-05). */
type DragPreview = { phaseId: string } & Placement

function toScenarioPhase(phase: ChunkPhase): ScenarioPhase {
  return {
    id: phase.id,
    chunkProjectId: phase.chunkProjectId,
    name: phase.name,
    kind: phase.kind,
    sortOrder: phase.sortOrder,
    pctOfTpc: phase.pctOfTpc,
    startSlot: phase.startSlot,
    durationSlots: phase.durationSlots,
    durationLocked: phase.durationLocked,
  }
}

const DEFAULT_TIMELINE_SETTINGS: Omit<ProjectTimelineSettings, 'projectId'> = {
  years: 10,
  interval: 'yearly',
  zoomLevel: 3,
  escalationPercent: 0,
  escalationEveryYears: 1,
  // Placeholder until the row loads. Null, not "this year" (M-25).
  startCalendarYear: null,
  fiscalYearStartMonth: 7,
  fiscalYearLabelsBy: 'end_year',
}

export default function TimelineTab({ project, permissions }: Props) {
  const { data: chunkProjects, loading: chunksLoading, error: chunksError } = useAsyncData<
    ChunkProject[]
  >(() => getChunkProjectsForProject(project.id), [project.id], [])

  const { data: lineItems, error: lineItemsError } = useAsyncData<LineItem[]>(
    () => getLineItemsForProject(project.id),
    [project.id],
    []
  )

  const {
    data: phases,
    setData: setPhases,
    error: phasesError,
  } = useAsyncData<ChunkPhase[]>(() => getChunkPhasesForProject(project.id), [project.id], [])

  const { data: dependencies, error: dependenciesError } = useAsyncData<PhaseDependency[]>(
    () => getPhaseDependenciesForProject(project.id),
    [project.id],
    []
  )

  const {
    data: timelineSettings,
    setData: setTimelineSettings,
    loading: timelineSettingsLoading,
    error: timelineSettingsError,
  } = useAsyncData<ProjectTimelineSettings>(
    () => getTimelineSettingsForProject(project.id),
    [project.id],
    { projectId: project.id, ...DEFAULT_TIMELINE_SETTINGS }
  )

  const {
    data: costSettingsRow,
    loading: costSettingsLoading,
    error: costSettingsError,
  } =
    useAsyncData<ProjectCostSettings | null>(
      () => getCostSettingsForProject(project.id),
      [project.id],
      null
    )

  const { data: energySettingsRow, error: energySettingsError } =
    useAsyncData<ProjectEnergySettings | null>(
      () => getEnergySettingsForProject(project.id),
      [project.id],
      null
    )

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [hoveredSlot, setHoveredSlot] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * Sandbox state.
   *
   * `activeScenarioId` is the branch the user is inside; null means the live
   * plan. `overlay` holds that branch's phase placements in memory.
   *
   * The overlay is applied on TOP of the loaded baseline rather than replacing
   * it, and the baseline rows are never mutated while a scenario is active.
   * That is what makes "Back to live plan" a state change rather than a reload,
   * and it is why discarding a scenario cannot damage anything.
   */
  const {
    data: scenarios,
    setData: setScenarios,
    reload: reloadScenarios,
  } = useAsyncData<Scenario[]>(() => getScenariosForProject(project.id), [project.id], [])
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null)

  /**
   * Three different questions, deliberately not collapsed into one flag.
   *
   * `isEphemeral` -- a viewer. R5.3: "a viewer can move bars freely in an
   *   ephemeral sandbox that is never persisted anywhere". Steve's version:
   *   "they could even, to a certain degree, play with things a little bit,
   *   but it won't save". So they DO get to drag; the drop just goes nowhere.
   *
   * `canEditBaseline` -- may change the live plan. Admin and editor.
   *
   * `canDrag` -- may move a bar at all, which is a different question from
   *   both. A consultant cannot touch the baseline but CAN reschedule inside
   *   their own what-if, because that writes the scenario row rather than
   *   chunk_phases. Treating "cannot edit" as "cannot drag" would take the
   *   sandbox away from the people most likely to want one.
   */
  const isEphemeral = permissions.isViewer
  const canEditBaseline = permissions.canEdit
  const canDrag =
    canEditBaseline || isEphemeral || (activeScenarioId !== null && permissions.canContribute)
  const [overlay, setOverlay] = useState<Map<string, ScenarioPayload['phases'][number]> | null>(
    null
  )
  const [sandboxBusy, setSandboxBusy] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [rebaseNotice, setRebaseNotice] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)

  const phasesRef = useRef(phases)
  const isMountedRef = useRef(true)
  const pendingSettingsRef = useRef<Partial<ProjectTimelineSettings>>({})
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    phasesRef.current = phases
  }, [phases])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current)
    }
  }, [])

  /* ------------------------------------------------------- derived state -- */

  // Base year and start year are each allowed to be missing (null) now that
  // the mappers stop inventing "this year" for them (M-25). The engine needs
  // numbers, so each borrows the other, and the screen says so (missingYears)
  // instead of presenting a stand-in as the project's real setting.
  const standInYear =
    timelineSettings.startCalendarYear ??
    costSettingsRow?.baseYear ??
    DEFAULT_COST_SETTINGS.baseYear
  const costSettings = useMemo(
    () => toCostSettings(costSettingsRow, standInYear),
    [costSettingsRow, standInYear]
  )
  const energySettings = useMemo(() => toEnergySettings(energySettingsRow), [energySettingsRow])

  const geometry: TimelineGeometry = useMemo(
    () => ({
      interval: intervalForZoom(timelineSettings.zoomLevel),
      years: timelineSettings.years,
      startCalendarYear: timelineSettings.startCalendarYear ?? standInYear,
      fiscalYearStartMonth: timelineSettings.fiscalYearStartMonth,
      fiscalYearLabelsBy: timelineSettings.fiscalYearLabelsBy,
    }),
    [timelineSettings, standInYear]
  )

  const slotCount = useMemo(
    () => computeSlotCount(geometry.years, geometry.interval),
    [geometry]
  )

  const lineItemMap = useMemo(() => new Map(lineItems.map((i) => [i.id, i])), [lineItems])

  /**
   * Package-level inputs, summed from line items.
   *
   * `eccAmount` is the trigger-maintained numeric form of the free-text
   * `estimatedFirstCost`. It is preferred, with a parse of the text as a
   * fallback for any row written before migration 0006 backfilled the column —
   * belt and braces, since a silently-zero cost is the worst failure this
   * screen can have.
   */
  const packageInputs = useMemo<PackageInput[]>(
    () =>
      chunkProjects.map((chunk) => {
        let eccBase = 0
        let energySavingsAnnual = 0
        let annualCostSavings = 0

        for (const link of chunk.itemLinks) {
          const item = lineItemMap.get(link.lineItemId)
          if (!item) continue
          const quantity = parseQuantityInput(link.quantity)
          const unitCost = item.eccAmount || parseCostInput(item.estimatedFirstCost)

          eccBase += unitCost * quantity
          // Blank (null) is "not answered" (D-9); for a sum it contributes nothing.
          energySavingsAnnual += (item.annualEnergySavings ?? 0) * quantity
          annualCostSavings += (item.annualCostSavings ?? 0) * quantity
        }

        return {
          chunkProjectId: chunk.id,
          chunkNumber: chunk.chunkNumber,
          name: chunk.name,
          eccBase,
          energySavingsAnnual,
          annualCostSavings,
        }
      }),
    [chunkProjects, lineItemMap]
  )

  /**
   * Line items in a package whose cost text can't be read. Since the strict
   * parser (M-09) these are NULL rather than a silently-wrong number, and
   * every total on this screen counts them as $0 -- which has to be said out
   * loud, or a $0 looks like an answer.
   */
  const unreadableCostCount = useMemo(() => {
    const used = new Set(chunkProjects.flatMap((c) => c.itemLinks.map((l) => l.lineItemId)))
    return lineItems.filter(
      (item) => used.has(item.id) && isUnreadableCost(item.estimatedFirstCost)
    ).length
  }, [chunkProjects, lineItems])

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) ?? null,
    [scenarios, activeScenarioId]
  )

  /**
   * The phases the screen actually draws.
   *
   * When a scenario is active this is the baseline with the branch's
   * placements laid over it. Everything downstream — costs, the energy
   * staircase, the dependency arrows, the fiscal-year totals — reads from here,
   * so a what-if reprices the whole plan exactly as a real edit would. That is
   * the entire point: "What if we do this?" has to produce a real number, not a
   * preview of one.
   */
  const effectivePhases = useMemo<ChunkPhase[]>(() => {
    // The same overlay rule the server-side export uses (lib/cost-model), so
    // the screen and the Excel of a what-if price identical schedules.
    const overlaid = overlay ? applyScenarioOverlay(phases, [...overlay.values()]) : phases
    // The in-flight drag goes on LAST, after the overlay, so it is what the
    // user sees whichever plan they are on.
    if (!dragPreview) return overlaid
    return overlaid.map((phase) =>
      phase.id === dragPreview.phaseId
        ? {
            ...phase,
            startSlot: dragPreview.startSlot,
            durationSlots: dragPreview.durationSlots,
          }
        : phase
    )
  }, [phases, overlay, dragPreview])

  const phasesByChunk = useMemo(() => {
    const map = new Map<string, ChunkPhase[]>()
    for (const phase of effectivePhases) {
      map.set(phase.chunkProjectId, [...(map.get(phase.chunkProjectId) ?? []), phase])
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return map
  }, [effectivePhases])

  const summaries = useMemo(
    () =>
      packageInputs.map((input) =>
        summarisePackage(
          input,
          (phasesByChunk.get(input.chunkProjectId) ?? []).map(toEnginePhase),
          costSettings,
          geometry
        )
      ),
    [packageInputs, phasesByChunk, costSettings, geometry]
  )

  const slotCosts = useMemo(() => computeSlotCosts(summaries, geometry), [summaries, geometry])

  const energySeries = useMemo(
    () => computeEnergySeries(summaries, energySettings, geometry),
    [summaries, energySettings, geometry]
  )

  const fiscalTotals = useMemo(() => computeFiscalYearTotals(slotCosts), [slotCosts])

  const enginePhases = useMemo(() => effectivePhases.map(toEnginePhase), [effectivePhases])
  const engineDependencies = useMemo(
    () => dependencies.map(toEngineDependency),
    [dependencies]
  )

  // With links switched off (D-14) there is nothing on screen to explain a
  // "dependency not satisfied" warning, and no way to act on it, so it goes
  // with the arrows.
  const violations = useMemo(
    () =>
      DEPENDENCY_LINKS_ENABLED
        ? findDependencyViolations(enginePhases, engineDependencies)
        : [],
    [enginePhases, engineDependencies]
  )
  const violatedLinkIds = useMemo(
    () => new Set(violations.map((v) => v.dependency.id)),
    [violations]
  )

  /* -------------------------------------------------------- row geometry -- */

  const rows = useMemo<RowLayout[]>(() => {
    const sorted = summaries.slice().sort((a, b) => {
      const aStart = phasesByChunk.get(a.input.chunkProjectId)?.[0]?.startSlot ?? 0
      const bStart = phasesByChunk.get(b.input.chunkProjectId)?.[0]?.startSlot ?? 0
      if (aStart !== bStart) return aStart - bStart
      return a.input.chunkNumber.localeCompare(b.input.chunkNumber)
    })
    // A plain loop rather than a `top` captured and mutated inside `.map`,
    // which the React compiler lint rejects as a post-render reassignment.
    const laidOut: RowLayout[] = []
    let top = 0
    for (const summary of sorted) {
      const chunkPhases = phasesByChunk.get(summary.input.chunkProjectId) ?? []
      const isExpanded = expanded.has(summary.input.chunkProjectId)
      const height =
        PACKAGE_ROW_HEIGHT + (isExpanded ? chunkPhases.length * PHASE_ROW_HEIGHT : 0)
      laidOut.push({ summary, phases: chunkPhases, expanded: isExpanded, top, height })
      top += height
    }
    return laidOut
  }, [summaries, phasesByChunk, expanded])

  const bodyHeight = rows.reduce((sum, row) => sum + row.height, 0)

  /**
   * Pixel rects for every phase, keyed by phase id.
   *
   * A phase inside a COLLAPSED package has no bar of its own, so it is drawn
   * on its package's summary bar -- but at the phase's OWN horizontal extent.
   * Mapping it to the whole summary bar made a link into a package's
   * construction phase land on the package's first study month, which looked
   * like a backward link and routed as a loop.
   */
  const phaseRects = useMemo(() => {
    const rects = new Map<string, { x: number; y: number; width: number; height: number }>()

    for (const row of rows) {
      if (row.expanded) {
        row.phases.forEach((phase, index) => {
          const rect = barRect(phase.startSlot, phase.durationSlots, PHASE_ROW_HEIGHT)
          rects.set(phase.id, {
            x: rect.left,
            y: phaseRowTop(row, index) + rect.top,
            width: rect.width,
            height: BAR_HEIGHT,
          })
        })
        continue
      }

      for (const phase of row.phases) {
        const rect = barRect(phase.startSlot, phase.durationSlots, PACKAGE_ROW_HEIGHT)
        rects.set(phase.id, {
          x: rect.left,
          y: row.top + rect.top,
          width: rect.width,
          height: BAR_HEIGHT,
        })
      }
    }

    return rects
  }, [rows])

  const links = useMemo<ArrowLink[]>(
    () =>
      (DEPENDENCY_LINKS_ENABLED ? dependencies : []).flatMap((dep) => {
        const predecessor = phaseRects.get(dep.predecessorPhaseId)
        const successor = phaseRects.get(dep.successorPhaseId)
        if (!predecessor || !successor) return []
        return [
          {
            id: dep.id,
            depType: dep.depType,
            lagSlots: dep.lagSlots,
            predecessor,
            successor,
            violated: violatedLinkIds.has(dep.id),
          },
        ]
      }),
    [dependencies, phaseRects, violatedLinkIds]
  )

  /* ------------------------------------------------------------ mutation -- */

  // Refs, not state, because the pointerup handler is created once per drag and
  // would otherwise close over the values as they were when the drag started.
  const activeScenarioIdRef = useRef(activeScenarioId)
  const overlayRef = useRef(overlay)
  const baselinePhasesRef = useRef(phases)
  const effectivePhasesRef = useRef(effectivePhases)
  const scenariosRef = useRef(scenarios)

  useEffect(() => {
    activeScenarioIdRef.current = activeScenarioId
  }, [activeScenarioId])
  useEffect(() => {
    overlayRef.current = overlay
  }, [overlay])
  useEffect(() => {
    effectivePhasesRef.current = effectivePhases
  }, [effectivePhases])
  useEffect(() => {
    scenariosRef.current = scenarios
  }, [scenarios])
  useEffect(() => {
    // Only track the baseline while we are on it. Drags no longer write to
    // `phases` mid-gesture (they go through `dragPreview`), but a what-if's
    // placements must still never become the "live plan" snapshot.
    if (!activeScenarioId) baselinePhasesRef.current = phases
  }, [phases, activeScenarioId])

  /**
   * What-if saves, one at a time and in order.
   *
   * Each drop is fire-and-forget from the drag's point of view, so two quick
   * drops would otherwise race: if the first save's response landed second it
   * would put the older payload back. Chaining them makes the server see the
   * drops in the order the user made them, and lets Publish wait for the last
   * one instead of publishing a payload that is one move behind.
   */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const saveSeqRef = useRef(new Map<string, number>())

  const persistOverlay = useCallback(
    (scenarioId: string, next: Map<string, ScenarioPhase>) => {
      const phasesPayload = [...next.values()]
      const seq = (saveSeqRef.current.get(scenarioId) ?? 0) + 1
      saveSeqRef.current.set(scenarioId, seq)

      // M-30: keep `scenarios` in step with what is on screen, optimistically
      // and before the round trip. "Back to live plan" then "Resume…" rebuilds
      // the overlay from this list; when it still held the page-load payload,
      // resuming showed none of the moves and the next drag saved that stale
      // copy over the real one.
      setScenarios((prev) =>
        prev.map((s) =>
          s.id === scenarioId ? { ...s, payload: { ...s.payload, phases: phasesPayload } } : s
        )
      )

      const run = async () => {
        const dependencies =
          scenariosRef.current.find((s) => s.id === scenarioId)?.payload.dependencies ?? []
        try {
          // Through the store, which calls ship.save_scenario_payload (owner
          // only, server-side merge that keeps cost_settings, validates ids
          // and ranges) rather than a raw UPDATE of the jsonb.
          const saved = await saveScenarioPayload(scenarioId, phasesPayload, dependencies)
          if (!isMountedRef.current) return
          // A write that matched no row is a refusal, not a success: the old
          // code dropped the returned row on the floor and carried on.
          if (!saved) {
            setSaveError(
              "This what-if couldn't be saved. Only the person who started it can change it."
            )
            return
          }
          setSaveError(null)
          // Adopt the server's row only if no newer save for this what-if has
          // been queued since; otherwise it would briefly undo the optimistic
          // update above.
          if (saveSeqRef.current.get(scenarioId) === seq) {
            setScenarios((prev) => prev.map((s) => (s.id === saved.id ? saved : s)))
          }
        } catch (err) {
          if (!isMountedRef.current) return
          setSaveError(err instanceof Error ? err.message : 'Failed to save the what-if.')
        }
      }

      const chained = saveChainRef.current.then(run)
      saveChainRef.current = chained
      return chained
    },
    [setScenarios]
  )

  const persistPhases = useCallback(async (changed: ChunkPhase[]) => {
    try {
      await Promise.all(
        changed.map((phase) =>
          updateChunkPhase(phase.id, {
            startSlot: phase.startSlot,
            durationSlots: phase.durationSlots,
          })
        )
      )
      if (isMountedRef.current) setSaveError(null)
    } catch (err) {
      if (!isMountedRef.current) return
      setSaveError(err instanceof Error ? err.message : 'Failed to save the schedule.')
    }
  }, [])

  /* ------------------------------------------------------------- sandbox -- */

  function overlayFromScenario(scenario: Scenario) {
    return new Map(scenario.payload.phases.map((phase) => [phase.id, phase]))
  }

  /** Swaps the overlay in state AND in its ref, so a drop that lands before
   *  the next render already builds on the right overlay. */
  function replaceOverlay(next: Map<string, ScenarioPhase> | null) {
    overlayRef.current = next
    setOverlay(next)
  }

  async function handleBranch(name: string) {
    // Consultants may branch -- modelling an idea privately is the point of
    // having them on the project. Viewers may not: migration 0011 refuses it,
    // and their sandbox is the ephemeral one above.
    if (!permissions.canContribute) return
    setSandboxBusy(true)
    setConflict(null)
    setRebaseNotice(null)
    try {
      const scenario = await createScenario(project.id, name)
      setScenarios((prev) => [scenario, ...prev])
      setActiveScenarioId(scenario.id)
      replaceOverlay(overlayFromScenario(scenario))
      setSaveError(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not start the what-if.')
    } finally {
      setSandboxBusy(false)
    }
  }

  function handleEnterScenario(scenarioId: string) {
    // Reads the list that `persistOverlay` keeps current (M-30), so resuming
    // shows the latest saved moves rather than the page-load copy.
    const scenario = scenarios.find((s) => s.id === scenarioId)
    if (!scenario) return
    setConflict(null)
    setRebaseNotice(null)
    setActiveScenarioId(scenario.id)
    replaceOverlay(overlayFromScenario(scenario))
  }

  /** Leaves the branch without touching it. The baseline was never modified,
   *  so this is purely dropping the overlay. */
  function handleExitScenario() {
    setActiveScenarioId(null)
    replaceOverlay(null)
    setConflict(null)
    setRebaseNotice(null)
    setDragPreview(null)
    setPhases(baselinePhasesRef.current)
  }

  /** A viewer's "Reset". Nothing was persisted, so restoring the baseline
   *  rows is the entire operation -- there is no server state to undo. */
  function handleResetEphemeral() {
    setPhases(baselinePhasesRef.current)
  }

  async function handlePublish() {
    if (!activeScenarioId) return
    // Publishing writes the shared baseline. This is the UI half of the fix
    // in migration 0011, where publish_scenario() was checking read access
    // while its own comment claimed it checked edit access.
    if (!canEditBaseline) return
    setSandboxBusy(true)
    setConflict(null)
    setRebaseNotice(null)
    try {
      // The last drop's save may still be in flight; publishing before it
      // lands would publish the what-if one move behind what is on screen.
      await saveChainRef.current
      const result = await publishScenario(activeScenarioId)
      if (!result.ok) {
        if (result.reason === 'conflict') {
          setConflict(
            'Someone changed the live plan while you were exploring. Pull in the latest plan: your moves stay where you put them, and everything you did not move takes the live plan’s newer values. Then publish again.'
          )
        } else {
          setSaveError(result.message)
        }
        return
      }
      // The branch is now the baseline. Drop the overlay and re-read, rather
      // than assuming what landed — publish_scenario() reports how many rows
      // it touched precisely because that can differ from what was sent.
      setActiveScenarioId(null)
      replaceOverlay(null)
      await reloadScenarios()
      setPhases(await getChunkPhasesForProject(project.id))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not publish.')
    } finally {
      setSandboxBusy(false)
    }
  }

  async function handleDiscard() {
    if (!activeScenarioId) return
    if (!permissions.canContribute) return
    // SandboxBar only calls this from its inline "Yes, delete this what-if"
    // confirm (M-23); there is no one-click path here any more.
    setSandboxBusy(true)
    try {
      await saveChainRef.current
      await deleteScenario(activeScenarioId)
      setScenarios((prev) => prev.filter((s) => s.id !== activeScenarioId))
      handleExitScenario()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not discard the what-if.')
    } finally {
      setSandboxBusy(false)
    }
  }

  /**
   * "Pull in the latest plan and keep my moves" (M-07).
   *
   * The server does a real 3-way merge now (migration 0015): a phase keeps the
   * what-if's value only where the user changed it since branching, and takes
   * the live plan's value everywhere else -- dependencies included. The old
   * rebase kept the what-if's copy of EVERY phase, so publishing afterwards
   * silently reverted colleagues' edits.
   *
   * Afterwards we say what happened, by comparing the what-if before and after
   * against the freshly loaded live plan. A rebase whose outcome you have to
   * guess at is one people stop trusting.
   */
  async function handleRebase() {
    if (!activeScenarioId) return
    if (!permissions.canContribute) return
    setSandboxBusy(true)
    setRebaseNotice(null)
    try {
      await saveChainRef.current
      const before = [...(overlayRef.current?.values() ?? [])]
      const rebased = await rebaseScenario(activeScenarioId)
      const live = await getChunkPhasesForProject(project.id)
      setScenarios((prev) => prev.map((s) => (s.id === rebased.id ? rebased : s)))
      replaceOverlay(overlayFromScenario(rebased))
      setPhases(live)
      setConflict(null)

      const chunkNames = new Map(chunkProjects.map((c) => [c.id, c.name]))
      const phaseChunk = new Map(live.map((p) => [p.id, p.chunkProjectId]))
      const summary = summariseRebase(before, rebased.payload.phases, live, (phase) => {
        const chunkName = chunkNames.get(phaseChunk.get(phase.id) ?? '')
        return chunkName ? `${chunkName} – ${phase.name}` : phase.name
      })
      setRebaseNotice(describeRebase(summary.pulledIn, summary.kept))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not pull in the latest plan.')
    } finally {
      setSandboxBusy(false)
    }
  }

  const handleToggleExpand = useCallback((chunkProjectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(chunkProjectId)) next.delete(chunkProjectId)
      else next.add(chunkProjectId)
      return next
    })
  }, [])

  const handleSetAllExpanded = useCallback(
    (open: boolean) => {
      setExpanded(open ? new Set(rows.map((row) => row.summary.input.chunkProjectId)) : new Set())
    },
    [rows]
  )

  /**
   * Drag / resize a phase bar.
   *
   * During the drag only `dragPreview` changes, and it is applied on top of
   * the overlay, so the bar tracks the cursor whether you are on the live plan
   * or inside a what-if. The network write happens exactly once, on pointerup
   * -- a write per pointer event would put hundreds of round trips behind a
   * single drag -- and not at all when the bar ends where it started.
   *
   * Everything is measured against the schedule the user is LOOKING AT
   * (`effectivePhases`), never the baseline rows. Inside a what-if that is the
   * difference between "move this bar" and "move this bar and quietly put
   * every other bar back where the live plan has it" (M-05).
   *
   * Dependency propagation runs once, on drop, and only while dependency links
   * are switched on (D-14, `DEPENDENCY_LINKS_ENABLED`).
   */
  function handlePhasePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    phase: ChunkPhase,
    mode: DragMode
  ) {
    // Belt and braces with the `readOnly` prop below: the grid stops
    // rendering the handles, and this refuses the drag even if something
    // else dispatches one.
    if (!canDrag) return

    // A locked phase is movable but not resizable. The handles are not
    // rendered at all, so reaching here with a resize mode means something
    // else dispatched it — refuse rather than silently stretching the bar.
    if (phase.durationLocked && mode !== 'move') return

    const origin: DragOrigin = {
      phaseId: phase.id,
      mode,
      startSlot: phase.startSlot,
      durationSlots: phase.durationSlots,
    }
    // Refuses a resize of a phase that starts past the last column (M-27).
    if (!canStartDrag(origin, slotCount)) return

    event.preventDefault()
    event.stopPropagation()

    const originX = event.clientX
    let latest: Placement = { startSlot: origin.startSlot, durationSlots: origin.durationSlots }

    const onMove = (moveEvent: PointerEvent) => {
      const deltaSlots = Math.round((moveEvent.clientX - originX) / CELL_WIDTH)
      const next = placementForDelta(origin, deltaSlots, slotCount)
      // Most pointermoves land in the same column; skip the re-render.
      if (next.startSlot === latest.startSlot && next.durationSlots === latest.durationSlots) {
        return
      }
      latest = next
      setDragPreview({ phaseId: origin.phaseId, ...next })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragPreview(null)

      // A click, or a drag that came back to where it began. Nothing to save
      // -- in a what-if, a plain click used to re-save the whole overlay.
      if (isNoOpDrop(origin, latest)) return

      // The schedule on screen just before this drag: the effective phases
      // with the dragged bar put back at its origin (the ref also carries the
      // live preview, which is not "before").
      const before = effectivePhasesRef.current.map((row) =>
        row.id === origin.phaseId
          ? { ...row, startSlot: origin.startSlot, durationSlots: origin.durationSlots }
          : row
      )

      // Push any successor the move has left in violation. Never pulls one
      // earlier — slack is a decision the planner made.
      const propagate = DEPENDENCY_LINKS_ENABLED
        ? (rows: ChunkPhase[]) =>
            propagateDependencies(
              rows.map(toEnginePhase),
              dependencies.map(toEngineDependency)
            )
        : undefined

      const changed = changedPhasesForDrop(before, origin.phaseId, latest, propagate)
      if (changed.length === 0) return

      const scenarioId = activeScenarioIdRef.current
      if (scenarioId) {
        // Inside a scenario the drag must NOT reach chunk_phases. Only the rows
        // this drop changed are written, into a COPY of the existing overlay,
        // so every earlier move in the what-if survives. Saved to the scenario
        // row, never the live plan -- that separation is the whole feature.
        const nextOverlay = mergeDropIntoOverlay(
          overlayRef.current ?? new Map(),
          changed,
          (id) => {
            const row = phasesRef.current.find((p) => p.id === id)
            return row ? toScenarioPhase(row) : undefined
          }
        )
        replaceOverlay(nextOverlay)
        void persistOverlay(scenarioId, nextOverlay)
        return
      }

      const changedById = new Map(changed.map((row) => [row.id, row]))
      setPhases((prev) =>
        prev.map((row) => {
          const moved = changedById.get(row.id)
          return moved
            ? { ...row, startSlot: moved.startSlot, durationSlots: moved.durationSlots }
            : row
        })
      )

      // A viewer's sandbox is local and stays local. Returning before the
      // persist is what makes "nothing is saved" true rather than aspirational
      // -- migration 0011 refuses the writes as well, but the UI should never
      // be the thing that gets refused.
      if (isEphemeral) return

      void persistPhases(changed)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /* ----------------------------------------------------- settings writes -- */

  function scheduleSettingsPersist(updates: Partial<ProjectTimelineSettings>) {
    // project_timeline_settings_update is my_editable_project_ids(), so for a
    // consultant or viewer this write matches zero rows and then surfaces
    // "Failed to save the timeline settings" a debounce later -- an error
    // message for an action we told them elsewhere they could not take. The
    // sliders are disabled for them instead; this guard is the backstop for
    // anything that calls in another way.
    if (!canEditBaseline) return

    pendingSettingsRef.current = { ...pendingSettingsRef.current, ...updates }
    if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current)
    settingsTimerRef.current = setTimeout(() => {
      settingsTimerRef.current = null
      const payload = pendingSettingsRef.current
      pendingSettingsRef.current = {}
      if (Object.keys(payload).length === 0) return
      updateTimelineSettingsForProject(project.id, payload).catch((err) => {
        if (!isMountedRef.current) return
        setSaveError(
          err instanceof Error ? err.message : 'Failed to save the timeline settings.'
        )
      })
    }, SETTINGS_PERSIST_DEBOUNCE_MS)
  }

  function handleYearsChange(years: number) {
    setTimelineSettings((prev) => ({ ...prev, years }))
    scheduleSettingsPersist({ years })
  }

  function handleZoomChange(zoomLevel: number) {
    // M-01 interim: never write a new zoom while slots still mean "whatever
    // the zoom says". See ZOOM_LOCKED.
    if (ZOOM_LOCKED) return
    const interval = intervalForZoom(zoomLevel)
    setTimelineSettings((prev) => ({ ...prev, zoomLevel, interval }))
    scheduleSettingsPersist({ zoomLevel, interval })
  }

  /* -------------------------------------------------------------- render -- */

  const slotLabels = useMemo(
    () => Array.from({ length: slotCount }, (_, i) => slotLabel(i, geometry.interval)),
    [slotCount, geometry.interval]
  )
  const fiscalLabels = useMemo(
    () => Array.from({ length: slotCount }, (_, i) => fiscalYearLabel(i, geometry)),
    [slotCount, geometry]
  )

  const loadError =
    chunksError ??
    lineItemsError ??
    phasesError ??
    dependenciesError ??
    timelineSettingsError ??
    costSettingsError ??
    energySettingsError

  const grandTotal = summaries.reduce((sum, s) => sum + s.totalEscalatedCost, 0)
  const grandBase = summaries.reduce((sum, s) => sum + s.totalBaseCost, 0)

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-950">Timeline</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              Schedule each package&apos;s phases independently — design can sit years ahead
              of the construction it belongs to. Costs escalate from where they land.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* The two deliverables the client actually asked for: "we can make
                that an Excel spreadsheet pretty easily that we could give to the
                client. And then we would want a PDF view of the whole phasing
                schedule." Neither carries the cost model — see lib/export. */}
            {/* R8.4: a viewer does not get the deliverables. They are being
                shown the plan, not handed a copy of it to pass on. */}
            {permissions.isViewer ? null : (
              <ExportBar
                project={project}
                // M-24: while a what-if is open, Excel exports THAT schedule,
                // matching the screen and the PDF.
                scenario={
                  activeScenario ? { id: activeScenario.id, name: activeScenario.name } : null
                }
                className="no-print"
              />
            )}
            <div className="rounded-[1rem] border border-slate-200 bg-slate-50 px-4 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Total (escalated)
              </div>
              <div className="text-lg font-semibold text-slate-950">
                {formatCurrency(grandTotal)}
              </div>
              <div className="text-[11px] text-slate-500">
                base {formatCurrency(grandBase)} · escalation{' '}
                {formatCurrency(grandTotal - grandBase)}
              </div>
            </div>
          </div>
        </div>

        {/* Megan: "how do you know that you're looking at the official published
            one versus your own? [...] if it's active, that means that you're
            looking at a local copy." The active state is a full-width amber
            bar for exactly that reason. */}
        <SandboxBar
          ephemeral={isEphemeral}
          scenarios={scenarios}
          activeScenario={activeScenario}
          busy={sandboxBusy}
          conflict={conflict}
          rebaseNotice={rebaseNotice}
          onBranch={(name) => void handleBranch(name)}
          onEnter={handleEnterScenario}
          onExit={isEphemeral ? handleResetEphemeral : handleExitScenario}
          onPublish={() => void handlePublish()}
          onDiscard={() => void handleDiscard()}
          onRebase={() => void handleRebase()}
        />

        {unreadableCostCount > 0 ? (
          <div
            role="alert"
            className="rounded-[1.25rem] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {unreadableCostCount} item{unreadableCostCount === 1 ? ' has' : 's have'} an
            unreadable cost &mdash; {unreadableCostCount === 1 ? 'it counts' : 'they count'} as
            $0 until fixed in Master View.
          </div>
        ) : null}

        {/* M-25: a missing year is shown, never silently replaced. */}
        {!timelineSettingsLoading &&
        !costSettingsLoading &&
        (timelineSettings.startCalendarYear === null || costSettingsRow?.baseYear === null) ? (
          <div
            role="alert"
            className="rounded-[1.25rem] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {timelineSettings.startCalendarYear === null
              ? 'Timeline start year not set. '
              : ''}
            {costSettingsRow?.baseYear === null ? 'Cost base year not set. ' : ''}
            Fiscal years and escalation below use {standInYear} as a stand-in, so treat these
            totals as provisional until it is set.
          </div>
        ) : null}

        {loadError || saveError ? (
          <div className="rounded-[1.25rem] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {saveError ?? loadError?.message ?? 'Something went wrong.'}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="rounded-[1.25rem] border border-slate-200 bg-slate-50/80 p-4">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="timeline-years" className="text-sm font-medium text-slate-700">
                Timeline Length
              </label>
              <div className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-900">
                {timelineSettings.years} years
              </div>
            </div>
            <input
              id="timeline-years"
              type="range"
              min={1}
              max={50}
              step={1}
              value={timelineSettings.years}
              onChange={(e) => handleYearsChange(Number(e.target.value))}
              disabled={!canEditBaseline}
              className="mt-4 w-full accent-slate-900"
            />
          </div>

          <div className="rounded-[1.25rem] border border-slate-200 bg-slate-50/80 p-4">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="timeline-zoom" className="text-sm font-medium text-slate-700">
                Zoom
              </label>
              <div className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-900">
                {zoomLabel(timelineSettings.zoomLevel)}
              </div>
            </div>
            <input
              id="timeline-zoom"
              type="range"
              min={1}
              max={5}
              step={1}
              value={timelineSettings.zoomLevel}
              onChange={(e) => handleZoomChange(Number(e.target.value))}
              disabled={ZOOM_LOCKED || !canEditBaseline}
              aria-describedby={ZOOM_LOCKED ? 'timeline-zoom-locked' : undefined}
              className="mt-4 w-full accent-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="mt-3 grid grid-cols-5 text-center text-[10px] font-medium text-slate-500">
              {ZOOM_LEVELS.map((z) => (
                <span key={z.level}>{z.label}</span>
              ))}
            </div>
            {ZOOM_LOCKED ? (
              <p id="timeline-zoom-locked" className="mt-3 text-[11px] text-slate-500">
                Zoom is temporarily fixed. Changing it would move every phase and change the
                totals; it comes back once schedules are stored in months.
              </p>
            ) : null}
          </div>

          {/* Escalation is READ-ONLY here and edited on the Cost Model tab.
              It is not a slider you nudge while presenting — changing it
              re-prices the entire plan, which is a decision, not a gesture. */}
          <div className="rounded-[1.25rem] border border-slate-200 bg-slate-50/80 p-4">
            <div className="text-sm font-medium text-slate-700">Escalation</div>
            <div className="mt-3 space-y-1 text-sm text-slate-600">
              <div>
                <span className="font-semibold text-slate-900">
                  {costSettings.escalationAnnualPercent}%
                </span>{' '}
                {costSettings.escalationMode === 'compound_annual'
                  ? 'compounding annually'
                  : `every ${costSettings.escalationStepYears} yrs`}
              </div>
              <div className="text-xs text-slate-500">
                from base year {costSettings.baseYear}, measured to the{' '}
                {costSettings.escalationBasis} of each phase
              </div>
              {costSettings.rateOverrides.size > 0 ? (
                <div className="text-xs text-slate-500">
                  {costSettings.rateOverrides.size} year
                  {costSettings.rateOverrides.size === 1 ? '' : 's'} overridden
                </div>
              ) : null}
            </div>
            <p className="mt-3 text-[11px] text-slate-400">Edit on the Cost Model tab.</p>
          </div>
        </div>
      </div>

      {violations.length > 0 ? (
        <div className="rounded-[1.25rem] border border-rose-200 bg-rose-50 px-5 py-4">
          <div className="text-sm font-semibold text-rose-900">
            {violations.length} dependenc{violations.length === 1 ? 'y is' : 'ies are'} not
            satisfied
          </div>
          {/* Listed, not auto-repaired. A repair moves work the user placed,
              and a settings change (shortening the timeline, say) can create
              these without anyone dragging anything. */}
          <ul className="mt-2 space-y-1 text-xs text-rose-800">
            {violations.slice(0, 5).map((violation) => (
              <li key={violation.dependency.id}>
                <span className="font-medium">{violation.successor.name}</span> starts at slot{' '}
                {violation.actualStart} but cannot start before{' '}
                {violation.requiredStart.toFixed(0)} ({violation.dependency.depType} from{' '}
                {violation.predecessor.name})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-sm font-medium text-slate-400">
          {chunksLoading
            ? 'Loading timeline…'
            : 'Create packages in Chunking before scheduling them.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <TimelineGrid
              rows={rows}
              slotCosts={slotCosts}
              slotLabels={slotLabels}
              fiscalYearLabels={fiscalLabels}
              links={links}
              bodyHeight={bodyHeight}
              slotCount={slotCount}
              hoveredSlot={hoveredSlot}
              // Was hardcoded false. `canDrag`, not `canEdit`: a viewer may
              // drag inside their ephemeral sandbox and a consultant may drag
              // inside their own what-if, neither of which touches the
              // baseline. What none of them get is a grab cursor followed by a
              // silent RLS rejection on pointer-up.
              readOnly={!canDrag}
              // The grid needs to tell "not allowed" apart from "not known
              // yet" -- both collapse to the same `readOnly` value while the
              // role RPC is in flight -- so it can hold its caption instead
              // of announcing a permission that has not resolved.
              permissionsLoading={permissions.loading}
              onHoverSlot={setHoveredSlot}
              onToggleExpand={handleToggleExpand}
              onSetAllExpanded={handleSetAllExpanded}
              onPhasePointerDown={handlePhasePointerDown}
              onSelectLink={() => undefined}
            />
            <EnergyChart
              series={energySeries}
              slotCount={slotCount}
              hoveredSlot={hoveredSlot}
            />
          </div>
        </div>
      )}

      {fiscalTotals.length > 0 ? (
        <div className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-950">By fiscal year</h3>
          <p className="mt-1 text-xs text-slate-500">
            What a capital plan is actually presented as — and what the client has to fit
            into an annual allocation.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {fiscalTotals.map((year) => (
              <div
                key={year.fiscalYear}
                className="rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  FY{String(year.fiscalYear % 100).padStart(2, '0')}
                </div>
                <div className="text-sm font-semibold text-slate-900">
                  {formatCurrency(year.escalatedTotal)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
