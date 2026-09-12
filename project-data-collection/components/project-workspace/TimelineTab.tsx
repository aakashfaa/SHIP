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
  getChunkPhasesForProject,
  getChunkProjectsForProject,
  getCostSettingsForProject,
  getEnergySettingsForProject,
  getLineItemsForProject,
  getPhaseDependenciesForProject,
  getTimelineSettingsForProject,
  updateChunkPhase,
  updateTimelineSettingsForProject,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import type {
  ChunkPhase,
  ChunkProject,
  LineItem,
  PhaseDependency,
  Project,
  ProjectCostSettings,
  ProjectEnergySettings,
  ProjectTimelineSettings,
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

type Props = { project: Project }

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

export default function TimelineTab({ project }: Props) {
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

  const phasesByChunk = useMemo(() => {
    const map = new Map<string, ChunkPhase[]>()
    for (const phase of phases) {
      map.set(phase.chunkProjectId, [...(map.get(phase.chunkProjectId) ?? []), phase])
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return map
  }, [phases])

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

  const enginePhases = useMemo(() => phases.map(toEnginePhase), [phases])
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
   * A phase inside a COLLAPSED package has no bar of its own, so it maps to
   * its package's summary bar. Without that, every dependency touching a
   * collapsed package would simply vanish — which reads as "the tool lost my
   * link" rather than "that row is collapsed".
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

      if (row.phases.length === 0) continue
      const spanStart = Math.min(...row.phases.map((p) => p.startSlot))
      const spanEnd = Math.max(...row.phases.map((p) => p.startSlot + p.durationSlots))
      const rect = barRect(spanStart, spanEnd - spanStart, PACKAGE_ROW_HEIGHT)

      for (const phase of row.phases) {
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

  const handleToggleExpand = useCallback((chunkProjectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(chunkProjectId)) next.delete(chunkProjectId)
      else next.add(chunkProjectId)
      return next
    })
  }, [])

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
            <ExportBar project={project} className="no-print" />
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
              readOnly={false}
              onHoverSlot={setHoveredSlot}
              onToggleExpand={handleToggleExpand}
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
