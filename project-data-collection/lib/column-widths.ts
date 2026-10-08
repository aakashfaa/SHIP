/**
 * Personal column widths for the Master View table. A viewer's own
 * preference (localStorage), never a shared project setting.
 */

export const MIN_COLUMN_WIDTH = 60
export const MAX_COLUMN_WIDTH = 640

export type ColumnWidths = Record<string, number>

export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_COLUMN_WIDTH
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)))
}

export function columnWidthsStorageKey(projectId: string): string {
  return `ship.masterView.colWidths.${projectId}`
}

/** Tolerant parse of whatever is in storage: junk in, empty out. */
export function parseColumnWidths(raw: string | null): ColumnWidths {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ColumnWidths = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = clampColumnWidth(value)
    }
    return out
  } catch {
    return {}
  }
}
