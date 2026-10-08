'use client'

import { Fragment, type PointerEvent as ReactPointerEvent } from 'react'
import { formatCurrency } from '@/lib/costs'
import type { PackageSummary, SlotCost } from '@/lib/cost-model'
import type { ChunkPhase } from '@/lib/types'
import {
  BAR_HEIGHT,
  CELL_WIDTH,
  LABEL_COLUMN_WIDTH,
  PACKAGE_ROW_HEIGHT,
  PHASE_ROW_HEIGHT,
  PHASE_STYLES,
  barRect,
} from './layout'
import DependencyArrows, { type ArrowLink } from './DependencyArrows'

/**
 * The grid: column headers, package rows, phase bars, and the dependency
 * overlay on top of them.
 *
 * Presentational. Every number it draws is computed by lib/cost-model.ts and
 * passed in; every interaction is reported upward. That split is what lets the
 * Excel and PDF exports render the same figures without importing a React
 * component, and what lets the cost engine be unit-tested without a DOM.
 */

export type RowLayout = {
  summary: PackageSummary
  phases: ChunkPhase[]
  expanded: boolean
  /** y offset of this package's block from the top of the body. */
  top: number
  height: number
}

export type DragMode = 'move' | 'resize-start' | 'resize-end'

type Props = {
  rows: RowLayout[]
  slotCosts: SlotCost[]
  slotLabels: string[]
  fiscalYearLabels: string[]
  links: ArrowLink[]
  bodyHeight: number
  slotCount: number
  hoveredSlot: number | null
  readOnly: boolean
  /**
   * `readOnly` alone cannot say WHY dragging is off: it is
   * `!permissions.canEdit`, which is also true while the role RPC has not
   * answered yet (see project-role.ts). Without this, the caption below
   * tells a soon-to-be editor "ask an editor for access" for a beat, which
   * is wrong, and tells an actual viewer the same thing a moment early,
   * which reads as flicker. This lets the caption say "still checking"
   * instead of guessing.
   */
  permissionsLoading: boolean
  onHoverSlot: (slot: number | null) => void
  onToggleExpand: (chunkProjectId: string) => void
  onSetAllExpanded: (open: boolean) => void
  onPhasePointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    phase: ChunkPhase,
    mode: DragMode
  ) => void
  onSelectLink: (linkId: string) => void
}

/** y offset of a phase's bar within the body, given its package's block. */
export function phaseRowTop(row: RowLayout, phaseIndex: number): number {
  return row.top + PACKAGE_ROW_HEIGHT + phaseIndex * PHASE_ROW_HEIGHT
}

export default function TimelineGrid({
  rows,
  slotCosts,
  slotLabels,
  fiscalYearLabels,
  links,
  bodyHeight,
  slotCount,
  hoveredSlot,
  readOnly,
  permissionsLoading,
  onHoverSlot,
  onToggleExpand,
  onSetAllExpanded,
  onPhasePointerDown,
  onSelectLink,
}: Props) {
  const width = Math.max(slotCount * CELL_WIDTH, CELL_WIDTH)

  return (
    <div style={{ minWidth: LABEL_COLUMN_WIDTH + width }}>
      {/* ------------------------------------------------------- header -- */}
      <div
        className="grid border-b border-slate-200 bg-slate-100"
        style={{ gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px ${width}px` }}
      >
        <div className="border-r border-slate-200 px-5 py-4">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Packages
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {permissionsLoading
              ? 'Checking your access…'
              : readOnly
                ? 'Read-only. Ask an editor for access to reschedule.'
                : 'Click a package to open its phases, then drag a phase bar to move it or drag its edge to resize.'}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => onSetAllExpanded(true)}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-slate-400"
            >
              Open all
            </button>
            <button
              type="button"
              onClick={() => onSetAllExpanded(false)}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-slate-400"
            >
              Close all
            </button>
          </div>
        </div>

        <div>
          <div
            className="grid border-b border-slate-200"
            style={{ gridTemplateColumns: `repeat(${slotCount}, ${CELL_WIDTH}px)` }}
          >
            {slotLabels.map((label, index) => (
              <div
                key={`label-${index}`}
                className="border-r border-slate-200 px-2 pt-3 text-center text-[11px] font-semibold text-slate-700"
              >
                {label}
                {/* The fiscal year is what the client actually plans in — "I
                    think we can move the east wing renovations to fiscal year
                    '33". The slot label above it is the tool's own coordinate
                    system, which nobody outside this app thinks in. */}
                <div className="pb-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  {fiscalYearLabels[index]}
                </div>
              </div>
            ))}
          </div>

          <div
            className="grid"
            style={{ gridTemplateColumns: `repeat(${slotCount}, ${CELL_WIDTH}px)` }}
          >
            {slotCosts.map((cost, index) => (
              <div
                key={`cost-${index}`}
                onMouseEnter={() => onHoverSlot(index)}
                onMouseLeave={() => onHoverSlot(null)}
                title={[
                  `Base: ${formatCurrency(cost.baseTotal)}`,
                  `Escalation: ${formatCurrency(cost.escalationAmount)}`,
                  `Total: ${formatCurrency(cost.escalatedTotal)}`,
                ].join('\n')}
                className={`border-r border-slate-200 px-2 py-3 text-center text-[11px] font-medium ${
                  hoveredSlot === index ? 'bg-teal-50 text-teal-800' : 'text-emerald-700'
                }`}
              >
                {cost.escalatedTotal > 0 ? formatCurrency(cost.escalatedTotal) : '—'}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- body -- */}
      <div className="relative">
        {rows.map((row) => {
          const { summary, phases, expanded } = row
          const pkg = summary.input

          // Collapsed packages still need a bar, because the package is the
          // unit the client talks about ("the wings project is $3 million").
          // It spans the full extent of its phases.
          const spanStart = phases.length
            ? Math.min(...phases.map((p) => p.startSlot))
            : 0
          const spanEnd = phases.length
            ? Math.max(...phases.map((p) => p.startSlot + p.durationSlots))
            : 1

          return (
            <Fragment key={pkg.chunkProjectId}>
              <div
                className="grid border-b border-slate-200"
                style={{
                  gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px ${width}px`,
                  height: PACKAGE_ROW_HEIGHT,
                }}
              >
                <div className="overflow-hidden border-r border-slate-200 bg-white px-5 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onToggleExpand(pkg.chunkProjectId)}
                      aria-expanded={expanded}
                      className="rounded-full bg-slate-950 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-slate-800"
                    >
                      {expanded ? '▾' : '▸'} {pkg.chunkNumber}
                    </button>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                      {formatCurrency(summary.totalEscalatedCost)}
                    </span>
                  </div>

                  <div className="mt-2 text-sm font-semibold text-slate-950">{pkg.name}</div>

                  <div className="mt-1 text-xs text-slate-500">
                    ECC {formatCurrency(summary.eccBase)} · TPC{' '}
                    {formatCurrency(summary.tpcBase)}
                  </div>

                  {/* Surfaced, never auto-corrected. Silently rescaling a
                      number a cost estimator typed is worse than showing them
                      it is wrong. */}
                  {summary.allocationIsIncomplete ? (
                    <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900">
                      Phases total {summary.allocatedPct.toFixed(1)}%, not 100%
                    </div>
                  ) : null}
                </div>

                <div
                  className="relative bg-white"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${
                      CELL_WIDTH - 1
                    }px, rgba(148,163,184,0.24) ${CELL_WIDTH - 1}px, rgba(148,163,184,0.24) ${CELL_WIDTH}px)`,
                  }}
                >
                  {/* The collapsed bar is a summary, not a drag target -- the
                      phases are what get scheduled. It used to say "expand to
                      schedule" without being clickable, which read as a broken
                      drag; now clicking it opens the phases. */}
                  {!expanded && phases.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => onToggleExpand(pkg.chunkProjectId)}
                      aria-expanded={false}
                      className="absolute flex cursor-pointer items-center rounded-[0.9rem] border border-slate-700 bg-[linear-gradient(135deg,rgba(15,23,42,0.94)_0%,rgba(30,41,59,0.92)_50%,rgba(14,116,144,0.9)_100%)] px-3 text-left text-white shadow-lg transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
                      style={{
                        ...barRect(spanStart, spanEnd - spanStart, PACKAGE_ROW_HEIGHT),
                        position: 'absolute',
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold">{pkg.name}</div>
                        <div className="truncate text-[10px] text-white/70">
                          {phases.length} phases ·{' '}
                          {readOnly ? 'click to show phases' : 'click to show and move phases'}
                        </div>
                      </div>
                    </button>
                  ) : null}

                  {/* While open, the package row keeps an outline of the whole
                      package so it is obvious what the phases below belong to
                      and how to fold them back into one bar. */}
                  {expanded && phases.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => onToggleExpand(pkg.chunkProjectId)}
                      aria-expanded={true}
                      className="absolute flex cursor-pointer items-center rounded-[0.9rem] border-2 border-dashed border-slate-400 bg-slate-50/80 px-3 text-left text-slate-700 transition hover:border-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
                      style={{
                        ...barRect(spanStart, spanEnd - spanStart, PACKAGE_ROW_HEIGHT),
                        position: 'absolute',
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold">{pkg.name}</div>
                        <div className="truncate text-[10px] text-slate-500">
                          Whole package · click to close back into one bar
                        </div>
                      </div>
                    </button>
                  ) : null}
                </div>
              </div>

              {expanded
                ? phases.map((phase) => {
                    const style = PHASE_STYLES[phase.kind]
                    const phaseCost = summary.phases.find((p) => p.phase.id === phase.id)
                    const rect = barRect(phase.startSlot, phase.durationSlots, PHASE_ROW_HEIGHT)

                    return (
                      <div
                        key={phase.id}
                        className="grid border-b border-slate-100 last:border-b-0"
                        style={{
                          gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px ${width}px`,
                          height: PHASE_ROW_HEIGHT,
                        }}
                      >
                        <div className="flex items-center gap-2 border-r border-slate-200 bg-slate-50/60 py-2 pl-10 pr-5">
                          <span
                            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${style.swatch}`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-slate-800">
                              {phase.name || style.label}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {phase.pctOfTpc}% of TPC
                              {phaseCost ? ` · ${formatCurrency(phaseCost.escalatedCost)}` : ''}
                            </div>
                          </div>
                          {phase.durationLocked ? (
                            <span
                              title="Fixed duration — this phase can be moved but not resized"
                              aria-label="Fixed duration"
                              className="shrink-0 text-[11px] text-slate-500"
                            >
                              🔒
                            </span>
                          ) : null}
                        </div>

                        <div
                          className="relative"
                          style={{
                            backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${
                              CELL_WIDTH - 1
                            }px, rgba(148,163,184,0.18) ${CELL_WIDTH - 1}px, rgba(148,163,184,0.18) ${CELL_WIDTH}px)`,
                          }}
                        >
                          <div
                            className={`absolute flex items-center rounded-[0.8rem] border px-2 shadow-md ${style.bar} ${style.border} ${style.text} ${
                              readOnly ? 'cursor-default' : 'cursor-grab'
                            }`}
                            style={{ ...rect, height: BAR_HEIGHT }}
                            onPointerDown={
                              readOnly
                                ? undefined
                                : (event) => onPhasePointerDown(event, phase, 'move')
                            }
                            title={
                              phaseCost?.beyondConfidenceHorizon
                                ? 'Past the escalation confidence horizon — treat this number as a range, not a forecast'
                                : undefined
                            }
                          >
                            {/* Resize handles are ABSENT, not merely inert, on
                                a locked phase. A disabled handle that still
                                looks grabbable is how you get the bug report
                                Jeff described: "It allowed you to do that". */}
                            {!readOnly && !phase.durationLocked ? (
                              <div
                                className="absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize rounded-l-[0.8rem]"
                                onPointerDown={(event) =>
                                  onPhasePointerDown(event, phase, 'resize-start')
                                }
                              />
                            ) : null}

                            <div className="min-w-0 flex-1 px-1">
                              <div className="truncate text-[11px] font-semibold">
                                {phase.name || style.label}
                              </div>
                            </div>

                            {phaseCost?.beyondConfidenceHorizon ? (
                              <span
                                className="shrink-0 pr-1 text-[11px] leading-none"
                                aria-label="Beyond the escalation confidence horizon"
                              >
                                ≈
                              </span>
                            ) : null}

                            {!readOnly && !phase.durationLocked ? (
                              <div
                                className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize rounded-r-[0.8rem]"
                                onPointerDown={(event) =>
                                  onPhasePointerDown(event, phase, 'resize-end')
                                }
                              />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })
                : null}
            </Fragment>
          )
        })}

        {/* The overlay sits above every row and is offset by the label column
            so its coordinate space matches the bars'. Rects are computed from
            the same layout arithmetic rather than measured from the DOM —
            measuring would need a layout pass per drag frame and would be
            wrong for one frame after every re-render. */}
        <div
          className="pointer-events-none absolute top-0"
          style={{ left: LABEL_COLUMN_WIDTH, width, height: bodyHeight }}
        >
          <DependencyArrows
            links={links}
            width={width}
            height={bodyHeight}
            onSelectLink={readOnly ? undefined : onSelectLink}
          />
        </div>
      </div>
    </div>
  )
}
