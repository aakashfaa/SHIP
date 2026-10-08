'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { formatCurrency } from '@/lib/costs'
import { STAND_IN_BASE_YEAR, escalationFactor, type CostSettings } from '@/lib/cost-model'
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
import type { ProjectPermissions } from '@/lib/project-role'
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

/** Per-browser preference, not a project setting: one person finding the
 *  explanations noisy says nothing about what the next reader needs. */
const SHOW_DESCRIPTIONS_KEY = 'ship.costModel.showDescriptions'

/** Off by default -- the explanatory copy is for a first read, and the tab
 *  with all of it showing is too dense to work in. */
const DescriptionsContext = createContext(false)

/** Explanatory copy that only renders while "Show descriptions" is on. */
function Description({ children }: { children: React.ReactNode }) {
  return useContext(DescriptionsContext) ? <>{children}</> : null
}

type Props = {
  project: Project
  permissions: ProjectPermissions
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  const showDescriptions = useContext(DescriptionsContext)
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && showDescriptions ? (
        <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{hint}</p>
      ) : null}
    </label>
  )
}

const INPUT_CLASS =
  'w-full rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100'

export default function CostModelTab({ project, permissions }: Props) {
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
  // Reading storage in the initialiser cannot cause a hydration mismatch here:
  // the first render (server and client alike) is the loading placeholder,
  // which does not show the toggle.
  const [showDescriptions, setShowDescriptions] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(SHOW_DESCRIPTIONS_KEY) === '1'
    } catch {
      return false
    }
  })

  function toggleDescriptions() {
    setShowDescriptions((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(SHOW_DESCRIPTIONS_KEY, next ? '1' : '0')
      } catch {
        // Storage blocked: the toggle still works for this visit.
      }
      return next
    })
  }

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
      // The preview is in years-out, so the calendar base year never enters
      // escalationFactor; a missing one (M-25) must not hide the curve.
      baseYear: costRow.baseYear ?? STAND_IN_BASE_YEAR,
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

  // `canEdit` is false for everyone, including admins, until the role RPC in
  // useProjectRole answers -- that is the safe direction to be wrong in, so
  // the fieldset below stays disabled through the whole loading window with
  // no special-casing needed. The banner is a different kind of thing: it is
  // an assertion ("only an editor or admin can change this"), and asserting
  // it before the role is known means asserting something that might be
  // false for the very admin reading it. So the banner additionally waits
  // for `permissions.loading` to clear -- same reasoning as the shell's
  // `!permissions.loading && !canEdit` gate on its own banner.
  const readOnly = !permissions.canEdit

  return (
    /*
     * A native `fieldset disabled` rather than a `disabled` prop threaded
     * through fifteen inputs. It disables every form control inside it,
     * including ones added later, so a new field cannot accidentally ship
     * writable to a consultant — which is exactly the kind of gap that opens
     * up when the gate is per-control.
     *
     * `min-w-0` because a fieldset carries a default `min-width: min-content`
     * that would otherwise stop the grids inside it from shrinking.
     */
    <DescriptionsContext.Provider value={showDescriptions}>
    <div className="space-y-5">
      {!permissions.loading && readOnly ? (
        <div className="rounded-[1.25rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-medium">Read-only.</span> You can see every
          assumption behind the figures on the Timeline, but only a project
          editor or admin can change them.
        </div>
      ) : null}
      {/* Outside the fieldset: the descriptions toggle is a view preference,
          so it has to work for read-only roles too. */}
      <div className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-950">Cost Model</h2>
            <Description>
              <p className="mt-1 max-w-2xl text-sm text-slate-500">
                The assumptions behind every figure on the Timeline. These are this
                project&apos;s settings, not the tool&apos;s — the defaults are one firm&apos;s
                working numbers and are meant to be changed.
              </p>
            </Description>
          </div>
          <div className="flex items-center gap-3">
            {savedAt ? (
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-800">
                Saved
              </span>
            ) : null}
            <button
              type="button"
              role="switch"
              aria-checked={showDescriptions}
              onClick={toggleDescriptions}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-200"
            >
              <span
                aria-hidden="true"
                className={`relative inline-block h-4 w-7 rounded-full transition ${
                  showDescriptions ? 'bg-teal-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                    showDescriptions ? 'left-3.5' : 'left-0.5'
                  }`}
                />
              </span>
              Show descriptions
            </button>
          </div>
        </div>

        {saveError ? (
          <div className="mt-4 rounded-[1.25rem] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {saveError}
          </div>
        ) : null}
      </div>

    <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0 space-y-5">

      {/* ------------------------------------------------ total project cost -- */}
      <section className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-950">Total Project Cost</h3>
        <Description>
          <p className="mt-1 text-xs text-slate-500">
            Soft costs — design fees, owner&apos;s contingency, FF&amp;E, OPM fees, permitting,
            commissioning — all ride inside this multiplier and land on construction rather
            than being separately schedulable.
          </p>
        </Description>

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
            {/* M-25: a missing base year is shown as missing -- never filled in
                with the current year, which used to re-price the whole plan
                every 1 January. Exports refuse until it is set. */}
            <input
              type="number"
              min={1900}
              max={2200}
              step={1}
              value={costRow.baseYear ?? ''}
              placeholder="Not set"
              onChange={(e) => {
                const year = Number.parseInt(e.target.value, 10)
                if (Number.isFinite(year) && year > 0) patchCost({ baseYear: year })
              }}
              aria-invalid={costRow.baseYear === null}
              className={INPUT_CLASS}
            />
            {costRow.baseYear === null ? (
              <p role="alert" className="mt-1 text-[11px] font-medium text-rose-600">
                Base year not set. Totals can&apos;t be trusted and Excel export is blocked until
                you set it.
              </p>
            ) : null}
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
            {selectedTemplate.description && showDescriptions ? (
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
        <Description>
          <p className="mt-1 text-xs text-slate-500">
            Line-item costs are stored un-escalated. Escalation is applied per phase, from
            where that phase sits on the timeline — which is why moving a bar changes what it
            costs.
          </p>
        </Description>

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
          <Description>
            <p className="mt-1 text-[11px] text-slate-500">
              A single rate cannot express what an estimator actually knows — the next year or
              two are forecastable and year twelve is not. Pin the years you have a view on;
              the rest fall back to {costRow.escalationAnnualPercent}%.
            </p>
          </Description>

          {costRow.rateOverrides.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {[...costRow.rateOverrides]
                .sort((a, b) => a.yearOffset - b.yearOffset)
                .map((override) => (
                  <span
                    key={override.yearOffset}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-700"
                  >
                    {costRow.baseYear !== null
                      ? costRow.baseYear + override.yearOffset
                      : `Year +${override.yearOffset}`}
                    : {override.ratePercent}%
                    <button
                      type="button"
                      onClick={() => handleRemoveOverride(override.yearOffset)}
                      aria-label={`Remove the ${
                        costRow.baseYear !== null
                          ? costRow.baseYear + override.yearOffset
                          : `year +${override.yearOffset}`
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
          <Description>
            <p className="mt-2 text-[11px] text-slate-400">
              Amber means past the confidence horizon — a range to discuss, not a number to
              budget against.
            </p>
          </Description>
        </div>
      </section>

      {/* ----------------------------------------------------------- energy -- */}
      <section className="rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-950">Energy</h3>
        <Description>
          <p className="mt-1 text-xs text-slate-500">
            Savings roll up from line items into packages and come online when a
            package&apos;s construction finishes.
          </p>
        </Description>

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
    </fieldset>
    </div>
    </DescriptionsContext.Provider>
  )
}
