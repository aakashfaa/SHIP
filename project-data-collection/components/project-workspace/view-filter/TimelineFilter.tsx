'use client'

import type { EffectiveViewSettings } from '@/lib/use-effective-view-settings'
import type { TimelineCostBreakdown } from '@/lib/view-settings'
import ViewFilter from './ViewFilter'

/** Timeline filter: the cost row (fiscal year / quarter / off), the energy
 *  chart and the package bars. For non-admins, whatever the project default
 *  turned off stays off (disabled, "Hidden by admin"). */
type Props = {
  view: EffectiveViewSettings<'timeline'>
  align?: 'left' | 'right'
}

const COST_OPTIONS: { value: TimelineCostBreakdown; label: string }[] = [
  { value: 'fiscal-year', label: 'Fiscal year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'none', label: 'Off' },
]

export default function TimelineFilter({ view, align }: Props) {
  const current = view.effective
  const base = view.projectDefault
  const costLocked = !view.isAdmin && base.costBreakdown === 'none'
  const off = (current.costBreakdown === 'none' ? 1 : 0) + (current.showEnergy ? 0 : 1) + (current.showPackages ? 0 : 1)

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
        <Toggle
          label="Energy chart"
          checked={current.showEnergy}
          lockedOff={!view.isAdmin && !base.showEnergy}
          onChange={(showEnergy) => view.setPersonal({ ...current, showEnergy })}
        />
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
}: {
  label: string
  checked: boolean
  lockedOff: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-lg py-1 text-sm ${
        lockedOff ? 'text-slate-400' : 'text-slate-700'
      }`}
    >
      <span>{label}</span>
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
