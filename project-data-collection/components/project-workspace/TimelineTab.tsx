'use client'

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { formatCurrency, parseCostInput, parseQuantityInput } from '@/lib/costs'
import {
  getChunkProjectsForProject,
  getLineItemsForProject,
  getTimelineSettingsForProject,
  updateChunkProject,
  updateTimelineSettingsForProject,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import {
  ChunkProject,
  ChunkTimelineSegment,
  LineItem,
  Project,
  ProjectTimelineSettings,
  TimelineInterval,
} from '@/lib/types'

const SETTINGS_PERSIST_DEBOUNCE_MS = 400

type Props = {
  project: Project
}

type ActiveInteraction = {
  chunkId: string
  segmentId: string
  mode: 'move' | 'resize-start' | 'resize-end'
  startX: number
  initialStart: number
  initialDuration: number
}

const CELL_WIDTH = 92
const LABEL_COLUMN_WIDTH = 300

const ZOOM_LEVELS: Array<{ level: number; interval: TimelineInterval; label: string }> = [
  { level: 1, interval: '5-yearly', label: '5 year' },
  { level: 2, interval: '3-yearly', label: '3 year' },
  { level: 3, interval: 'yearly', label: 'Year' },
  { level: 4, interval: 'quarterly', label: 'Quarter' },
  { level: 5, interval: 'monthly', label: 'Month' },
]

function getIntervalForZoom(zoomLevel: number) {
  return (
    ZOOM_LEVELS.find((option) => option.level === zoomLevel)?.interval ||
    ZOOM_LEVELS[2].interval
  )
}

function getZoomLabel(zoomLevel: number) {
  return ZOOM_LEVELS.find((option) => option.level === zoomLevel)?.label || ZOOM_LEVELS[2].label
}

function getSlotCount(years: number, interval: TimelineInterval) {
  switch (interval) {
    case 'monthly':
      return years * 12
    case 'quarterly':
      return years * 4
    case 'yearly':
      return years
    case 'bi-yearly':
      return Math.ceil(years / 2)
    case '3-yearly':
      return Math.ceil(years / 3)
    case '5-yearly':
      return Math.ceil(years / 5)
    default:
      return years
  }
}

function getSlotStartYear(index: number, interval: TimelineInterval) {
  switch (interval) {
    case 'monthly':
      return index / 12
    case 'quarterly':
      return index / 4
    case 'yearly':
      return index
    case 'bi-yearly':
      return index * 2
    case '3-yearly':
      return index * 3
    case '5-yearly':
      return index * 5
    default:
      return index
  }
}

function getSlotLabel(index: number, interval: TimelineInterval, years: number) {
  switch (interval) {
    case 'monthly': {
      const year = Math.floor(index / 12) + 1
      const month = (index % 12) + 1
      return `Y${year} M${month}`
    }
    case 'quarterly': {
      const year = Math.floor(index / 4) + 1
      const quarter = (index % 4) + 1
      return `Y${year} Q${quarter}`
    }
    case 'yearly':
      return `Year ${index + 1}`
    case 'bi-yearly': {
      const start = index * 2 + 1
      const end = Math.min(start + 1, years)
      return `Y${start}-${end}`
    }
    case '3-yearly': {
      const start = index * 3 + 1
      const end = Math.min(start + 2, years)
      return `Y${start}-${end}`
    }
    case '5-yearly': {
      const start = index * 5 + 1
      const end = Math.min(start + 4, years)
      return `Y${start}-${end}`
    }
    default:
      return `${index + 1}`
  }
}

function getEscalationFactor(slotStartYear: number, percent: number, everyYears: number) {
  if (percent <= 0 || everyYears <= 0) return 1

  const escalationSteps = Math.floor(slotStartYear / everyYears)
  return (1 + percent / 100) ** escalationSteps
}

function normalizeSegment(segment: ChunkTimelineSegment) {
  return {
    ...segment,
    start: Math.max(0, Math.round(segment.start)),
    duration: Math.max(1, Math.round(segment.duration)),
  }
}

function clampSingleSegment(start: number, duration: number, totalSlots: number) {
  if (totalSlots <= 0) {
    return { start: 0, duration: 1 }
  }

  const safeDuration = Math.min(Math.max(Math.round(duration), 1), totalSlots)
  const maxStart = Math.max(0, totalSlots - safeDuration)

  return {
    start: Math.min(Math.max(Math.round(start), 0), maxStart),
    duration: safeDuration,
  }
}

function clampSegmentAgainstSibling(
  start: number,
  duration: number,
  sibling: ChunkTimelineSegment | undefined,
  initialStart: number,
  totalSlots: number
) {
  const clamped = clampSingleSegment(start, duration, totalSlots)
  if (!sibling) return clamped

  const siblingEnd = sibling.start + sibling.duration
  const beforeSibling = initialStart <= sibling.start

  if (beforeSibling) {
    const maxStart = Math.max(0, sibling.start - clamped.duration)
    return {
      start: Math.min(clamped.start, maxStart),
      duration: clamped.duration,
    }
  }

  const minStart = siblingEnd
  return {
    start: Math.max(clamped.start, minStart),
    duration: clamped.duration,
  }
}

function getChunkLineItemTotal(item: LineItem, quantity: string) {
  return parseCostInput(item.estimatedFirstCost) * parseQuantityInput(quantity)
}

function sortSegments(segments: ChunkTimelineSegment[]) {
  return [...segments].map(normalizeSegment).sort((a, b) => a.start - b.start)
}

const DEFAULT_TIMELINE_SETTINGS: Omit<ProjectTimelineSettings, 'projectId'> = {
  years: 10,
  interval: 'yearly',
  zoomLevel: 3,
  escalationPercent: 0,
  escalationEveryYears: 1,
}

export default function TimelineTab({ project }: Props) {
  const {
    data: chunkProjects,
    setData: setChunkProjects,
    loading: chunkProjectsLoading,
    error: chunkProjectsError,
  } = useAsyncData<ChunkProject[]>(
    () => getChunkProjectsForProject(project.id),
    [project.id],
    []
  )
  const {
    data: lineItems,
    loading: lineItemsLoading,
    error: lineItemsError,
  } = useAsyncData<LineItem[]>(() => getLineItemsForProject(project.id), [project.id], [])
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
  const [activeInteraction, setActiveInteraction] = useState<ActiveInteraction | null>(null)
  const [segmentSaveError, setSegmentSaveError] = useState<string | null>(null)
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null)
  const chunkProjectsRef = useRef(chunkProjects)

  const isMountedRef = useRef(true)
  const pendingSettingsUpdateRef = useRef<Partial<ProjectTimelineSettings>>({})
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current)
    }
  }, [])

  useEffect(() => {
    chunkProjectsRef.current = chunkProjects
  }, [chunkProjects])

  const timelineInterval = useMemo(
    () => getIntervalForZoom(timelineSettings.zoomLevel),
    [timelineSettings.zoomLevel]
  )

  const slotCount = useMemo(
    () => getSlotCount(timelineSettings.years, timelineInterval),
    [timelineInterval, timelineSettings.years]
  )

  const lineItemMap = useMemo(
    () => new Map(lineItems.map((item) => [item.id, item])),
    [lineItems]
  )

  const chunkRows = useMemo(() => {
    return chunkProjects
      .map((chunk) => {
        const linkedItems = chunk.itemLinks
          .map((link) => ({
            link,
            item: lineItemMap.get(link.lineItemId),
          }))
          .filter(
            (entry): entry is { link: ChunkProject['itemLinks'][number]; item: LineItem } =>
              Boolean(entry.item)
          )

        const totalCost = linkedItems.reduce(
          (sum, entry) => sum + getChunkLineItemTotal(entry.item, entry.link.quantity),
          0
        )

        const segments = sortSegments(chunk.timelineSegments)

        return {
          chunk,
          linkedItems,
          totalCost,
          segments,
          totalTimelineSlots: Math.max(
            1,
            segments.reduce((sum, segment) => sum + segment.duration, 0)
          ),
        }
      })
      .sort((a, b) => {
        if (a.segments[0]?.start !== b.segments[0]?.start) {
          return (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0)
        }
        return a.chunk.name.localeCompare(b.chunk.name)
      })
  }, [chunkProjects, lineItemMap])

  const slotTotals = useMemo(() => {
    const totals = Array.from({ length: slotCount }, () => 0)

    chunkRows.forEach((row) => {
      if (row.totalCost <= 0 || slotCount <= 0) return

      const costPerSlot = row.totalCost / row.totalTimelineSlots

      row.segments.forEach((segment) => {
        for (let slotIndex = segment.start; slotIndex < segment.start + segment.duration; slotIndex += 1) {
          if (slotIndex >= 0 && slotIndex < slotCount) {
            totals[slotIndex] += costPerSlot
          }
        }
      })
    })

    return totals
  }, [chunkRows, slotCount])

  const slotCostDetails = useMemo(() => {
    return slotTotals.map((baseTotal, index) => {
      const slotStartYear = getSlotStartYear(index, timelineInterval)
      const escalationFactor = getEscalationFactor(
        slotStartYear,
        timelineSettings.escalationPercent,
        timelineSettings.escalationEveryYears
      )
      const escalatedTotal = baseTotal * escalationFactor

      return {
        baseTotal,
        escalationAmount: escalatedTotal - baseTotal,
        escalatedTotal,
      }
    })
  }, [
    slotTotals,
    timelineInterval,
    timelineSettings.escalationEveryYears,
    timelineSettings.escalationPercent,
  ])

  const timelineWidth = Math.max(slotCount * CELL_WIDTH, CELL_WIDTH)

  // Persistence for the timeline settings sliders is debounced (trailing, ~400ms) so a drag
  // doesn't fire a write per pointer event against the database. The local state update above
  // each call site happens synchronously and immediately, so the UI stays responsive at 60fps —
  // only the network write is delayed and coalesced.
  async function flushTimelineSettingsPersist() {
    const updates = pendingSettingsUpdateRef.current
    pendingSettingsUpdateRef.current = {}
    if (Object.keys(updates).length === 0) return

    try {
      await updateTimelineSettingsForProject(project.id, updates)
      if (!isMountedRef.current) return
      setSettingsSaveError(null)
    } catch (err) {
      if (!isMountedRef.current) return
      setSettingsSaveError(
        err instanceof Error ? err.message : 'Failed to save timeline settings.'
      )
    }
  }

  function scheduleTimelineSettingsPersist(updates: Partial<ProjectTimelineSettings>) {
    pendingSettingsUpdateRef.current = { ...pendingSettingsUpdateRef.current, ...updates }

    if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current)

    settingsTimerRef.current = setTimeout(() => {
      settingsTimerRef.current = null
      void flushTimelineSettingsPersist()
    }, SETTINGS_PERSIST_DEBOUNCE_MS)
  }

  function handleYearsChange(years: number) {
    setTimelineSettings((prev) => ({ ...prev, years }))
    scheduleTimelineSettingsPersist({ years })
  }

  function handleZoomChange(zoomLevel: number) {
    const interval = getIntervalForZoom(zoomLevel)
    setTimelineSettings((prev) => ({ ...prev, zoomLevel, interval }))
    scheduleTimelineSettingsPersist({ zoomLevel, interval })
  }

  function handleEscalationPercentChange(escalationPercent: number) {
    setTimelineSettings((prev) => ({ ...prev, escalationPercent }))
    scheduleTimelineSettingsPersist({ escalationPercent })
  }

  function handleEscalationEveryYearsChange(escalationEveryYears: number) {
    setTimelineSettings((prev) => ({ ...prev, escalationEveryYears }))
    scheduleTimelineSettingsPersist({ escalationEveryYears })
  }

  function updateChunkSegments(
    chunkId: string,
    updater: (segments: ChunkTimelineSegment[]) => ChunkTimelineSegment[]
  ) {
    let updatedChunk: ChunkProject | undefined

    setChunkProjects((prev) => {
      const next = prev.map((chunk) => {
        if (chunk.id !== chunkId) return chunk

        const timelineSegments = sortSegments(updater(chunk.timelineSegments))
        const first = timelineSegments[0] || { start: 0, duration: 1 }

        return {
          ...chunk,
          timelineSegments,
          timelineStart: first.start,
          timelineDuration: first.duration,
        }
      })

      updatedChunk = next.find((chunk) => chunk.id === chunkId)
      return next
    })

    if (updatedChunk) {
      const { timelineSegments, timelineStart, timelineDuration } = updatedChunk

      setSegmentSaveError(null)
      updateChunkProject(chunkId, { timelineSegments, timelineStart, timelineDuration }).catch(
        (err) => {
          if (!isMountedRef.current) return
          setSegmentSaveError(
            err instanceof Error ? err.message : 'Failed to save package timeline.'
          )
        }
      )
    }
  }

  function handleSplitChunk(chunk: ChunkProject) {
    if (chunk.timelineSegments.length >= 2 || slotCount <= 1) return

    const source = normalizeSegment(chunk.timelineSegments[0] || {
      id: `${chunk.id}-segment-1`,
      start: 0,
      duration: 1,
    })

    const firstDuration = Math.max(1, Math.ceil(source.duration / 2))
    const secondDuration = Math.max(1, source.duration - firstDuration)
    const secondStart = Math.min(source.start + firstDuration + 1, Math.max(slotCount - secondDuration, 0))

    updateChunkSegments(chunk.id, () => [
      {
        id: source.id,
        start: source.start,
        duration: firstDuration,
      },
      {
        id: `${chunk.id}-segment-2`,
        start: secondStart,
        duration: secondDuration,
      },
    ])
  }

  function handleMergeChunk(chunk: ChunkProject) {
    if (chunk.timelineSegments.length <= 1) return

    const sorted = sortSegments(chunk.timelineSegments)
    const start = sorted[0].start
    const end = Math.max(...sorted.map((segment) => segment.start + segment.duration))

    updateChunkSegments(chunk.id, () => [
      {
        id: `${chunk.id}-segment-1`,
        start,
        duration: end - start,
      },
    ])
  }

  function startInteraction(
    event: ReactPointerEvent<HTMLDivElement>,
    chunkId: string,
    segmentId: string,
    mode: ActiveInteraction['mode'],
    segment: ChunkTimelineSegment
  ) {
    if (slotCount <= 0) return

    event.preventDefault()
    event.stopPropagation()

    setActiveInteraction({
      chunkId,
      segmentId,
      mode,
      startX: event.clientX,
      initialStart: segment.start,
      initialDuration: segment.duration,
    })

    const onMove = (moveEvent: PointerEvent) => {
      const deltaSlots = Math.round((moveEvent.clientX - event.clientX) / CELL_WIDTH)

      setChunkProjects((prev) =>
        prev.map((chunk) => {
          if (chunk.id !== chunkId) return chunk

          const currentSegments = sortSegments(chunk.timelineSegments)
          const sibling = currentSegments.find((item) => item.id !== segmentId)

          const timelineSegments = currentSegments.map((currentSegment) => {
            if (currentSegment.id !== segmentId) return currentSegment

            if (mode === 'move') {
              const candidateStart = segment.start + deltaSlots
              const next = clampSegmentAgainstSibling(
                candidateStart,
                segment.duration,
                sibling,
                segment.start,
                slotCount
              )
              return { ...currentSegment, ...next }
            }

            if (mode === 'resize-start') {
              const nextStart = segment.start + deltaSlots
              const nextDuration = segment.duration - deltaSlots
              const next = clampSegmentAgainstSibling(
                nextStart,
                nextDuration,
                sibling,
                segment.start,
                slotCount
              )
              return { ...currentSegment, ...next }
            }

            const next = clampSegmentAgainstSibling(
              segment.start,
              segment.duration + deltaSlots,
              sibling,
              segment.start,
              slotCount
            )
            return { ...currentSegment, ...next }
          })

          const sorted = sortSegments(timelineSegments)
          const first = sorted[0] || { start: 0, duration: 1 }

          return {
            ...chunk,
            timelineSegments: sorted,
            timelineStart: first.start,
            timelineDuration: first.duration,
          }
        })
      )
    }

    const onUp = () => {
      // The drag/resize itself only ever touches local state via onMove above (setChunkProjects,
      // called on every pointermove). The network write happens exactly once here, on pointer-up.
      const current = chunkProjectsRef.current.find((chunk) => chunk.id === chunkId)
      if (current) {
        setSegmentSaveError(null)
        updateChunkProject(chunkId, {
          timelineSegments: current.timelineSegments,
          timelineStart: current.timelineStart,
          timelineDuration: current.timelineDuration,
        }).catch((err) => {
          if (!isMountedRef.current) return
          setSegmentSaveError(
            err instanceof Error ? err.message : 'Failed to save package timeline.'
          )
        })
      }

      setActiveInteraction(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">Timeline</h2>
          <p className="mt-1 text-sm text-slate-500">
            Map package chunks across a horizontal timeline, split them into two phases, and
            see base and escalated cost rolled up by timeline bucket.
          </p>
          {(chunkProjectsLoading || lineItemsLoading || timelineSettingsLoading) &&
          chunkProjects.length === 0 ? (
            <p className="mt-2 text-xs font-medium text-slate-400">Loading timeline…</p>
          ) : null}
        </div>

        {chunkProjectsError ||
        lineItemsError ||
        timelineSettingsError ||
        segmentSaveError ||
        settingsSaveError ? (
          <div className="rounded-[1.25rem] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {segmentSaveError ||
              settingsSaveError ||
              chunkProjectsError?.message ||
              lineItemsError?.message ||
              timelineSettingsError?.message ||
              'Something went wrong.'}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1fr_1fr_1.1fr]">
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
              min={0}
              max={50}
              step={1}
              value={timelineSettings.years}
              onChange={(event) => handleYearsChange(Number(event.target.value))}
              className="mt-4 w-full accent-slate-900"
            />
          </div>

          <div className="rounded-[1.25rem] border border-slate-200 bg-slate-50/80 p-4">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="timeline-zoom" className="text-sm font-medium text-slate-700">
                Zoom
              </label>
              <div className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-900">
                {getZoomLabel(timelineSettings.zoomLevel)}
              </div>
            </div>

            <input
              id="timeline-zoom"
              type="range"
              min={1}
              max={5}
              step={1}
              value={timelineSettings.zoomLevel}
              onChange={(event) => handleZoomChange(Number(event.target.value))}
              className="mt-4 w-full accent-slate-900"
            />

            <div className="mt-3 grid grid-cols-5 text-center text-[10px] font-medium text-slate-500">
              {ZOOM_LEVELS.map((option) => (
                <span key={option.level}>{option.label}</span>
              ))}
            </div>
          </div>

          <div className="rounded-[1.25rem] border border-slate-200 bg-slate-50/80 p-4">
            <div className="text-sm font-medium text-slate-700">Escalation</div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-500">Increase</span>
                <div className="mt-1 flex items-center rounded-2xl border border-slate-200 bg-white px-3 py-2 focus-within:border-slate-900">
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={timelineSettings.escalationPercent}
                    onChange={(event) =>
                      handleEscalationPercentChange(Math.max(0, Number(event.target.value) || 0))
                    }
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  />
                  <span className="text-sm font-semibold text-slate-500">%</span>
                </div>
              </label>

              <label className="block">
                <span className="text-xs font-medium text-slate-500">Every</span>
                <div className="mt-1 flex items-center rounded-2xl border border-slate-200 bg-white px-3 py-2 focus-within:border-slate-900">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={timelineSettings.escalationEveryYears}
                    onChange={(event) =>
                      handleEscalationEveryYearsChange(
                        Math.max(1, Math.round(Number(event.target.value) || 1))
                      )
                    }
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  />
                  <span className="text-sm font-semibold text-slate-500">yrs</span>
                </div>
              </label>
            </div>
          </div>
        </div>
      </div>

      {chunkRows.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-sm font-medium text-slate-400">
          Create packages in Chunking before scheduling them on the timeline.
        </div>
      ) : slotCount === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-sm font-medium text-slate-500">
          Increase the timeline length above 0 years to place packages.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <div style={{ minWidth: LABEL_COLUMN_WIDTH + timelineWidth }}>
              <div
                className="grid border-b border-slate-200 bg-slate-100"
                style={{ gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px ${timelineWidth}px` }}
              >
                <div className="border-r border-slate-200 px-5 py-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Packages
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    Drag a box to move it. Drag the left or right edge to resize it.
                  </div>
                </div>

                <div>
                  <div
                    className="grid border-b border-slate-200"
                    style={{ gridTemplateColumns: `repeat(${slotCount}, ${CELL_WIDTH}px)` }}
                  >
                    {Array.from({ length: slotCount }, (_, index) => (
                      <div
                        key={`label-${index}`}
                        className="border-r border-slate-200 px-2 py-3 text-center text-[11px] font-semibold text-slate-700"
                      >
                        {getSlotLabel(index, timelineInterval, timelineSettings.years)}
                      </div>
                    ))}
                  </div>

                  <div
                    className="grid"
                    style={{ gridTemplateColumns: `repeat(${slotCount}, ${CELL_WIDTH}px)` }}
                  >
                    {slotCostDetails.map((detail, index) => {
                      const tooltip = [
                        `Base total: ${formatCurrency(detail.baseTotal)}`,
                        `Escalation: ${formatCurrency(detail.escalationAmount)}`,
                        `Total + escalation: ${formatCurrency(detail.escalatedTotal)}`,
                      ].join('\n')

                      return (
                        <div
                          key={`cost-${index}`}
                          title={tooltip}
                          className="border-r border-slate-200 px-2 py-3 text-center text-[11px] font-medium text-emerald-700"
                        >
                          {formatCurrency(detail.escalatedTotal)}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              {chunkRows.map((row) => (
                <div
                  key={row.chunk.id}
                  className="grid border-b border-slate-200 last:border-b-0"
                  style={{ gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px ${timelineWidth}px` }}
                >
                  <div className="border-r border-slate-200 bg-white px-5 py-4">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-slate-950 px-2.5 py-1 text-[11px] font-semibold text-white">
                        {row.chunk.chunkNumber}
                      </span>
                      <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                        {formatCurrency(row.totalCost)}
                      </span>
                    </div>
                    <div className="mt-3 text-sm font-semibold text-slate-950">
                      {row.chunk.name}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {row.linkedItems.length} line items
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {row.chunk.timelineSegments.length < 2 ? (
                        <button
                          type="button"
                          onClick={() => handleSplitChunk(row.chunk)}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700"
                        >
                          Split
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleMergeChunk(row.chunk)}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700"
                        >
                          Merge
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    className="relative bg-white"
                    style={{
                      minHeight: 92,
                      backgroundImage:
                        'repeating-linear-gradient(to right, transparent 0, transparent 91px, rgba(148,163,184,0.24) 91px, rgba(148,163,184,0.24) 92px)',
                    }}
                  >
                    {row.segments.map((segment) => {
                      const boxLeft = segment.start * CELL_WIDTH + 4
                      const boxWidth = segment.duration * CELL_WIDTH - 8
                      const isActive =
                        activeInteraction?.chunkId === row.chunk.id &&
                        activeInteraction.segmentId === segment.id

                      return (
                        <div
                          key={segment.id}
                          className={`absolute top-1/2 flex h-12 -translate-y-1/2 items-center rounded-[1rem] border border-sky-300 bg-[linear-gradient(135deg,rgba(15,23,42,0.92)_0%,rgba(30,41,59,0.90)_50%,rgba(14,116,144,0.88)_100%)] px-3 text-white shadow-lg ${
                            isActive ? 'cursor-grabbing ring-2 ring-sky-200' : 'cursor-grab'
                          }`}
                          style={{
                            left: boxLeft,
                            width: Math.max(boxWidth, CELL_WIDTH - 8),
                          }}
                          onPointerDown={(event) =>
                            startInteraction(event, row.chunk.id, segment.id, 'move', segment)
                          }
                        >
                          <div
                            className="absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize rounded-l-[1rem]"
                            onPointerDown={(event) =>
                              startInteraction(event, row.chunk.id, segment.id, 'resize-start', segment)
                            }
                          />
                          <div className="min-w-0 flex-1 px-1">
                            <div className="truncate text-sm font-semibold">{row.chunk.name}</div>
                            <div className="mt-0.5 text-[11px] text-white/75">
                              {formatCurrency(row.totalCost / row.totalTimelineSlots)} / slot
                            </div>
                          </div>
                          <div
                            className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize rounded-r-[1rem]"
                            onPointerDown={(event) =>
                              startInteraction(event, row.chunk.id, segment.id, 'resize-end', segment)
                            }
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
