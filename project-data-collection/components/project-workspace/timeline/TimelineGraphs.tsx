'use client'

import { useMemo } from 'react'
import {
  computeMetricSeries,
  type PackageSummary,
  type TimelineGeometry,
} from '@/lib/cost-model'
import { graphMetricSettings, graphSourceOptions, packageGraphValues } from '@/lib/graphs'
import { getFormFieldsForProject, getProjectGraphs } from '@/lib/store'
import type { ChunkProject, FormField, LineItem, ProjectGraph } from '@/lib/types'
import { useAsyncData } from '@/lib/useAsyncData'
import GraphChart from './GraphChart'

/**
 * The graphs under the Timeline grid (migration 0032): loading them, and
 * drawing one GraphChart per graph, stacked in sort_order, each in its own
 * colour, all on the grid's own x-scale (`xForSlot`).
 *
 * Kept out of TimelineTab so the tab only wires it up: the tab owns the
 * schedule and the money, this owns the graphs.
 */

/** The project's graphs and its form fields (for each graph's column
 *  label). `setGraphs` is how the setup popup's edits redraw the charts
 *  live; `reload` re-reads after something else wrote (the Cost model's
 *  colour swatches). */
export function useTimelineGraphs(projectId: string) {
  const graphs = useAsyncData<ProjectGraph[]>(() => getProjectGraphs(projectId), [projectId], [])
  const formFields = useAsyncData<FormField[]>(
    () => getFormFieldsForProject(projectId),
    [projectId],
    []
  )
  return {
    graphs: graphs.data,
    setGraphs: graphs.setData,
    reloadGraphs: graphs.reload,
    formFields: formFields.data,
    error: graphs.error ?? formFields.error,
  }
}

type Props = {
  graphs: readonly ProjectGraph[]
  formFields: readonly FormField[]
  /** Graph ids hidden by the view filter (per-project view settings). */
  hiddenGraphs: readonly string[]
  summaries: readonly PackageSummary[]
  chunkProjects: readonly ChunkProject[]
  lineItemsById: ReadonlyMap<string, LineItem>
  geometry: TimelineGeometry
  slotCount: number
  hoveredSlot?: number | null
  /** Opens graph setup, at the given graph. Omit when the user cannot edit. */
  onOpenSetup?: (graphId: string) => void
  onOpenMasterView?: () => void
}

export default function TimelineGraphs({
  graphs,
  formFields,
  hiddenGraphs,
  summaries,
  chunkProjects,
  lineItemsById,
  geometry,
  slotCount,
  hoveredSlot,
  onOpenSetup,
  onOpenMasterView,
}: Props) {
  const sources = useMemo(
    () => new Map(graphSourceOptions(formFields).map((s) => [s.key, s])),
    [formFields]
  )

  // Per graph: sum its column per package (quantity included, as energy
  // always was), then the same staircase the energy chart drew.
  const drawn = useMemo(() => {
    const hidden = new Set(hiddenGraphs)
    return graphs
      .filter((graph) => !hidden.has(graph.id))
      .map((graph) => ({
        graph,
        series: computeMetricSeries(
          summaries,
          packageGraphValues(chunkProjects, lineItemsById, graph.sourceKey),
          graphMetricSettings(graph),
          geometry
        ),
      }))
  }, [graphs, hiddenGraphs, summaries, chunkProjects, lineItemsById, geometry])

  return (
    <>
      {drawn.map(({ graph, series }) => {
        const source = sources.get(graph.sourceKey)
        return (
          <GraphChart
            key={graph.id}
            graphId={graph.id}
            label={graph.label}
            color={graph.color}
            series={series}
            sourceLabel={source?.label ?? graph.sourceKey}
            sourceMissing={formFields.length > 0 && !source}
            slotCount={slotCount}
            hoveredSlot={hoveredSlot}
            onOpenSetup={onOpenSetup ? () => onOpenSetup(graph.id) : undefined}
            onOpenMasterView={onOpenMasterView}
          />
        )
      })}
    </>
  )
}
