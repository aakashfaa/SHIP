'use client'

import type { EffectiveViewSettings } from '@/lib/use-effective-view-settings'
import type { ViewColumn } from '@/lib/view-settings'
import ViewFilter from './ViewFilter'

/**
 * Column checklist filter for a table view (Master View, Packaging). Locked
 * columns are listed but can't be unticked; for non-admins, a column the
 * project default hides is listed, disabled, as "Hidden by admin".
 *
 *   const view = useEffectiveViewSettings(project.id, 'chunking', permissions.isAdmin)
 *   const catalog = getChunkingColumns(fields)
 *   const shown = visibleColumns(catalog, view.effective.hiddenColumns)
 *   <ColumnsFilter view={view} columns={catalog} />
 */
type Props = {
  view: EffectiveViewSettings<'masterView'> | EffectiveViewSettings<'chunking'>
  /** The view's full catalog (getMasterViewColumns / getChunkingColumns). */
  columns: ViewColumn[]
  align?: 'left' | 'right'
}

/** Hidden columns that actually exist in the catalog and can be hidden. */
export function hiddenColumnCount(columns: ViewColumn[], hidden: string[]): number {
  const set = new Set(hidden)
  return columns.filter((c) => !c.locked && set.has(c.key)).length
}

export default function ColumnsFilter({ view, columns, align }: Props) {
  const hidden = view.effective.hiddenColumns
  const hiddenSet = new Set(hidden)
  const adminHidden = new Set(view.isAdmin ? [] : view.projectDefault.hiddenColumns)
  const isFixed = (c: ViewColumn) => Boolean(c.locked) || adminHidden.has(c.key)
  const toggleable = columns.filter((c) => !isFixed(c))
  const allShown = toggleable.every((c) => !hiddenSet.has(c.key))

  function setHidden(next: string[]) {
    view.setPersonal({ hiddenColumns: next })
  }

  function toggle(key: string) {
    setHidden(hiddenSet.has(key) ? hidden.filter((k) => k !== key) : [...hidden, key])
  }

  return (
    <ViewFilter
      badge={hiddenColumnCount(columns, hidden)}
      isPersonal={view.isPersonal}
      onReset={view.resetToDefault}
      canSaveDefault={view.isAdmin}
      saveDefaultReady={view.canSaveDefault}
      onSaveDefault={view.saveAsDefault}
      align={align}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Columns</span>
        <button
          type="button"
          onClick={() =>
            setHidden(allShown ? [...hidden, ...toggleable.map((c) => c.key)] : hidden.filter((k) => !toggleable.some((c) => c.key === k)))
          }
          className="text-[11px] font-medium text-slate-600 hover:text-slate-950"
        >
          {allShown ? 'Hide all' : 'Show all'}
        </button>
      </div>
      <ul className="space-y-0.5">
        {columns.map((column) => {
          const byAdmin = adminHidden.has(column.key) && !column.locked
          return (
            <li key={column.key}>
              <label
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                  isFixed(column) ? 'text-slate-400' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={column.locked || !hiddenSet.has(column.key)}
                  disabled={isFixed(column)}
                  onChange={() => toggle(column.key)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span className="min-w-0 flex-1 truncate">{column.label}</span>
                {byAdmin ? <span className="shrink-0 text-[10px] text-slate-400">Hidden by admin</span> : null}
              </label>
            </li>
          )
        })}
      </ul>
    </ViewFilter>
  )
}
