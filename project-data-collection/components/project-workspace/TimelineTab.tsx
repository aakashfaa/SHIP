'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { formatCurrency, parseCostInput, parseQuantityInput } from '@/lib/costs'
import {
  DEFAULT_COST_SETTINGS,
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
  PACKAGE_ROW_HEIGHT,
  PHASE_ROW_HEIGHT,
  barRect,
} from './timeline/layout'

const SETTINGS_PERSIST_DEBOUNCE_MS = 400

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

function toCostSettings(row: ProjectCostSettings | null): CostSettings {
  if (!row) return DEFAULT_COST_SETTINGS
  return {
    tpcFactor: row.tpcFactor,
    baseYear: row.baseYear,
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

type Props = {
  project: Project
  /** Resolved by the shell so the whole workspace agrees on one answer and
   *  the role RPC is not re-issued on every tab switch. */
  permissions: ProjectPermissions
}

type ActiveDrag = {
  phaseId: string
  mode: DragMode
  startSlot: number
  durationSlots: number
}

const DEFAULT_TIMELINE_SETTINGS: Omit<ProjectTimelineSettings, 'projectId'> = {
  years: 10,
  interval: 'yearly',
  zoomLevel: 3,
  escalationPercent: 0,
  escalationEveryYears: 1,
  startCalendarYear: new Date().getUTCFullYear(),
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
    error: timelineSettingsError,
  } = useAsyncData<ProjectTimelineSettings>(
    () => getTimelineSettingsForProject(project.id),
    [project.id],
    { projectId: project.id, ...DEFAULT_TIMELINE_SETTINGS }
  )

  const { data: costSettingsRow, error: costSettingsError } =
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

  const costSettings = useMemo(() => toCostSettings(costSettingsRow), [costSettingsRow])
  const energySettings = useMemo(() => toEnergySettings(energySettingsRow), [energySettingsRow])

  const geometry: TimelineGeometry = useMemo(
    () => ({
      interval: intervalForZoom(timelineSettings.zoomLevel),
      years: timelineSettings.years,
      startCalendarYear: timelineSettings.startCalendarYear,
      fiscalYearStartMonth: timelineSettings.fiscalYearStartMonth,
      fiscalYearLabelsBy: timelineSettings.fiscalYearLabelsBy,
    }),
    [timelineSettings]
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
          energySavingsAnnual += item.annualEnergySavings * quantity
          annualCostSavings += item.annualCostSavings * quantity
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
    if (!overlay) return phases
    return phases.map((phase) => {
      const moved = overlay.get(phase.id)
      if (!moved) return phase
      return {
        ...phase,
        startSlot: moved.startSlot,
        durationSlots: moved.durationSlots,
        pctOfTpc: moved.pctOfTpc,
        durationLocked: moved.durationLocked,
      }
    })
  }, [phases, overlay])

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

  const violations = useMemo(
    () => findDependencyViolations(enginePhases, engineDependencies),
    [enginePhases, engineDependencies]
  )
  const violatedLinkIds = useMemo(
    () => new Set(violations.map((v) => v.dependency.id)),
    [violations]
  )

  /* -------------------------------------------------------- row geometry -- */

  const rows = useMemo<RowLayout[]>(() => {
    let top = 0
    return summaries
      .slice()
      .sort((a, b) => {
        const aStart = phasesByChunk.get(a.input.chunkProjectId)?.[0]?.startSlot ?? 0
        const bStart = phasesByChunk.get(b.input.chunkProjectId)?.[0]?.startSlot ?? 0
        if (aStart !== bStart) return aStart - bStart
        return a.input.chunkNumber.localeCompare(b.input.chunkNumber)
      })
      .map((summary) => {
        const chunkPhases = phasesByChunk.get(summary.input.chunkProjectId) ?? []
        const isExpanded = expanded.has(summary.input.chunkProjectId)
        const height =
          PACKAGE_ROW_HEIGHT + (isExpanded ? chunkPhases.length * PHASE_ROW_HEIGHT : 0)
        const row: RowLayout = {
          summary,
          phases: chunkPhases,
          expanded: isExpanded,
          top,
          height,
        }
        top += height
        return row
      })
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
      dependencies.flatMap((dep) => {
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
  const activeScenarioRef = useRef<Scenario | null>(null)

  useEffect(() => {
    activeScenarioIdRef.current = activeScenarioId
  }, [activeScenarioId])
  useEffect(() => {
    overlayRef.current = overlay
  }, [overlay])
  useEffect(() => {
    activeScenarioRef.current = activeScenario
  }, [activeScenario])
  useEffect(() => {
    // Only track the baseline while we are on it; inside a scenario `phases`
    // is transiently the dragged state and must not overwrite the saved
    // baseline snapshot.
    if (!activeScenarioId) baselinePhasesRef.current = phases
  }, [phases, activeScenarioId])

  const persistOverlay = useCallback(
    async (next: Map<string, ScenarioPayload['phases'][number]>) => {
      const scenarioId = activeScenarioIdRef.current
      if (!scenarioId) return
      try {
        await saveScenarioPayload(scenarioId, {
          phases: [...next.values()],
          dependencies: activeScenarioRef.current?.payload.dependencies ?? [],
        })
        if (isMountedRef.current) setSaveError(null)
      } catch (err) {
        if (!isMountedRef.current) return
        setSaveError(err instanceof Error ? err.message : 'Failed to save the what-if.')
      }
    },
    []
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

  async function handleBranch(name: string) {
    // Consultants may branch -- modelling an idea privately is the point of
    // having them on the project. Viewers may not: migration 0011 refuses it,
    // and their sandbox is the ephemeral one above.
    if (!permissions.canContribute) return
    setSandboxBusy(true)
    setConflict(null)
    try {
      const scenario = await createScenario(project.id, name)
      setScenarios((prev) => [scenario, ...prev])
      setActiveScenarioId(scenario.id)
      setOverlay(overlayFromScenario(scenario))
      setSaveError(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not start the what-if.')
    } finally {
      setSandboxBusy(false)
    }
  }

  function handleEnterScenario(scenarioId: string) {
    const scenario = scenarios.find((s) => s.id === scenarioId)
    if (!scenario) return
    setConflict(null)
    setActiveScenarioId(scenario.id)
    setOverlay(overlayFromScenario(scenario))
  }

  /** Leaves the branch without touching it. The baseline was never modified,
   *  so this is purely dropping the overlay. */
  function handleExitScenario() {
    setActiveScenarioId(null)
    setOverlay(null)
    setConflict(null)
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
    try {
      const result = await publishScenario(activeScenarioId)
      if (!result.ok) {
        if (result.reason === 'conflict') {
          setConflict(
            'Someone edited the plan while you were exploring. Pull their changes in, keeping yours on top, then publish again.'
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
      setOverlay(null)
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
    setSandboxBusy(true)
    try {
      await deleteScenario(activeScenarioId)
      setScenarios((prev) => prev.filter((s) => s.id !== activeScenarioId))
      handleExitScenario()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not discard the what-if.')
    } finally {
      setSandboxBusy(false)
    }
  }

  async function handleRebase() {
    if (!activeScenarioId) return
    if (!permissions.canContribute) return
    setSandboxBusy(true)
    try {
      const rebased = await rebaseScenario(activeScenarioId)
      setScenarios((prev) => prev.map((s) => (s.id === rebased.id ? rebased : s)))
      setOverlay(overlayFromScenario(rebased))
      setPhases(await getChunkPhasesForProject(project.id))
      setConflict(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not pull in the changes.')
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
   * Local state updates on every pointermove so the bar tracks the cursor at
   * 60fps; the network write happens exactly once, on pointerup. That is the
   * pattern v1 established and it is the right one — a write per pointer event
   * would put hundreds of round trips behind a single drag.
   *
   * Dependency propagation also runs once, on drop rather than during the
   * drag. Cascading every frame makes downstream bars twitch while the user is
   * still deciding where to put this one.
   */
  function handlePhasePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    phase: ChunkPhase,
    mode: DragMode
  ) {
    if (slotCount <= 0) return

    // Belt and braces with the `readOnly` prop below: the grid stops
    // rendering the handles, and this refuses the drag even if something
    // else dispatches one.
    if (!canDrag) return

    // A locked phase is movable but not resizable. The handles are not
    // rendered at all, so reaching here with a resize mode means something
    // else dispatched it — refuse rather than silently stretching the bar.
    if (phase.durationLocked && mode !== 'move') return

    event.preventDefault()
    event.stopPropagation()

    const origin: ActiveDrag = {
      phaseId: phase.id,
      mode,
      startSlot: phase.startSlot,
      durationSlots: phase.durationSlots,
    }
    const originX = event.clientX

    const onMove = (moveEvent: PointerEvent) => {
      const deltaSlots = Math.round((moveEvent.clientX - originX) / CELL_WIDTH)

      setPhases((prev) =>
        prev.map((candidate) => {
          if (candidate.id !== origin.phaseId) return candidate

          if (origin.mode === 'move') {
            const maxStart = Math.max(0, slotCount - origin.durationSlots)
            return {
              ...candidate,
              startSlot: Math.min(Math.max(origin.startSlot + deltaSlots, 0), maxStart),
            }
          }

          if (origin.mode === 'resize-start') {
            const nextStart = Math.min(
              Math.max(origin.startSlot + deltaSlots, 0),
              origin.startSlot + origin.durationSlots - 1
            )
            return {
              ...candidate,
              startSlot: nextStart,
              durationSlots: origin.startSlot + origin.durationSlots - nextStart,
            }
          }

          const nextDuration = Math.min(
            Math.max(origin.durationSlots + deltaSlots, 1),
            slotCount - origin.startSlot
          )
          return { ...candidate, durationSlots: nextDuration }
        })
      )
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)

      const current = phasesRef.current
      const dragged = current.find((p) => p.id === origin.phaseId)
      if (!dragged) return

      // Push any successor the move has left in violation. Never pulls one
      // earlier — slack is a decision the planner made.
      const propagated = propagateDependencies(
        current.map(toEnginePhase),
        dependencies.map(toEngineDependency)
      )

      const next = current.map((phaseRow) => {
        const moved = propagated.get(phaseRow.id)
        if (!moved) return phaseRow
        if (moved.startSlot === phaseRow.startSlot) return phaseRow
        return { ...phaseRow, startSlot: moved.startSlot }
      })

      const changed = next.filter((phaseRow, index) => {
        const before = current[index]
        return (
          phaseRow.startSlot !== before.startSlot ||
          phaseRow.durationSlots !== before.durationSlots
        )
      })

      setPhases(next)

      // Inside a scenario the drag must NOT reach chunk_phases. It updates the
      // in-memory overlay and is saved to the scenario row instead — that
      // separation is the whole feature, and getting it wrong means a
      // "what-if" silently rewrites the live plan in front of a client.
      // A viewer's sandbox is local and stays local. Returning before either
      // persist path is what makes "nothing is saved" true rather than
      // aspirational -- migration 0011 refuses the writes as well, but the UI
      // should never be the thing that gets refused.
      if (isEphemeral) return

      if (activeScenarioIdRef.current) {
        const nextOverlay = new Map(overlayRef.current ?? [])
        for (const phaseRow of next) {
          nextOverlay.set(phaseRow.id, {
            id: phaseRow.id,
            chunkProjectId: phaseRow.chunkProjectId,
            name: phaseRow.name,
            kind: phaseRow.kind,
            sortOrder: phaseRow.sortOrder,
            pctOfTpc: phaseRow.pctOfTpc,
            startSlot: phaseRow.startSlot,
            durationSlots: phaseRow.durationSlots,
            durationLocked: phaseRow.durationLocked,
          })
        }
        setOverlay(nextOverlay)
        // Restore the baseline rows we just mutated locally: `setPhases` above
        // is what makes the bar follow the cursor, but `phases` is the
        // BASELINE, and leaving a scenario's placement in it would make
        // "Back to live plan" show the scenario's schedule.
        setPhases(baselinePhasesRef.current)
        void persistOverlay(nextOverlay)
        return
      }

      // `dragged` is always persisted even when propagation moved nothing,
      // because the drag itself is the change the user made.
      const toPersist = changed.length > 0 ? changed : [dragged]
      void persistPhases(toPersist)
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
              <ExportBar project={project} className="no-print" />
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
          onBranch={(name) => void handleBranch(name)}
          onEnter={handleEnterScenario}
          onExit={isEphemeral ? handleResetEphemeral : handleExitScenario}
          onPublish={() => void handlePublish()}
          onDiscard={() => void handleDiscard()}
          onRebase={() => void handleRebase()}
        />

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
              disabled={!canEditBaseline}
              className="mt-4 w-full accent-slate-900"
            />
            <div className="mt-3 grid grid-cols-5 text-center text-[10px] font-medium text-slate-500">
              {ZOOM_LEVELS.map((z) => (
                <span key={z.level}>{z.label}</span>
              ))}
            </div>
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
