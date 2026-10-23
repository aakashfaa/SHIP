'use client'

import { useMemo } from 'react'
import type { MetricSeries } from '@/lib/cost-model'
import { colorWithAlpha } from '@/lib/graphs'
import {
  CELL_WIDTH,
  ENERGY_CHART_HEIGHT,
  ENERGY_CHART_PADDING_BOTTOM,
  ENERGY_CHART_PADDING_TOP,
  LABEL_COLUMN_WIDTH,
  xForSlot,
} from './layout'
import { graphEmptyHints } from './graph-empty-state'

/**
 * One graph under the timeline. There is one of these per row of
 * ship.project_graphs, stacked in sort_order (migration 0032).
 *
 * It started as the energy reduction chart, requested by Megan after the
 * DCAMM demo:
 *
 *   "quantify and graph the energy reductions of the proposed building
 *    upgrades on the timeline [...] we add a graph below the timeline that live
 *    updates with the savings similar to how the overall cost gets updated
 *    above."
 *
 * and was generalised when she asked for carbon too:
 *
 *   "would it be possible to add a parameter for carbon reduction that can be
 *    tracked on a separate graph right below energy? It could be a different
 *    color (blue maybe?)."
 *
 * So the label, unit, column and colour all come from the graph's row; the
 * drawing is the same for every graph.
 *
 * Hand-rolled SVG rather than a charting library, and that is the entire
 * design. The requirement is not "draw a nice step chart", it is "draw a step
 * chart whose x-coordinates are identical, to the pixel, to a grid defined by
 * hand-written layout code sitting directly above it". Every charting library
 * owns its own scale and margins, which would put a second slot→pixel
 * translation in the codebase that has to be kept in sync with `xForSlot` by
 * hand. Importing the same function the grid uses makes drift impossible
 * rather than merely unlikely -- for every graph in the stack.
 *
 * The shape is a descending staircase: flat between package completions,
 * dropping vertically at each one. That is both Megan's sketch and the
 * conventional form for a decarbonisation pathway chart.
 */

type Props = {
  /** Shown as the chart's heading. */
  label: string
  /** '#rrggbb' -- the line, the step dots, the fill (at 10%) and the legend. */
  color: string
  series: MetricSeries
  /** The line-item column the graph sums, for the empty state's wording. */
  sourceLabel: string
  /** The column no longer exists (custom field deleted or retyped). */
  sourceMissing?: boolean
  slotCount: number
  /** Highlighted when the user hovers a column in the grid above. */
  hoveredSlot?: number | null
  /** Opens graph setup at this graph. Omit when the user cannot edit; the
   *  empty state then explains without linking. */
  onOpenSetup?: () => void
  /** Switches to the Master View tab. Omit when the user cannot edit line items. */
  onOpenMasterView?: () => void
  /** For tests and the PDF: identifies the graph. */
  graphId?: string
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

const LINK_CLASS =
  'rounded-sm font-medium text-teal-700 underline underline-offset-2 transition hover:text-teal-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

export default function GraphChart({
  label,
  color,
  series,
  sourceLabel,
  sourceMissing = false,
  slotCount,
  hoveredSlot,
  onOpenSetup,
  onOpenMasterView,
  graphId,
}: Props) {
  const plotHeight =
    ENERGY_CHART_HEIGHT - ENERGY_CHART_PADDING_TOP - ENERGY_CHART_PADDING_BOTTOM
  const width = Math.max(slotCount * CELL_WIDTH, CELL_WIDTH)
  const unit = series.unitLabel.trim()

  const { path, baselineY, yFor, top, hasData } = useMemo(() => {
    // Two modes, because a baseline is genuinely optional — the engineers had
    // not delivered one when this was specified ("We don't know the scale or
    // the units yet"), and a feature that only works after that delivery will
    // not be adopted before it.
    //
    //   baseline set  -> plot what remains, falling away from it
    //   no baseline   -> plot the cumulative reduction climbing from zero,
    //                    inverted so the line still descends and the shape
    //                    is familiar
    const usesBaseline = series.baseline !== null && series.baseline > 0
    const topValue = usesBaseline ? (series.baseline as number) : series.finalSavings

    if (topValue <= 0) {
      return { path: '', baselineY: 0, yFor: () => 0, top: 0, hasData: false }
    }

    const yFor = (value: number) =>
      ENERGY_CHART_PADDING_TOP + (1 - value / topValue) * plotHeight

    const valueAt = (slotIndex: number) => {
      const point = series.points[slotIndex]
      if (!point) return topValue
      return usesBaseline
        ? (point.remainingConsumption ?? topValue)
        : topValue - point.cumulativeSavings
    }

    // Build the staircase explicitly: hold the current value across the slot's
    // full width, then drop vertically at the boundary. `H` then `V` rather
    // than `L` is what makes it a step instead of a slope — a sloped line would
    // imply savings ramping in across a year, which is not what happens when a
    // building comes back into service.
    const segments: string[] = []
    let previous = valueAt(0)
    segments.push(`M ${xForSlot(0)} ${yFor(previous)}`)

    for (let slot = 0; slot < slotCount; slot += 1) {
      const value = valueAt(slot)
      if (value !== previous) {
        segments.push(`V ${yFor(value)}`)
        previous = value
      }
      segments.push(`H ${xForSlot(slot + 1)}`)
    }

    return {
      path: segments.join(' '),
      baselineY: yFor(topValue),
      yFor,
      top: topValue,
      hasData: true,
    }
  }, [series, slotCount, plotHeight])

  const finalPoint = series.points[series.points.length - 1]
  const finalSavings = finalPoint?.cumulativeSavings ?? 0
  const reductionPct = series.baseline && series.baseline > 0
    ? (finalSavings / series.baseline) * 100
    : null

  return (
    <div
      className="grid border-t border-slate-200 bg-white"
      style={{ gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px ${width}px` }}
      data-testid="timeline-graph"
      data-graph-id={graphId}
    >
      <div className="border-r border-slate-200 px-5 py-4">
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <div
            className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
            title={label}
          >
            {label}
          </div>
        </div>
        <div className="mt-1 text-sm font-semibold text-slate-950">
          {series.baseline !== null ? 'Remaining consumption' : 'Cumulative savings'}
        </div>
        {unit ? <div className="mt-1 text-xs text-slate-500">{unit}</div> : null}

        {hasData ? (
          <div className="mt-3 space-y-1">
            <div className="flex items-center gap-2 text-[11px] text-slate-600">
              <span className="inline-block h-0 w-4 border-t border-dashed border-slate-400" />
              Baseline {formatCompact(top)}
            </div>
            <div className="flex items-center gap-2 text-[11px]" style={{ color }}>
              <span className="inline-block h-0 w-4 border-t-2" style={{ borderColor: color }} />
              Saved {formatCompact(finalSavings)}
              {reductionPct !== null ? ` (${reductionPct.toFixed(0)}%)` : ''}
            </div>
          </div>
        ) : null}
      </div>

      <div className="relative" style={{ height: ENERGY_CHART_HEIGHT }}>
        {hasData ? (
          <svg
            width={width}
            height={ENERGY_CHART_HEIGHT}
            className="block"
            role="img"
            aria-label={`${label} over the plan. ${formatCompact(finalSavings)}${
              unit ? ` ${unit}` : ''
            } saved once every package is in service.`}
          >
            {/* Column rules, drawn here rather than inherited, so the chart
                lines up with the grid above even though it is a separate
                stacking context. Same xForSlot, same CELL_WIDTH. */}
            {Array.from({ length: slotCount + 1 }, (_, slot) => (
              <line
                key={`rule-${slot}`}
                x1={xForSlot(slot)}
                x2={xForSlot(slot)}
                y1={0}
                y2={ENERGY_CHART_HEIGHT}
                stroke="rgba(148,163,184,0.24)"
                strokeWidth={1}
              />
            ))}

            {hoveredSlot != null && hoveredSlot >= 0 && hoveredSlot < slotCount ? (
              <rect
                x={xForSlot(hoveredSlot)}
                y={0}
                width={CELL_WIDTH}
                height={ENERGY_CHART_HEIGHT}
                fill="rgba(15,118,110,0.06)"
              />
            ) : null}

            {/* Horizontal reference lines at quarters of the baseline, with
                their values. Without them the curve has no magnitude: a line
                that drops a third of the way down the box looks identical
                whether it represents 4M kBtu or 40, and the whole point of the
                chart is to show a client how much is actually coming off. */}
            {[0.25, 0.5, 0.75].map((fraction) => {
              const value = top * fraction
              const y = yFor(value)
              return (
                <g key={`grid-${fraction}`}>
                  <line
                    x1={0}
                    x2={width}
                    y1={y}
                    y2={y}
                    stroke="rgba(148,163,184,0.35)"
                    strokeWidth={1}
                  />
                  <text
                    x={6}
                    y={y - 3}
                    className="fill-slate-400"
                    style={{ fontSize: 9 }}
                  >
                    {formatCompact(value)}
                  </text>
                </g>
              )
            })}

            <line
              x1={0}
              x2={width}
              y1={baselineY}
              y2={baselineY}
              stroke="#475569"
              strokeWidth={1.25}
              strokeDasharray="4 4"
            />
            <text x={6} y={baselineY + 11} className="fill-slate-500" style={{ fontSize: 9 }}>
              {formatCompact(top)} baseline
            </text>

            {/* Fill under the curve, closed back along the baseline. It reads
                as "what is still happening", which is the quantity the client
                is trying to shrink. */}
            <path
              d={`${path} V ${ENERGY_CHART_PADDING_TOP + plotHeight} H 0 Z`}
              fill={colorWithAlpha(color, 0.1)}
            />
            <path d={path} fill="none" stroke={color} strokeWidth={2} />

            {/* A tick at each step, so the drop is attributable to a specific
                column rather than being a bend in a line. */}
            {series.points.map((point, index) => {
              const previous = series.points[index - 1]
              if (!previous || point.cumulativeSavings === previous.cumulativeSavings) {
                return null
              }
              const value =
                series.baseline !== null
                  ? (point.remainingConsumption ?? 0)
                  : top - point.cumulativeSavings
              return (
                <circle
                  key={`step-${point.slotIndex}`}
                  cx={xForSlot(point.slotIndex)}
                  cy={yFor(value)}
                  r={3}
                  fill={color}
                />
              )
            })}
          </svg>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-slate-400">
            <span>No {label.toLowerCase()} yet</span>
            {graphEmptyHints(series, { label: sourceLabel, missing: sourceMissing }).map((hint) => {
              const onClick = hint.kind === 'values' ? onOpenMasterView : onOpenSetup
              const testId = `graph-empty-${hint.kind}-link`
              return onClick ? (
                <button
                  key={hint.kind}
                  type="button"
                  onClick={onClick}
                  data-testid={testId}
                  className={LINK_CLASS}
                >
                  {hint.linkText}
                </button>
              ) : (
                <span key={hint.kind} data-testid={testId.replace('-link', '-hint')}>
                  {hint.plainText}
                </span>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
