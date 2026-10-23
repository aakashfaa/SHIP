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
  computeFiscalYearTotals,
  computeSlotCosts,
  findDependencyViolations,
  formatFiscalYear,
  monthLabel,
  monthsPerSlot as computeMonthsPerSlot,
  propagateDependencies,
  resolveHorizon,
  slotCalendarLabel,
  slotCount as computeSlotCount,
  slotFiscalLabel,
  summarisePackage,
  type CostSettings,
  type PackageInput,
  type Phase,
  type PhaseDependency as EnginePhaseDependency,
  type TimelineGeometry,
} from '@/lib/cost-model'
import {
  createVersion,
  deleteVersion,
  getChunkPhasesForProject,
  getChunkProjectsForProject,
  getCostSettingsForProject,
  getLineItemsForProject,
  getPhaseDependenciesForProject,
  getTimelineSettingsForProject,
  getVersionsForProject,
  renameVersion,
  saveVersionPhases,
  updateChunkPhase,
  updateTimelineSettingsForProject,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import { packagePositions } from '@/lib/package-order'
import { useAuth } from '@/lib/auth-context'
import type { ProjectPermissions } from '@/lib/project-role'
import type {
  ChunkPhase,
  ChunkProject,
  LineItem,
  PhaseDependency,
  Project,
  ProjectCostSettings,
  ProjectTimelineSettings,
  Scenario,
  ScenarioPhase,
  TimelineInterval,
} from '@/lib/types'
import {
  LIVE_VERSION_KEY,
  applyVersionOverlay,
  listVersions,
  packagePhasesForSave,
  replacePackagePhases,
} from '@/lib/versions'
import TimelineGrid, {
  phaseRowTop,
  type DragMode,
  type RowLayout,
} from './timeline/TimelineGrid'
import TimelineGraphs, { useTimelineGraphs } from './timeline/TimelineGraphs'
import GraphSetupButton from './timeline/GraphSetup'
import type { ArrowLink } from './timeline/DependencyArrows'
import ExportBar from './ExportBar'
import TimelineFilter from './view-filter/TimelineFilter'
import VersionBar from './timeline/VersionBar'
import CostModelBox from './cost-model/CostModelBox'
import { flattenFiscalQuarters } from './timeline/cost-breakdown'
import { useEffectiveViewSettings } from '@/lib/use-effective-view-settings'
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
  placementForDelta,
  type DragOrigin,
  type Placement,
} from './timeline/drag'

const SETTINGS_PERSIST_DEBOUNCE_MS = 400

/**
 * Zoom is a VIEW, and only a view (M-01, D-1).
 *
 * Phases used to be stored in "slots" whose size the zoom set, so moving the
 * slider re-priced the whole plan and saved that for everyone and for the
 * Excel export. Since migration 0020 schedules are stored in months, every
 * total is computed from months, and the zoom only decides how many months
 * one column shows. So it is per-viewer state here -- anyone, viewers
 * included, can zoom -- and changing it writes nothing. The project's stored
 * `zoomLevel` is just the view a page opens at.
 */
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
    startMonth: phase.startMonth,
    durationMonths: phase.durationMonths,
    durationLocked: phase.durationLocked,
  }
}

function toEngineDependency(dep: PhaseDependency): EnginePhaseDependency {
  return {
    id: dep.id,
    predecessorPhaseId: dep.predecessorPhaseId,
    successorPhaseId: dep.successorPhaseId,
    depType: dep.depType,
    lagMonths: dep.lagMonths,
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

/**
 * The version this person last opened on this project's Timeline (owner:
 * the Timeline "remembers which version you last opened", per user per
 * project). Browser storage, so every access is guarded: private windows and
 * blocked storage throw, and the page must work without it.
 */
function versionStorageKey(email: string | null | undefined, projectId: string): string {
  return `ship:timeline-version:${email ?? 'anon'}:${projectId}`
}

function readStoredVersion(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStoredVersion(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** Resolves on the frame after the next paint: long enough for a version
 *  switch to be on screen before the print dialog snapshots the page. */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

type Props = {
  project: Project
  /** Resolved by the shell so the whole workspace agrees on one answer and
   *  the role RPC is not re-issued on every tab switch. */
  permissions: ProjectPermissions
  /** Switches the workspace to the Master View tab. Supplied by the shell. */
  onOpenMasterView?: () => void
  /** Switches to Settings, where the line-item form is built. Supplied by
   *  the shell for project admins only; graph setup links there when the
   *  form has no number field to graph. */
  onOpenFormBuilder?: () => void
}

/** The bar being dragged right now and where it currently sits. Applied on
 *  top of everything else in `effectivePhases`, so the bar follows the cursor
 *  in every version -- it used to sit still inside a what-if until the drop,
 *  because the drag was written to rows the overlay then covered up (M-05). */
type DragPreview = { phaseId: string } & Placement

/** "Jul 2027 – Jun 2029 · 24 months": a phase's span in words, from months. */
function describeSpan(
  startMonth: number,
  durationMonths: number,
  geometry: TimelineGeometry
): string {
  const last = startMonth + Math.max(durationMonths, 1) - 1
  const months = Math.round(durationMonths * 100) / 100
  return `${monthLabel(startMonth, geometry)} – ${monthLabel(last, geometry)} · ${months} month${
    months === 1 ? '' : 's'
  }`
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

export default function TimelineTab({
  project,
  permissions,
  onOpenMasterView,
  onOpenFormBuilder,
}: Props) {
  // The graphs under the timeline (migration 0032) and the request that
  // opens their setup popup at one graph (a chart's empty state, the Cost
  // model's graph list).
  const {
    graphs,
    setGraphs,
    reloadGraphs,
    formFields,
    error: graphsError,
  } = useTimelineGraphs(project.id)
  const [graphSetupRequest, setGraphSetupRequest] = useState<{ n: number; graphId: string | null }>({
    n: 0,
    graphId: null,
  })
  const openGraphSetup = useCallback(
    (graphId: string | null) => setGraphSetupRequest((r) => ({ n: r.n + 1, graphId })),
    []
  )
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
    reload: reloadPhases,
  } = useAsyncData<ChunkPhase[]>(() => getChunkPhasesForProject(project.id), [project.id], [])

  const {
    data: dependencies,
    error: dependenciesError,
    reload: reloadDependencies,
  } = useAsyncData<PhaseDependency[]>(
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

  // `reload` is how the Cost model popup's writes reach the totals: it calls
  // back after every save, and the whole plan re-prices from the fresh rows.
  // useAsyncData keeps the old row on screen while the re-read is in flight.
  const {
    data: costSettingsRow,
    loading: costSettingsLoading,
    error: costSettingsError,
    reload: reloadCostSettings,
  } = useAsyncData<ProjectCostSettings | null>(
    () => getCostSettingsForProject(project.id),
    [project.id],
    null
  )

  /**
   * Versions (migration 0031). One version is held in the tables loaded
   * above; every other one is a scenario row overlaid on them in memory
   * (lib/versions.ts). The UI treats them all as peers.
   */
  const {
    data: versionData,
    setData: setVersionData,
    loading: versionsLoading,
    reload: reloadVersions,
  } = useAsyncData<{ liveName: string; scenarios: Scenario[] }>(
    () => getVersionsForProject(project.id),
    [project.id],
    { liveName: 'Version 1', scenarios: [] }
  )
  const scenarios = versionData.scenarios
  const setScenarios = useCallback(
    (update: (prev: Scenario[]) => Scenario[]) =>
      setVersionData((prev) => ({ ...prev, scenarios: update(prev.scenarios) })),
    [setVersionData]
  )

  // Phases and links too: changing the project's phase template re-applies
  // it to every package (cost-model/CostModelEditor). Versions too: inside a
  // version the popup writes that version's payload. Graphs: the popup's
  // graph list can recolour them (0032; energy settings are no longer read).
  const handleCostModelChanged = useCallback(() => {
    reloadCostSettings()
    reloadGraphs()
    reloadPhases()
    reloadDependencies()
  }, [reloadCostSettings, reloadGraphs, reloadPhases, reloadDependencies])

  // Display choices: the project default, or this person's own from the
  // Filter button (lib/use-effective-view-settings). Display only: nothing
  // here changes what is priced, just what is drawn. `showEnergy` is the
  // switch for every graph now; `hiddenGraphs` hides them one by one.
  const timelineView = useEffectiveViewSettings(project.id, 'timeline', permissions.isAdmin)
  const { costBreakdown, showEnergy, showPackages, hiddenGraphs } = timelineView.effective

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [hoveredSlot, setHoveredSlot] = useState<number | null>(null)
  // The viewer's own zoom (D-1). Null = "the project's default view", so the
  // page follows the stored default until this person picks something else.
  const [viewZoomLevel, setViewZoomLevel] = useState<number | null>(null)
  const zoomLevel = viewZoomLevel ?? timelineSettings.zoomLevel
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * Which version is on screen. Owner: "All equal, pick on export" -- every
   * version is a peer, and the Timeline remembers the one this person last
   * opened (per user per project, browser storage). `selectedKey` is what
   * they picked; it falls back to the version in the live tables whenever it
   * names a version that no longer exists (deleted by a colleague, say).
   */
  const { user } = useAuth()
  const storageKey = versionStorageKey(user?.email, project.id)
  const [selectedKey, setSelectedKey] = useState<string>(LIVE_VERSION_KEY)
  const [restoredFor, setRestoredFor] = useState<string | null>(null)
  // Restore once the list has loaded -- state adjusted during render, not in
  // an effect. Only ever on the client: the list loads in the browser.
  if (!versionsLoading && restoredFor !== storageKey) {
    setRestoredFor(storageKey)
    const stored = readStoredVersion(storageKey)
    if (stored && (stored === LIVE_VERSION_KEY || scenarios.some((s) => s.id === stored))) {
      setSelectedKey(stored)
    }
  }
  const versions = useMemo(
    () => listVersions(versionData.liveName, scenarios),
    [versionData.liveName, scenarios]
  )
  const activeKey = versions.some((v) => v.key === selectedKey) ? selectedKey : LIVE_VERSION_KEY
  const activeScenarioId = activeKey === LIVE_VERSION_KEY ? null : activeKey
  const activeVersionName =
    versions.find((v) => v.key === activeKey)?.name ?? versionData.liveName

  /**
   * Admins and editors change versions -- the schedule, the cost model,
   * which versions exist. Everyone else (consultants, viewers) switches
   * between them read-only: owner, "Whole team". The old viewer "ephemeral
   * sandbox" (drag freely, nothing saved) went with the what-if.
   */
  const canEditBaseline = permissions.canEdit
  const canDrag = canEditBaseline
  const [versionBusy, setVersionBusy] = useState(false)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)

  const isMountedRef = useRef(true)
  const pendingSettingsRef = useRef<Partial<ProjectTimelineSettings>>({})
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current)
    }
  }, [])

  /* ------------------------------------------------------- derived state -- */

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) ?? null,
    [scenarios, activeScenarioId]
  )

  /**
   * The open version: its phases, links and cost model. The version held in
   * the tables is the loaded rows as they are; any other is its payload laid
   * over them by lib/versions.ts `applyVersionOverlay` -- the same function
   * the Excel export calls, so the screen, the PDF and the workbook of a
   * version price identical schedules. The loaded rows are never mutated
   * while another version is open.
   */
  const versionView = useMemo(
    () =>
      applyVersionOverlay(
        { phases, dependencies, costSettings: costSettingsRow },
        activeScenario ? activeScenario.payload : null,
        chunkProjects.map((chunk) => chunk.id)
      ),
    [phases, dependencies, costSettingsRow, activeScenario, chunkProjects]
  )
  // The open version's cost model: what the totals and the Cost model box use.
  const versionCostRow = versionView.costSettings

  // Base year and start year are each allowed to be missing (null) now that
  // the mappers stop inventing "this year" for them (M-25). The engine needs
  // numbers, so each borrows the other, and the screen says so (missingYears)
  // instead of presenting a stand-in as the project's real setting.
  const standInYear =
    timelineSettings.startCalendarYear ??
    versionCostRow?.baseYear ??
    DEFAULT_COST_SETTINGS.baseYear
  const costSettings = useMemo(
    () => toCostSettings(versionCostRow, standInYear),
    [versionCostRow, standInYear]
  )

  // The CONFIGURED geometry, at the viewer's zoom. Everything that draws or
  // totals uses `geometry` below, which is this stretched by the one horizon
  // rule (M-27) to cover every phase.
  const configuredGeometry: TimelineGeometry = useMemo(
    () => ({
      interval: intervalForZoom(zoomLevel),
      years: timelineSettings.years,
      startCalendarYear: timelineSettings.startCalendarYear ?? standInYear,
      fiscalYearStartMonth: timelineSettings.fiscalYearStartMonth,
      fiscalYearLabelsBy: timelineSettings.fiscalYearLabelsBy,
    }),
    [timelineSettings, standInYear, zoomLevel]
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

  /**
   * The phases the screen actually draws: the open version's (versionView)
   * with the in-flight drag laid on LAST, so the bar follows the cursor in
   * every version. Everything downstream — costs, the energy staircase, the
   * dependency arrows, the fiscal-year totals — reads from here, so switching
   * version re-prices the whole plan exactly as the export does.
   */
  const effectivePhases = useMemo<ChunkPhase[]>(() => {
    if (!dragPreview) return versionView.phases
    return versionView.phases.map((phase) =>
      phase.id === dragPreview.phaseId
        ? {
            ...phase,
            startMonth: dragPreview.startMonth,
            durationMonths: dragPreview.durationMonths,
          }
        : phase
    )
  }, [versionView, dragPreview])

  const phasesByChunk = useMemo(() => {
    const map = new Map<string, ChunkPhase[]>()
    for (const phase of effectivePhases) {
      map.set(phase.chunkProjectId, [...(map.get(phase.chunkProjectId) ?? []), phase])
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return map
  }, [effectivePhases])

  const enginePhases = useMemo(() => effectivePhases.map(toEnginePhase), [effectivePhases])

  /**
   * The one horizon rule (M-27, lib/cost-model `resolveHorizon`), the same
   * call the Excel export makes: the timeline runs to the end of the
   * furthest phase if that is past the Timeline Length, so every dollar in
   * the headline has a column and a fiscal year.
   */
  const horizon = useMemo(
    () => resolveHorizon(configuredGeometry, enginePhases),
    [configuredGeometry, enginePhases]
  )
  const geometry = horizon.geometry
  const monthsPerSlot = computeMonthsPerSlot(geometry.interval)
  const horizonMonths = geometry.years * 12

  const slotCount = useMemo(
    () => computeSlotCount(geometry.years, geometry.interval),
    [geometry]
  )

  // Priced from months only: `summarisePackage` never sees the zoom, so the
  // headline and every package total are the same at every zoom level.
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

  // Monthly resolution, fiscal quarters (M-26, D-11) -- the same function the
  // export's Annual Cost Summary uses.
  const fiscalTotals = useMemo(
    () => computeFiscalYearTotals(summaries, geometry),
    [summaries, geometry]
  )
  // The by-quarter strip is the same totals laid out flat, never a second sum.
  const fiscalQuarters = useMemo(() => flattenFiscalQuarters(fiscalTotals), [fiscalTotals])
  const engineDependencies = useMemo(
    () => versionView.dependencies.map(toEngineDependency),
    [versionView.dependencies]
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

  // Rows follow the user-owned package order from the Packaging tab
  // (sort_order, migration 0030), not start date or number.
  const packageOrder = useMemo(() => packagePositions(chunkProjects), [chunkProjects])

  const rows = useMemo<RowLayout[]>(() => {
    const sorted = summaries.slice().sort(
      (a, b) =>
        (packageOrder.get(a.input.chunkProjectId) ?? Number.MAX_SAFE_INTEGER) -
        (packageOrder.get(b.input.chunkProjectId) ?? Number.MAX_SAFE_INTEGER)
    )
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
  }, [summaries, phasesByChunk, expanded, packageOrder])

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
          const rect = barRect(
            phase.startMonth,
            phase.durationMonths,
            PHASE_ROW_HEIGHT,
            monthsPerSlot
          )
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
        const rect = barRect(
          phase.startMonth,
          phase.durationMonths,
          PACKAGE_ROW_HEIGHT,
          monthsPerSlot
        )
        rects.set(phase.id, {
          x: rect.left,
          y: row.top + rect.top,
          width: rect.width,
          height: BAR_HEIGHT,
        })
      }
    }

    return rects
  }, [rows, monthsPerSlot])

  const links = useMemo<ArrowLink[]>(
    () =>
      (DEPENDENCY_LINKS_ENABLED ? versionView.dependencies : []).flatMap((dep) => {
        const predecessor = phaseRects.get(dep.predecessorPhaseId)
        const successor = phaseRects.get(dep.successorPhaseId)
        if (!predecessor || !successor) return []
        return [
          {
            id: dep.id,
            depType: dep.depType,
            lagMonths: dep.lagMonths,
            predecessor,
            successor,
            violated: violatedLinkIds.has(dep.id),
          },
        ]
      }),
    [versionView.dependencies, phaseRects, violatedLinkIds]
  )

  /* ------------------------------------------------------------ mutation -- */

  // Refs, not state, because the pointerup handler is created once per drag and
  // would otherwise close over the values as they were when the drag started.
  const activeScenarioIdRef = useRef(activeScenarioId)
  const effectivePhasesRef = useRef(effectivePhases)

  useEffect(() => {
    activeScenarioIdRef.current = activeScenarioId
  }, [activeScenarioId])
  useEffect(() => {
    effectivePhasesRef.current = effectivePhases
  }, [effectivePhases])

  /**
   * Version saves, one at a time and in order.
   *
   * Each drop is fire-and-forget from the drag's point of view, so two quick
   * drops would otherwise race: if the first save's response landed second it
   * would put the older payload back. Chaining them makes the server see the
   * drops in the order the user made them, and lets a version switch, copy
   * or delete wait for the last one.
   */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const saveSeqRef = useRef(new Map<string, number>())

  /** Replaces one version in the list with the server's copy. */
  const adoptScenario = useCallback(
    (saved: Scenario) => setScenarios((prev) => prev.map((s) => (s.id === saved.id ? saved : s))),
    [setScenarios]
  )

  /**
   * Writes the complete phase lists of the packages a drop touched into a
   * version (ship.save_version_phases). The list on screen is updated first,
   * optimistically (M-30: switching away and back must show the latest
   * moves, not the page-load copy), then the server's row is adopted unless
   * a newer save for the same version has been queued since.
   */
  const persistVersionPhases = useCallback(
    (scenarioId: string, packagePhases: ScenarioPhase[]) => {
      const seq = (saveSeqRef.current.get(scenarioId) ?? 0) + 1
      saveSeqRef.current.set(scenarioId, seq)

      setScenarios((prev) =>
        prev.map((s) =>
          s.id === scenarioId ? { ...s, payload: replacePackagePhases(s.payload, packagePhases) } : s
        )
      )

      const run = async () => {
        try {
          const saved = await saveVersionPhases(scenarioId, packagePhases)
          if (!isMountedRef.current) return
          setSaveError(null)
          if (saveSeqRef.current.get(scenarioId) === seq) adoptScenario(saved)
        } catch (err) {
          if (!isMountedRef.current) return
          setSaveError(err instanceof Error ? err.message : 'Failed to save the version.')
        }
      }

      const chained = saveChainRef.current.then(run)
      saveChainRef.current = chained
      return chained
    },
    [setScenarios, adoptScenario]
  )

  const persistPhases = useCallback(async (changed: ChunkPhase[]) => {
    try {
      await Promise.all(
        changed.map((phase) =>
          updateChunkPhase(phase.id, {
            startMonth: phase.startMonth,
            durationMonths: phase.durationMonths,
          })
        )
      )
      if (isMountedRef.current) setSaveError(null)
    } catch (err) {
      if (!isMountedRef.current) return
      setSaveError(err instanceof Error ? err.message : 'Failed to save the schedule.')
    }
  }, [])

  /* ------------------------------------------------------------ versions -- */

  function handleSelectVersion(key: string) {
    setSelectedKey(key)
    setDragPreview(null)
    writeStoredVersion(storageKey, key)
  }

  /** Runs a version-list change with the busy flag up and the last drop's
   *  save landed first (a copy must include it; a delete must not race it). */
  async function runVersionAction(action: () => Promise<void>, fallback: string) {
    if (!canEditBaseline) return
    setVersionBusy(true)
    try {
      await saveChainRef.current
      await action()
      if (isMountedRef.current) setSaveError(null)
    } catch (err) {
      if (isMountedRef.current) setSaveError(err instanceof Error ? err.message : fallback)
    } finally {
      if (isMountedRef.current) setVersionBusy(false)
    }
  }

  /** "New version" and "Duplicate": a copy of the version on screen. */
  function handleCreateVersion(name: string) {
    void runVersionAction(async () => {
      const created = await createVersion(project.id, name, activeScenarioId)
      if (!isMountedRef.current) return
      setScenarios((prev) => [...prev, created])
      handleSelectVersion(created.id)
    }, 'Could not create the version.')
  }

  function handleRenameVersion(name: string) {
    void runVersionAction(async () => {
      await renameVersion(project.id, activeScenarioId, name)
      if (!isMountedRef.current) return
      if (activeScenarioId) {
        setScenarios((prev) => prev.map((s) => (s.id === activeScenarioId ? { ...s, name } : s)))
      } else {
        setVersionData((prev) => ({ ...prev, liveName: name }))
      }
    }, 'Could not rename the version.')
  }

  /**
   * Deleting the version on screen. Any other version: its row goes. The
   * one held in the tables: the server moves another version into the
   * tables and removes that version's snapshot (ship.delete_version, one
   * transaction), so every row this screen loaded is re-read. Either way the
   * screen then shows the version in the tables.
   */
  function handleDeleteVersion() {
    void runVersionAction(async () => {
      if (activeScenarioId) {
        await deleteVersion(project.id, activeScenarioId)
        if (!isMountedRef.current) return
        setScenarios((prev) => prev.filter((s) => s.id !== activeScenarioId))
        handleSelectVersion(LIVE_VERSION_KEY)
        return
      }
      await deleteVersion(project.id, null)
      if (!isMountedRef.current) return
      handleSelectVersion(LIVE_VERSION_KEY)
      reloadVersions()
      reloadPhases()
      reloadDependencies()
      reloadCostSettings()
    }, 'Could not delete the version.')
  }

  /** ExportBar's PDF of a version other than the open one: open it, wait
   *  for it to be on screen, then the bar prints the page. */
  async function handlePrintVersion(key: string) {
    handleSelectVersion(key)
    await afterNextPaint()
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
   * the open version, so the bar tracks the cursor in every version. The
   * network write happens exactly once, on pointerup -- a write per pointer
   * event would put hundreds of round trips behind a single drag -- and not
   * at all when the bar ends where it started.
   *
   * Everything is measured against the schedule the user is LOOKING AT
   * (`effectivePhases`), never the rows in the tables. Inside another version
   * that is the difference between "move this bar" and "move this bar and
   * quietly put every other bar back where the tables have it" (M-05).
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
      startMonth: phase.startMonth,
      durationMonths: phase.durationMonths,
    }
    // Refuses a resize of a phase that starts past the last column (M-27).
    if (!canStartDrag(origin, horizonMonths)) return

    event.preventDefault()
    event.stopPropagation()

    const originX = event.clientX
    let latest: Placement = {
      startMonth: origin.startMonth,
      durationMonths: origin.durationMonths,
    }
    // Captured per drag, like the origin: the handler must not read a later
    // render's zoom or horizon mid-gesture.
    const unitMonths = monthsPerSlot
    const dragHorizonMonths = horizonMonths

    const onMove = (moveEvent: PointerEvent) => {
      // Snaps to whole columns of the current zoom -- a year at Year zoom, a
      // month at Month zoom -- and converts to months, which is what is
      // stored (D-1). A bar that sits mid-column keeps its offset.
      const deltaColumns = Math.round((moveEvent.clientX - originX) / CELL_WIDTH)
      const next = placementForDelta(origin, deltaColumns * unitMonths, dragHorizonMonths)
      // Most pointermoves land in the same column; skip the re-render.
      if (
        next.startMonth === latest.startMonth &&
        next.durationMonths === latest.durationMonths
      ) {
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
      // -- in a what-if, a plain click used to re-save the whole payload.
      if (isNoOpDrop(origin, latest)) return

      // The schedule on screen just before this drag: the effective phases
      // with the dragged bar put back at its origin (the ref also carries the
      // live preview, which is not "before").
      const before = effectivePhasesRef.current.map((row) =>
        row.id === origin.phaseId
          ? { ...row, startMonth: origin.startMonth, durationMonths: origin.durationMonths }
          : row
      )

      // Push any successor the move has left in violation. Never pulls one
      // earlier — slack is a decision the planner made.
      const propagate = DEPENDENCY_LINKS_ENABLED
        ? (rows: ChunkPhase[]) =>
            propagateDependencies(
              rows.map(toEnginePhase),
              versionView.dependencies.map(toEngineDependency)
            )
        : undefined

      const changed = changedPhasesForDrop(before, origin.phaseId, latest, propagate)
      if (changed.length === 0) return

      const scenarioId = activeScenarioIdRef.current
      if (scenarioId) {
        // Inside a version other than the one in the tables the drag must NOT
        // reach chunk_phases: it is saved to that version's payload. Whole
        // packages are written (lib/versions.ts packagePhasesForSave) from
        // the schedule on screen, so every earlier move survives and a
        // package that was showing its live phases becomes part of this
        // version from now on.
        void persistVersionPhases(scenarioId, packagePhasesForSave(before, changed))
        return
      }

      const changedById = new Map(changed.map((row) => [row.id, row]))
      setPhases((prev) =>
        prev.map((row) => {
          const moved = changedById.get(row.id)
          return moved
            ? { ...row, startMonth: moved.startMonth, durationMonths: moved.durationMonths }
            : row
        })
      )

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

  /** The viewer's own zoom. Writes nothing (D-1): no stored value, no price
   *  and no export depends on it. */
  function handleZoomChange(nextZoomLevel: number) {
    setViewZoomLevel(nextZoomLevel)
  }

  /* -------------------------------------------------------------- render -- */

  // Calendar span on top ("CY2026", "Jan–Mar 26"), fiscal span underneath
  // ("FY26–27", "FY26 Q3"): columns are calendar-anchored, so at Year zoom a
  // column is a calendar year and is no longer headed as one fiscal year
  // (M-26, D-11). Quarters are fiscal quarters.
  const slotLabels = useMemo(
    () => Array.from({ length: slotCount }, (_, i) => slotCalendarLabel(i, geometry)),
    [slotCount, geometry]
  )
  const fiscalLabels = useMemo(
    () => Array.from({ length: slotCount }, (_, i) => slotFiscalLabel(i, geometry)),
    [slotCount, geometry]
  )
  const describePhaseSpan = useCallback(
    (startMonth: number, durationMonths: number) =>
      describeSpan(startMonth, durationMonths, geometry),
    [geometry]
  )

  const loadError =
    chunksError ??
    lineItemsError ??
    phasesError ??
    dependenciesError ??
    timelineSettingsError ??
    costSettingsError ??
    graphsError

  const grandTotal = summaries.reduce((sum, s) => sum + s.totalEscalatedCost, 0)
  const grandBase = summaries.reduce((sum, s) => sum + s.totalBaseCost, 0)

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">Timeline</h2>

          <div className="flex flex-wrap items-center gap-2">
            <TimelineFilter view={timelineView} graphs={graphs} />
            {/* "they set it up in the timeline setting": graph setup lives
                here, beside the view filter (timeline/GraphSetup). Editors
                only; everyone else can still show/hide graphs in Filter. */}
            {canEditBaseline ? (
              <GraphSetupButton
                projectId={project.id}
                graphs={graphs}
                setGraphs={setGraphs}
                formFields={formFields}
                canEdit={canEditBaseline}
                onOpenFormBuilder={onOpenFormBuilder}
                openRequest={graphSetupRequest}
              />
            ) : null}
            {/* The two deliverables the client actually asked for: "we can make
                that an Excel spreadsheet pretty easily that we could give to the
                client. And then we would want a PDF view of the whole phasing
                schedule." Neither carries the cost model — see lib/export. */}
            {/* R8.4: a viewer does not get the deliverables. They are being
                shown the plan, not handed a copy of it to pass on. */}
            {permissions.isViewer ? null : (
              <ExportBar
                project={project}
                // "All equal, pick on export": the bar asks which version,
                // defaulting to the open one (M-24, 0031).
                versions={versions}
                activeVersionKey={activeKey}
                onPrintVersion={handlePrintVersion}
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

        {/* Versions replaced the what-if (migration 0031): every version is a
            peer, so this is a picker, not a "you are in a local copy" bar. */}
        <div className="no-print">
          <VersionBar
            versions={versions}
            activeKey={activeKey}
            canEdit={canEditBaseline}
            busy={versionBusy}
            onSelect={handleSelectVersion}
            onCreate={handleCreateVersion}
            onRename={handleRenameVersion}
            onDelete={handleDeleteVersion}
          />
        </div>
        {/* On paper the version has to be named: a printed plan travels. */}
        {versions.length > 1 ? (
          <div className="hidden text-sm font-semibold text-slate-900 print:block">
            Version: {activeVersionName}
          </div>
        ) : null}

        {unreadableCostCount > 0 ? (
          <div
            role="alert"
            className="rounded-[1.25rem] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {unreadableCostCount} item{unreadableCostCount === 1 ? ' has an' : 's have'} unreadable
            cost{unreadableCostCount === 1 ? '' : 's'}, counted as $0.
          </div>
        ) : null}

        {/* M-25: a missing year is shown, never silently replaced. */}
        {!timelineSettingsLoading &&
        !costSettingsLoading &&
        (timelineSettings.startCalendarYear === null || versionCostRow?.baseYear === null) ? (
          <div
            role="alert"
            className="rounded-[1.25rem] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {timelineSettings.startCalendarYear === null
              ? 'Timeline start year not set. '
              : ''}
            {versionCostRow?.baseYear === null ? 'Cost base year not set. ' : ''}
            Totals are provisional (using {standInYear}).
          </div>
        ) : null}

        {loadError || saveError ? (
          <div className="rounded-[1.25rem] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {saveError ?? loadError?.message ?? 'Something went wrong.'}
          </div>
        ) : null}

        {/* items-start: each card is as tall as its own content, not the
            tallest card in the row. */}
        <div className="grid items-start gap-4 xl:grid-cols-3">
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
                {zoomLabel(zoomLevel)}
              </div>
            </div>
            {/* Enabled for everyone, viewers included: it changes the view and
                nothing else (D-1). */}
            <input
              id="timeline-zoom"
              type="range"
              min={1}
              max={5}
              step={1}
              value={zoomLevel}
              onChange={(e) => handleZoomChange(Number(e.target.value))}
              className="mt-4 w-full accent-slate-900"
            />
            <div className="mt-3 grid grid-cols-5 text-center text-[10px] font-medium text-slate-500">
              {ZOOM_LEVELS.map((z) => (
                <span key={z.level}>{z.label}</span>
              ))}
            </div>
          </div>

          {/* Read-only summary; the full editor opens in a popup (CostModelBox). */}
          <CostModelBox
            projectId={project.id}
            canEdit={canEditBaseline}
            costRow={versionCostRow}
            graphs={graphs}
            onChanged={handleCostModelChanged}
            onOpenGraphSetup={canEditBaseline ? () => openGraphSetup(null) : undefined}
            // The popup edits the OPEN version's cost model (0031): the
            // tables for the version held there, the payload for any other.
            version={{
              name: activeVersionName,
              scenarioId: activeScenarioId,
              phases: versionView.phases,
              onSaved: adoptScenario,
            }}
          />
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
                <span className="font-medium">{violation.successor.name}</span> starts{' '}
                {monthLabel(violation.actualStart, geometry)} but cannot start before{' '}
                {monthLabel(Math.ceil(violation.requiredStart), geometry)} (
                {violation.dependency.depType} from {violation.predecessor.name})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* M-27: the horizon was stretched to cover a phase past the Timeline
          Length. Said out loud, because the grid is now longer than the
          setting says, and that is on purpose: those phases are in the
          headline, so they have to be in the columns and fiscal years too. */}
      {horizon.extended ? (
        <div
          role="status"
          className="rounded-[1.25rem] border border-sky-200 bg-sky-50 px-5 py-3 text-sm text-sky-900"
        >
          Extended to {geometry.years} years to fit phases past the{' '}
          {horizon.configuredYears}-year Timeline Length.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-sm font-medium text-slate-400">
          {chunksLoading ? 'Loading timeline…' : 'No packages yet.'}
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
              monthsPerSlot={monthsPerSlot}
              describeSpan={describePhaseSpan}
              hoveredSlot={hoveredSlot}
              // Admins and editors edit every version; consultants and viewers
              // switch between versions read-only (0031) -- never a grab
              // cursor followed by a refusal on pointer-up.
              readOnly={!canDrag}
              // The grid needs to tell "not allowed" apart from "not known
              // yet" -- both collapse to the same `readOnly` value while the
              // role RPC is in flight -- so it can hold its caption instead
              // of announcing a permission that has not resolved.
              permissionsLoading={permissions.loading}
              showPackages={showPackages}
              onHoverSlot={setHoveredSlot}
              onToggleExpand={handleToggleExpand}
              onSetAllExpanded={handleSetAllExpanded}
              onPhasePointerDown={handlePhasePointerDown}
              onSelectLink={() => undefined}
            />
            {/* One chart per graph (0032), stacked in sort_order, each on
                the grid's own x-scale. */}
            {showEnergy ? (
              <TimelineGraphs
                graphs={graphs}
                formFields={formFields}
                hiddenGraphs={hiddenGraphs}
                summaries={summaries}
                chunkProjects={chunkProjects}
                lineItemsById={lineItemMap}
                geometry={geometry}
                slotCount={slotCount}
                hoveredSlot={hoveredSlot}
                onOpenSetup={canEditBaseline ? openGraphSetup : undefined}
                onOpenMasterView={permissions.canContribute ? onOpenMasterView : undefined}
              />
            ) : null}
          </div>
        </div>
      )}

      {/* Monthly resolution, fiscal quarters (M-26, D-11): the same figures as
          the Excel Annual Cost Summary, at every zoom. Which strip shows is a
          per-project view setting; both read `fiscalTotals`. */}
      {costBreakdown !== 'none' && fiscalTotals.length > 0 ? (
        <div className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-950">
            {costBreakdown === 'quarter' ? 'By fiscal quarter' : 'By fiscal year'}
          </h3>
          {costBreakdown === 'quarter' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {fiscalQuarters.map((q) => (
                <div
                  key={`${q.fiscalYear}-${q.quarter}`}
                  data-fiscal-year={q.fiscalYear}
                  data-fiscal-quarter={q.quarter}
                  className="rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {formatFiscalYear(q.fiscalYear)} Q{q.quarter}
                  </div>
                  <div className="text-sm font-semibold text-slate-900">
                    {q.escalatedTotal > 0 ? formatCurrency(q.escalatedTotal) : '—'}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {fiscalTotals.map((year) => (
                <div
                  key={year.fiscalYear}
                  data-fiscal-year={year.fiscalYear}
                  className="rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {formatFiscalYear(year.fiscalYear)}
                  </div>
                  <div className="text-sm font-semibold text-slate-900">
                    {formatCurrency(year.escalatedTotal)}
                  </div>
                  {year.escalatedTotal > 0 ? (
                    <div className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-slate-500">
                      {year.quarters.map((q) => (
                        <span key={q.quarter}>
                          Q{q.quarter} {q.escalatedTotal > 0 ? formatCurrency(q.escalatedTotal) : '—'}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
