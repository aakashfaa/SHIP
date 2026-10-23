'use client'

import type { EffectiveViewSettings } from '@/lib/use-effective-view-settings'
import type { TimelineCostBreakdown } from '@/lib/view-settings'
import ViewFilter from './ViewFilter'

/** Timeline filter: the cost row (fiscal year / quarter / off), the graphs
 *  under the timeline (all of them, and each one -- migration 0032) and the
 *  package bars. For non-admins, whatever the project default turned off
 *  stays off (disabled, "Hidden by admin"). */
type Props = {
  view: EffectiveViewSettings<'timeline'>
  align?: 'left' | 'right'
  /** The project's graphs, in drawing order, for the per-graph switches. */
  graphs?: ReadonlyArray<{ id: string; label: string; color: string }>
}

const COST_OPTIONS: { value: TimelineCostBreakdown; label: string }[] = [
  { value: 'fiscal-year', label: 'Fiscal year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'none', label: 'Off' },
]

export default function TimelineFilter({ view, align, graphs = [] }: Props) {
  const current = view.effective
  const base = view.projectDefault
  const costLocked = !view.isAdmin && base.costBreakdown === 'none'
  // Graph ids hidden that still exist (a deleted graph's id can linger).
  const hiddenGraphCount = current.showEnergy
    ? graphs.filter((g) => current.hiddenGraphs.includes(g.id)).length
    : 0
  const off =
    (current.costBreakdown === 'none' ? 1 : 0) +
    (current.showEnergy ? 0 : 1) +
    (current.showPackages ? 0 : 1) +
    hiddenGraphCount

  return (
    <ViewFilter
      badge={off}
      isPersonal={view.isPersonal}
      onReset={view.resetToDefault}
      canSaveDefault={view.isAdmin}
      saveDefaultReady={view.canSaveDefault}
      onSaveDefault={view.saveAsDefault}
      align={align}
    >
      <div className="space-y-3 px-1">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Cost row</p>
            {costLocked ? <span className="text-[10px] text-slate-400">Hidden by admin</span> : null}
          </div>
          <div role="radiogroup" aria-label="Cost row" className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
            {COST_OPTIONS.map((option) => {
              const active = current.costBreakdown === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={costLocked}
                  onClick={() => view.setPersonal({ ...current, costBreakdown: option.value })}
                  className={`rounded-lg px-2 py-1.5 text-xs font-medium transition ${
                    active ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-950'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
        {/* The graphs under the timeline (0032): one switch for all of
            them (the old "Energy chart" setting), then one per graph. */}
        <Toggle
          label="Graphs"
          checked={current.showEnergy}
          lockedOff={!view.isAdmin && !base.showEnergy}
          onChange={(showEnergy) => view.setPersonal({ ...current, showEnergy })}
        />
        {current.showEnergy && graphs.length > 0 ? (
          <div className="-mt-1 space-y-0.5 border-l border-slate-200 pl-3" data-testid="timeline-filter-graphs">
            {graphs.map((graph) => {
              const hidden = current.hiddenGraphs.includes(graph.id)
              return (
                <Toggle
                  key={graph.id}
                  label={graph.label}
                  swatch={graph.color}
                  checked={!hidden}
                  lockedOff={!view.isAdmin && base.hiddenGraphs.includes(graph.id)}
                  onChange={(show) =>
                    view.setPersonal({
                      ...current,
                      hiddenGraphs: show
                        ? current.hiddenGraphs.filter((id) => id !== graph.id)
                        : [...current.hiddenGraphs, graph.id],
                    })
                  }
                />
              )
            })}
          </div>
        ) : null}
        <Toggle
          label="Packages"
          checked={current.showPackages}
          lockedOff={!view.isAdmin && !base.showPackages}
          onChange={(showPackages) => view.setPersonal({ ...current, showPackages })}
        />
      </div>
    </ViewFilter>
  )
}

function Toggle({
  label,
  checked,
  lockedOff,
  onChange,
  swatch,
}: {
  label: string
  checked: boolean
  lockedOff: boolean
  onChange: (v: boolean) => void
  /** A graph's colour, shown as a dot before its name. */
  swatch?: string
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-lg py-1 text-sm ${
        lockedOff ? 'text-slate-400' : 'text-slate-700'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {swatch ? (
          <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: swatch }} />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      <span className="flex items-center gap-2">
        {lockedOff ? <span className="text-[10px]">Hidden by admin</span> : null}
        <input
          type="checkbox"
          checked={checked}
          disabled={lockedOff}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
      </span>
    </label>
  )
}
