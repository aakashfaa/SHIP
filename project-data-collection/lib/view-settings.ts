/**
 * Per-project display choices, set by a project admin in Settings and shared
 * by everyone who opens the project (consultants and clients included).
 *
 * Columns are stored as a HIDDEN list, not a visible one, so a question added
 * to the input form later shows up everywhere by default instead of silently
 * missing from Master View and Chunking until someone remembers to tick it.
 *
 * Stored as `ship.projects.view_settings` jsonb. Anything missing or malformed
 * in the stored value falls back to DEFAULT_VIEW_SETTINGS via
 * normalizeViewSettings, so old projects and partial writes always render.
 */

export type TimelineCostBreakdown = 'fiscal-year' | 'quarter' | 'none'

export type ProjectViewSettings = {
  masterView: { hiddenColumns: string[] }
  chunking: { hiddenColumns: string[] }
  timeline: {
    /** The cost row(s) under the timeline grid: by fiscal year, by quarter, or hidden. */
    costBreakdown: TimelineCostBreakdown
    showEnergy: boolean
    showPackages: boolean
  }
}

/** One selectable column, as listed in the Settings display popup. */
export type ViewColumn = {
  key: string
  label: string
  /** Columns that must always show (e.g. item number/name) are listed but not toggleable. */
  locked?: boolean
}

export const DEFAULT_VIEW_SETTINGS: ProjectViewSettings = {
  masterView: { hiddenColumns: [] },
  chunking: { hiddenColumns: [] },
  timeline: { costBreakdown: 'fiscal-year', showEnergy: true, showPackages: true },
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function normalizeViewSettings(raw: unknown): ProjectViewSettings {
  const r = asRecord(raw)
  const t = asRecord(r.timeline)
  const breakdown = t.costBreakdown
  return {
    masterView: { hiddenColumns: stringList(asRecord(r.masterView).hiddenColumns) },
    chunking: { hiddenColumns: stringList(asRecord(r.chunking).hiddenColumns) },
    timeline: {
      costBreakdown:
        breakdown === 'fiscal-year' || breakdown === 'quarter' || breakdown === 'none'
          ? breakdown
          : DEFAULT_VIEW_SETTINGS.timeline.costBreakdown,
      showEnergy: typeof t.showEnergy === 'boolean' ? t.showEnergy : true,
      showPackages: typeof t.showPackages === 'boolean' ? t.showPackages : true,
    },
  }
}

/** Visible columns in their catalog order. Locked columns are always kept. */
export function visibleColumns(columns: ViewColumn[], hidden: string[]): ViewColumn[] {
  const hiddenSet = new Set(hidden)
  return columns.filter((c) => c.locked || !hiddenSet.has(c.key))
}
