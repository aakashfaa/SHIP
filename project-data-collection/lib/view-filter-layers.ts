/**
 * How a person's own view filter combines with the project default
 * (lib/use-effective-view-settings.ts). Pure, for node --test.
 *
 * The personal layer is a DELTA on top of the project default, not a copy,
 * so later admin changes still reach everyone:
 *
 *   columns   { hide, show }  -- extra columns this person hid, and (admins
 *             only) columns the default hides that this admin shows.
 *   timeline  per-setting overrides.
 *
 * Non-admins can only take things AWAY from what the admin chose: a column
 * the admin hid stays hidden (admins may hide columns from clients on
 * purpose), a chart the admin turned off stays off, and a cost row set to
 * 'none' stays off -- otherwise they may switch fiscal year / quarter. Admins
 * see past their own default so they can change it ("Save as default for
 * everyone").
 */

import type { ProjectViewSettings, TimelineCostBreakdown } from './view-settings'

export type ColumnsLayer = { hide: string[]; show: string[] }
export type TimelineLayer = {
  costBreakdown?: TimelineCostBreakdown
  showEnergy?: boolean
  showPackages?: boolean
}

type Columns = { hiddenColumns: string[] }
type Timeline = ProjectViewSettings['timeline']

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function parseColumnsLayer(raw: unknown): ColumnsLayer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { hide: strings(r.hide), show: strings(r.show) }
}

export function parseTimelineLayer(raw: unknown): TimelineLayer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const layer: TimelineLayer = {}
  if (r.costBreakdown === 'fiscal-year' || r.costBreakdown === 'quarter' || r.costBreakdown === 'none') {
    layer.costBreakdown = r.costBreakdown
  }
  if (typeof r.showEnergy === 'boolean') layer.showEnergy = r.showEnergy
  if (typeof r.showPackages === 'boolean') layer.showPackages = r.showPackages
  return layer
}

export function applyColumnsLayer(base: Columns, layer: ColumnsLayer, isAdmin: boolean): Columns {
  const hidden = new Set([...base.hiddenColumns, ...layer.hide])
  if (isAdmin) for (const key of layer.show) hidden.delete(key)
  return { hiddenColumns: [...hidden] }
}

export function applyTimelineLayer(base: Timeline, layer: TimelineLayer, isAdmin: boolean): Timeline {
  if (isAdmin) {
    return {
      costBreakdown: layer.costBreakdown ?? base.costBreakdown,
      showEnergy: layer.showEnergy ?? base.showEnergy,
      showPackages: layer.showPackages ?? base.showPackages,
    }
  }
  return {
    costBreakdown: base.costBreakdown === 'none' ? 'none' : layer.costBreakdown ?? base.costBreakdown,
    showEnergy: base.showEnergy && layer.showEnergy !== false,
    showPackages: base.showPackages && layer.showPackages !== false,
  }
}

/** The smallest layer that turns `base` into `desired` (as far as the
 *  person's role allows). */
export function columnsLayerFor(base: Columns, desired: Columns, isAdmin: boolean): ColumnsLayer {
  const baseSet = new Set(base.hiddenColumns)
  const desiredSet = new Set(desired.hiddenColumns)
  return {
    hide: [...desiredSet].filter((k) => !baseSet.has(k)),
    show: isAdmin ? [...baseSet].filter((k) => !desiredSet.has(k)) : [],
  }
}

export function timelineLayerFor(base: Timeline, desired: Timeline, isAdmin: boolean): TimelineLayer {
  const layer: TimelineLayer = {}
  if (desired.costBreakdown !== base.costBreakdown && (isAdmin || base.costBreakdown !== 'none')) {
    layer.costBreakdown = desired.costBreakdown
  }
  if (desired.showEnergy !== base.showEnergy && (isAdmin || !desired.showEnergy)) {
    layer.showEnergy = desired.showEnergy
  }
  if (desired.showPackages !== base.showPackages && (isAdmin || !desired.showPackages)) {
    layer.showPackages = desired.showPackages
  }
  return layer
}

export function isEmptyLayer(layer: ColumnsLayer | TimelineLayer): boolean {
  if ('hide' in layer && 'show' in layer) return layer.hide.length === 0 && layer.show.length === 0
  return Object.keys(layer).length === 0
}
