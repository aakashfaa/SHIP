'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCurrency } from '@/lib/costs'
import { escalationFactor, type CostSettings } from '@/lib/cost-model'
import {
  clearEscalationRateOverride,
  getCostSettingsForProject,
  getEnergySettingsForProject,
  getPhaseTemplates,
  setEscalationRateOverride,
  updateCostSettingsForProject,
  updateEnergySettingsForProject,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import type {
  PhaseTemplate,
  Project,
  ProjectCostSettings,
  ProjectEnergySettings,
} from '@/lib/types'

/**
 * Where the numbers behind the numbers live.
 *
 * Every value on this tab is a per-project setting rather than a constant in
 * the codebase, and that is the whole generalisation strategy for v2. The first
 * client's assumptions — 1.33× TPC, a 1/9/90 phase split, 4% escalation, a July
 * fiscal year — are seeded defaults here. A different practice on a different
 * project overrides them without anyone touching code.
 *
 * Research could not find any of those figures published as a DCAMM or state
 * standard; they are plausible practitioner heuristics in the normal industry
 * range. The UI says so, because a number presented without provenance gets
 * treated as authority.
 */

const PERSIST_DEBOUNCE_MS = 600

type Props = { project: Project }

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{hint}</p> : null}
    </label>
  )
}

const INPUT_CLASS =
  'w-full rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100'

export default function CostModelTab({ project }: Props) {
  const {
    data: costRow,
    setData: setCostRow,
    error: costError,
  } = useAsyncData<ProjectCostSettings | null>(
    () => getCostSettingsForProject(project.id),
    [project.id],
    null
  )

  const {
    data: energyRow,
    setData: setEnergyRow,
    error: energyError,
  } = useAsyncData<ProjectEnergySettings | null>(
    () => getEnergySettingsForProject(project.id),
    [project.id],
    null
  )

  const { data: templates } = useAsyncData<PhaseTemplate[]>(
    () => getPhaseTemplates(project.id),
    [project.id],
    []
  )

  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [overrideYear, setOverrideYear] = useState('')
  const [overrideRate, setOverrideRate] = useState('')

  const isMountedRef = useRef(true)
  const costTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const energyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingCostRef = useRef<Partial<ProjectCostSettings>>({})
  const pendingEnergyRef = useRef<Partial<ProjectEnergySettings>>({})

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (costTimerRef.current) clearTimeout(costTimerRef.current)
      if (energyTimerRef.current) clearTimeout(energyTimerRef.current)
    }
  }, [])

  /** Debounced because these are typed-into number fields — a write per
   *  keystroke would send "1", "1.", "1.3", "1.33" and re-price the plan four
   *  times. */
  function patchCost(updates: Partial<ProjectCostSettings>) {
    setCostRow((prev) => (prev ? { ...prev, ...updates } : prev))
    pendingCostRef.current = { ...pendingCostRef.current, ...updates }
    if (costTimerRef.current) clearTimeout(costTimerRef.current)
    costTimerRef.current = setTimeout(() => {
      const payload = pendingCostRef.current
      pendingCostRef.current = {}
      updateCostSettingsForProject(project.id, payload)
        .then(() => {
          if (!isMountedRef.current) return
          setSaveError(null)
          setSavedAt(Date.now())
        })
        .catch((err) => {
          if (!isMountedRef.current) return
          setSaveError(err instanceof Error ? err.message : 'Failed to save cost settings.')
        })
    }, PERSIST_DEBOUNCE_MS)
  }

  function patchEnergy(updates: Partial<ProjectEnergySettings>) {
    setEnergyRow((prev) => (prev ? { ...prev, ...updates } : prev))
    pendingEnergyRef.current = { ...pendingEnergyRef.current, ...updates }
    if (energyTimerRef.current) clearTimeout(energyTimerRef.current)
    energyTimerRef.current = setTimeout(() => {
      const payload = pendingEnergyRef.current
      pendingEnergyRef.current = {}
      updateEnergySettingsForProject(project.id, payload)
        .then(() => {
          if (!isMountedRef.current) return
          setSaveError(null)
          setSavedAt(Date.now())
        })
        .catch((err) => {
          if (!isMountedRef.current) return
          setSaveError(err instanceof Error ? err.message : 'Failed to save energy settings.')
        })
    }, PERSIST_DEBOUNCE_MS)
  }

  /**
   * A worked preview of the escalation curve.
   *
   * This exists because escalation settings are otherwise abstract — "4%
   * compounding, midpoint basis" tells a user nothing about what their plan
   * will cost. Showing $1M escalated at 1, 5, 10 and 15 years out makes the
   * shape of the curve concrete, and makes the confidence horizon visible as
   * the point past which the tool stops claiming precision.
   */
  const preview = useMemo(() => {
    if (!costRow) return []
    const settings: CostSettings = {
      tpcFactor: costRow.tpcFactor,
      baseYear: costRow.baseYear,
      escalationMode: costRow.escalationMode,
      escalationAnnualPercent: costRow.escalationAnnualPercent,
      escalationStepYears: costRow.escalationStepYears,
      escalationBasis: costRow.escalationBasis,
      escalationConfidenceYears: costRow.escalationConfidenceYears,
      rateOverrides: new Map(costRow.rateOverrides.map((o) => [o.yearOffset, o.ratePercent])),
    }
    return [1, 3, 5, 10, 15].map((yearsOut) => ({
      yearsOut,
      factor: escalationFactor(yearsOut, settings),
      beyondHorizon: yearsOut > costRow.escalationConfidenceYears,
    }))
  }, [costRow])

  function handleAddOverride() {
    const year = Number.parseInt(overrideYear, 10)
    const rate = Number.parseFloat(overrideRate)
    if (!Number.isFinite(year) || year < 0 || !Number.isFinite(rate) || rate < 0) return

    setEscalationRateOverride(project.id, year, rate)
      .then(() => getCostSettingsForProject(project.id))
      .then((fresh) => {
        if (!isMountedRef.current) return
        setCostRow(fresh)
        setOverrideYear('')
        setOverrideRate('')
        setSaveError(null)
      })
      .catch((err) => {
        if (!isMountedRef.current) return
        setSaveError(err instanceof Error ? err.message : 'Failed to save the override.')
      })
  }

  function handleRemoveOverride(yearOffset: number) {
    clearEscalationRateOverride(project.id, yearOffset)
      .then(() => getCostSettingsForProject(project.id))
      .then((fresh) => {
        if (!isMountedRef.current) return
        setCostRow(fresh)
      })
      .catch((err) => {
        if (!isMountedRef.current) return
        setSaveError(err instanceof Error ? err.message : 'Failed to remove the override.')
      })
  }

  if (!costRow || !energyRow) {
    return (
      <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-sm font-medium text-slate-400">
        {costError || energyError ? 'Could not load the cost model.' : 'Loading cost model…'}
      </div>
    )
  }

  const selectedTemplate = templates.find((t) => t.id === costRow.defaultPhaseTemplateId)

  return (
    <div className="space-y-5">
      <div className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-950">Cost Model</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              The assumptions behind every figure on the Timeline. These are this
              project&apos;s settings, not the tool&apos;s — the defaults are one firm&apos;s
              working numbers and are meant to be changed.
            </p>
          </div>
          {savedAt ? (
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-800">
              Saved
            </span>
          ) : null}
        </div>

        {saveError ? (
          <div className="mt-4 rounded-[1.25rem] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {saveError}
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------ total project cost -- */}
      <section className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-950">Total Project Cost</h3>
        <p className="mt-1 text-xs text-slate-500">
          Soft costs — design fees, owner&apos;s contingency, FF&amp;E, OPM fees, permitting,
          commissioning — all ride inside this multiplier and land on construction rather
          than being separately schedulable.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Field
            label="TPC factor"
            hint="TPC = ECC × this. 1.33 is roughly 25% soft cost, mid-range against published benchmarks. Renovation and historic work typically runs higher."
          >
            <input
              type="number"
              min={1}
              max={10}
              step={0.01}
              value={costRow.tpcFactor}
              onChange={(e) =>
                patchCost({ tpcFactor: Math.max(0.01, Number(e.target.value) || 1) })
              }
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            label="Base year"
            hint="The year line-item costs are priced in. Escalation is measured from here, not from where the timeline starts."
          >
            <input
              type="number"
              min={1900}
              max={2200}
              step={1}
              value={costRow.baseYear}
              onChange={(e) => patchCost({ baseYear: Number(e.target.value) || costRow.baseYear })}
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            label="Default phase template"
            hint="What a newly created package starts with. Changing this never rewrites packages that already exist."
          >
            <select
              value={costRow.defaultPhaseTemplateId ?? ''}
              onChange={(e) =>
                patchCost({ defaultPhaseTemplateId: e.target.value || null })
              }
              className={INPUT_CLASS}
            >
              <option value="">None — phases added by hand</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.isBuiltin ? '' : ' (custom)'}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {selectedTemplate ? (
          <div className="mt-4 overflow-hidden rounded-[1.25rem] border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-white/70">
                <tr>
                  <th className="px-4 py-2 font-semibold uppercase tracking-[0.14em]">Phase</th>
                  <th className="px-4 py-2 font-semibold uppercase tracking-[0.14em]">Kind</th>
                  <th className="px-4 py-2 text-right font-semibold uppercase tracking-[0.14em]">
                    % of TPC
                  </th>
                </tr>
              </thead>
              <tbody>
                {selectedTemplate.steps.map((step) => (
                  <tr key={step.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-800">{step.name}</td>
                    <td className="px-4 py-2 capitalize text-slate-500">{step.kind}</td>
                    <td className="px-4 py-2 text-right font-medium text-slate-900">
                      {step.defaultPctOfTpc}%
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 bg-slate-50">
                  <td colSpan={2} className="px-4 py-2 font-semibold text-slate-700">
                    Total
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-900">
                    {selectedTemplate.steps.reduce((s, step) => s + step.defaultPctOfTpc, 0)}%
                  </td>
                </tr>
              </tbody>
            </table>
            {selectedTemplate.description ? (
              <p className="border-t border-slate-100 bg-white px-4 py-2 text-[11px] text-slate-500">
                {selectedTemplate.description}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------- escalation -- */}
      <section className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-950">Escalation</h3>
        <p className="mt-1 text-xs text-slate-500">
          Line-item costs are stored un-escalated. Escalation is applied per phase, from
          where that phase sits on the timeline — which is why moving a bar changes what it
          costs.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Mode">
            <select
              value={costRow.escalationMode}
              onChange={(e) =>
                patchCost({
                  escalationMode: e.target.value as ProjectCostSettings['escalationMode'],
                })
              }
              className={INPUT_CLASS}
            >
              <option value="compound_annual">Compound annually</option>
              <option value="stepped">Stepped every N years</option>
            </select>
          </Field>

          <Field label="Rate (% per year)">
            <input
              type="number"
              min={0}
              max={100}
              step={0.25}
              value={costRow.escalationAnnualPercent}
              onChange={(e) =>
                patchCost({
                  escalationAnnualPercent: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className={INPUT_CLASS}
            />
          </Field>

          {costRow.escalationMode === 'stepped' ? (
            <Field label="Step every (years)">
              <input
                type="number"
                min={1}
                step={1}
                value={costRow.escalationStepYears}
                onChange={(e) =>
                  patchCost({
                    escalationStepYears: Math.max(1, Math.round(Number(e.target.value) || 1)),
                  })
                }
                className={INPUT_CLASS}
              />
            </Field>
          ) : (
            <Field
              label="Measured to"
              hint="Midpoint is the estimating convention: construction dollars are spent across the whole duration, so escalating only to the start date under-prices a multi-year build."
            >
              <select
                value={costRow.escalationBasis}
                onChange={(e) =>
                  patchCost({
                    escalationBasis: e.target.value as ProjectCostSettings['escalationBasis'],
                  })
                }
                className={INPUT_CLASS}
              >
                <option value="midpoint">Midpoint of each phase</option>
                <option value="start">Start of each phase</option>
              </select>
            </Field>
          )}

          <Field
            label="Confidence horizon (years)"
            hint="Past this, the Timeline marks costs as a range rather than a forecast."
          >
            <input
              type="number"
              min={0}
              step={1}
              value={costRow.escalationConfidenceYears}
              onChange={(e) =>
                patchCost({
                  escalationConfidenceYears: Math.max(0, Math.round(Number(e.target.value) || 0)),
                })
              }
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        {/* ------------------------------------------------ per-year overrides */}
        <div className="mt-5 rounded-[1.25rem] border border-slate-200 bg-slate-50/70 p-4">
          <div className="text-xs font-semibold text-slate-700">Per-year overrides</div>
          <p className="mt-1 text-[11px] text-slate-500">
            A single rate cannot express what an estimator actually knows — the next year or
            two are forecastable and year twelve is not. Pin the years you have a view on;
            the rest fall back to {costRow.escalationAnnualPercent}%.
          </p>

          {costRow.rateOverrides.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {[...costRow.rateOverrides]
                .sort((a, b) => a.yearOffset - b.yearOffset)
                .map((override) => (
                  <span
                    key={override.yearOffset}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-700"
                  >
                    {costRow.baseYear + override.yearOffset}: {override.ratePercent}%
                    <button
                      type="button"
                      onClick={() => handleRemoveOverride(override.yearOffset)}
                      aria-label={`Remove the ${
                        costRow.baseYear + override.yearOffset
                      } override`}
                      className="text-slate-400 transition hover:text-rose-600"
                    >
                      ×
                    </button>
                  </span>
                ))}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="text-[11px] text-slate-500">Years after base</span>
              <input
                type="number"
                min={0}
                step={1}
                value={overrideYear}
                onChange={(e) => setOverrideYear(e.target.value)}
                placeholder="0"
                className={`${INPUT_CLASS} w-32`}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-500">Rate %</span>
              <input
                type="number"
                min={0}
                step={0.25}
                value={overrideRate}
                onChange={(e) => setOverrideRate(e.target.value)}
                placeholder="6.5"
                className={`${INPUT_CLASS} w-32`}
              />
            </label>
            <button
              type="button"
              onClick={handleAddOverride}
              className="rounded-[0.95rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-4 py-2 text-sm font-medium text-white shadow transition hover:-translate-y-[1px]"
            >
              Pin year
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------ curve preview */}
        <div className="mt-5">
          <div className="text-xs font-semibold text-slate-700">
            What $1,000,000 becomes
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {preview.map((point) => (
              <div
                key={point.yearsOut}
                className={`rounded-[1rem] border px-3 py-2 ${
                  point.beyondHorizon
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  +{point.yearsOut} yr{point.beyondHorizon ? ' ≈' : ''}
                </div>
                <div className="text-sm font-semibold text-slate-900">
                  {formatCurrency(1_000_000 * point.factor)}
                </div>
                <div className="text-[10px] text-slate-500">
                  ×{point.factor.toFixed(3)}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Amber means past the confidence horizon — a range to discuss, not a number to
            budget against.
          </p>
        </div>
      </section>

      {/* ----------------------------------------------------------- energy -- */}
      <section className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-950">Energy</h3>
        <p className="mt-1 text-xs text-slate-500">
          Savings roll up from line items into packages and come online when a
          package&apos;s construction finishes.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Field
            label="Unit"
            hint="Free text on purpose — kBtu, kWh, therms, MMBtu, MTCO2e or dollars, whichever the engineers deliver."
          >
            <input
              type="text"
              value={energyRow.unitLabel}
              onChange={(e) => patchEnergy({ unitLabel: e.target.value })}
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            label="Annual baseline"
            hint="Leave blank until the engineers deliver one — the chart plots cumulative savings from zero instead."
          >
            <input
              type="number"
              min={0}
              step={1000}
              value={energyRow.baselineAnnual ?? ''}
              onChange={(e) =>
                patchEnergy({
                  baselineAnnual: e.target.value === '' ? null : Number(e.target.value),
                })
              }
              placeholder="Not set"
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            label="Interaction factor"
            hint="Measure savings are not additive — a lighting retrofit cuts the heat gain an HVAC measure also claims. 1.00 takes them as summed."
          >
            <input
              type="number"
              min={0.1}
              max={2}
              step={0.01}
              value={energyRow.interactionFactor}
              onChange={(e) =>
                patchEnergy({
                  interactionFactor: Math.min(2, Math.max(0.1, Number(e.target.value) || 1)),
                })
              }
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      </section>
    </div>
  )
}
