'use client'

import { formatCurrency } from '@/lib/costs'
import type { ChunkPhase } from '@/lib/types'
import { PHASE_STYLES } from '@/components/project-workspace/timeline/layout'

/**
 * A package's phases in Packaging, read-only.
 *
 * Phase STRUCTURE is one project-level choice now: the phase template in the
 * Cost model, applied to every package (owner's decision -- per-package
 * structures were never going to be used). Timing is moved on the Timeline
 * by dragging the bars. So this only shows what the package is split into
 * and what each part costs before escalation.
 */
type Props = {
  /** This package's phases, sorted by sortOrder by the caller. */
  phases: ChunkPhase[]
  /** Package TPC = eccBase * tpcFactor. Passed down rather than recomputed
   *  here so this component never has to know how a package's line items
   *  roll up into an ECC - that arithmetic lives in one place (ChunkingTab,
   *  mirroring lib/cost-model.ts's own eccBase -> tpcBase step). */
  eccBase: number
  tpcFactor: number
}

const PCT_TOLERANCE = 1e-6

/**
 * "2 yrs", "1.5 yrs", "8 mo" -- a duration in months read back in the unit
 * people plan in. Durations are stored in months (D-1).
 */
function describeMonths(months: number): string {
  if (!Number.isFinite(months) || months <= 0) return ''
  if (months < 12) return `${Math.round(months * 10) / 10} mo`
  const years = Math.round((months / 12) * 100) / 100
  return `${years} yr${years === 1 ? '' : 's'}`
}

export default function PhaseEditor({ phases, eccBase, tpcFactor }: Props) {
  const tpcBase = eccBase * tpcFactor
  const totalPct = phases.reduce((sum, phase) => sum + phase.pctOfTpc, 0)
  const totalIsComplete = Math.abs(totalPct - 100) <= PCT_TOLERANCE

  return (
    <div className="rounded-[1.6rem] border border-slate-200 bg-white/90 p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Phases
        </div>
        {phases.length > 0 ? (
          // Amber when the allocation is not exactly 100%: never auto-corrected
          // (see 0007_ship_phases.sql), so the figure is shown instead.
          <span
            role="status"
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              totalIsComplete
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            {totalPct.toFixed(1)}% of TPC allocated
          </span>
        ) : null}
      </div>

      {phases.length === 0 ? (
        <div className="rounded-[1.2rem] border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">
          No phases
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[1.2rem] border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-950 text-left">
                {['Phase', '% of TPC', 'Duration', 'Cost'].map((label) => (
                  <th
                    key={label}
                    className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {phases.map((phase) => {
                const style = PHASE_STYLES[phase.kind]
                return (
                  <tr key={phase.id} className="border-t border-slate-100">
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${style.swatch}`}
                          aria-hidden="true"
                        />
                        <span className="font-medium text-slate-800">
                          {phase.name || style.label}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">{phase.pctOfTpc}%</td>
                    <td className="px-3 py-2.5 text-slate-700">
                      {describeMonths(phase.durationMonths)}
                    </td>
                    {/* Base cost only (no escalation): escalation depends on
                        where the phase sits, which is the Timeline's job. */}
                    <td className="px-3 py-2.5 font-medium text-slate-700">
                      {formatCurrency(tpcBase * (phase.pctOfTpc / 100))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2 text-xs text-slate-500">
            TPC base: {formatCurrency(tpcBase)} ({formatCurrency(eccBase)} ECC ×{' '}
            {tpcFactor.toFixed(2)})
          </div>
        </div>
      )}
    </div>
  )
}
