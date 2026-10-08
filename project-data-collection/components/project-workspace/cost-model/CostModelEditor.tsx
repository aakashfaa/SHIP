'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCurrency } from '@/lib/costs'
import { STAND_IN_BASE_YEAR, escalationFactor, type CostSettings } from '@/lib/cost-model'
import {
  clearEscalationRateOverride,
  getChunkPhasesForProject,
  getChunkProjectsForProject,
  getCostSettingsForProject,
  getEnergySettingsForProject,
  getPhaseTemplates,
  replaceChunkPhases,
  setEscalationRateOverride,
  updateCostSettingsForProject,
  updateEnergySettingsForProject,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import type {
  ChunkProject,
  PhaseTemplate,
  ProjectCostSettings,
  ProjectEnergySettings,
} from '@/lib/types'
import { layoutTemplatePhases, packageStartMonth } from './phase-layout'

/**
 * Where the numbers behind the numbers live.
 *
 * Every value here is a per-project setting rather than a constant in the
 * codebase, and that is the whole generalisation strategy for v2. The first
 * client's assumptions — 1.33× TPC, a 1/9/90 phase split, 4% escalation, a July
 * fiscal year — are seeded defaults. A different practice on a different
 * project overrides them without anyone touching code.
 *
 * Opened from the Timeline's "Cost model" box (CostModelBox) in a Modal; it
 * used to be its own tab. Edits save as you type (debounced), and anything
 * still pending when the popup closes is written on unmount, so closing
 * straight after typing never drops the last keystroke.
 */

const PERSIST_DEBOUNCE_MS = 600

/**
 * Where the popup's writes stand. `saving` covers both an edit still in the
 * debounce window and a request in flight; `error` is the latest failure of
 * any write that has not since succeeded. Reported upward (CostModelBox)
 * rather than shown in here, because a write can still fail AFTER the popup
 * has closed -- the flush below -- and that failure must not vanish.
 */
export type CostModelSaveStatus =
  | { state: 'idle' | 'saving' | 'saved' }
  | { state: 'error'; message: string }

type WriteChannel = 'cost' | 'energy' | 'override' | 'template'

type Props = {
  projectId: string
  readOnly: boolean
  /** Called after every successful write, so the Timeline can re-read and
   *  re-price. Also called for the flush on close. */
  onSaved?: () => void
  /** Every change in save state, including ones after unmount. */
  onStatus?: (status: CostModelSaveStatus) => void
  /** Focus the Annual baseline input once the editor has loaded. */
  focusBaseline?: boolean
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

const INPUT_CLASS =
  'w-full rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:bg-slate-50 disabled:text-slate-600'

const SECTION_CLASS = 'rounded-[1.25rem] border border-slate-200 bg-white p-4'

export default function CostModelEditor({
  projectId,
  readOnly,
  onSaved,
  onStatus,
  focusBaseline = false,
}: Props) {
  const {
    data: costRow,
    setData: setCostRow,
    error: costError,
  } = useAsyncData<ProjectCostSettings | null>(
    () => getCostSettingsForProject(projectId),
    [projectId],
    null
  )

  const {
    data: energyRow,
    setData: setEnergyRow,
    error: energyError,
  } = useAsyncData<ProjectEnergySettings | null>(
    () => getEnergySettingsForProject(projectId),
    [projectId],
    null
  )

  const { data: templates } = useAsyncData<PhaseTemplate[]>(
    () => getPhaseTemplates(projectId),
    [projectId],
    []
  )

  const [overrideYear, setOverrideYear] = useState('')
  const [overrideRate, setOverrideRate] = useState('')
  // A template change waiting on "Apply to all N packages?", and the
  // packages a previous apply could not finish (offered again as a retry).
  const [templateConfirm, setTemplateConfirm] = useState<{
    templateId: string
    packages: ChunkProject[]
  } | null>(null)
  const [templateFailed, setTemplateFailed] = useState<{
    templateId: string
    packages: ChunkProject[]
  } | null>(null)
  const [templateBusy, setTemplateBusy] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const onSavedRef = useRef(onSaved)
  const onStatusRef = useRef(onStatus)
  const costTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const energyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingCostRef = useRef<Partial<ProjectCostSettings>>({})
  const pendingEnergyRef = useRef<Partial<ProjectEnergySettings>>({})
  // Save bookkeeping lives in refs, not state: it has to keep working after
  // unmount, while the flush's request is still out.
  const inFlightRef = useRef(0)
  const savedOnceRef = useRef(false)
  // Per channel, so a cost write that failed is not "cleared" by an energy
  // write that succeeded afterwards.
  const errorsRef = useRef(new Map<WriteChannel, string>())

  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])
  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])

  function reportStatus() {
    const error = [...errorsRef.current.values()].at(-1)
    const pending =
      costTimerRef.current !== null || energyTimerRef.current !== null || inFlightRef.current > 0
    onStatusRef.current?.(
      error !== undefined
        ? { state: 'error', message: error }
        : pending
          ? { state: 'saving' }
          : savedOnceRef.current
            ? { state: 'saved' }
            : { state: 'idle' }
    )
  }

  /** Runs one write and keeps the status honest about it. The parent hears
   *  about every landed write, even one that lands after the popup closed --
   *  otherwise the Timeline could re-read before it. */
  function trackWrite(channel: WriteChannel, write: Promise<unknown>, fallback: string) {
    inFlightRef.current += 1
    reportStatus()
    return write
      .then(() => {
        errorsRef.current.delete(channel)
        savedOnceRef.current = true
        onSavedRef.current?.()
        return true
      })
      .catch((err: unknown) => {
        errorsRef.current.set(channel, err instanceof Error ? err.message : fallback)
        return false
      })
      .finally(() => {
        inFlightRef.current -= 1
        reportStatus()
      })
  }

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      // Closing the popup inside the debounce window must still save. The
      // write goes out after unmount; its outcome, failure included, still
      // reaches the parent through onStatus.
      if (costTimerRef.current) {
        clearTimeout(costTimerRef.current)
        costTimerRef.current = null
        const payload = pendingCostRef.current
        pendingCostRef.current = {}
        if (Object.keys(payload).length > 0) {
          void trackWrite(
            'cost',
            updateCostSettingsForProject(projectId, payload),
            'Failed to save cost settings.'
          )
        }
      }
      if (energyTimerRef.current) {
        clearTimeout(energyTimerRef.current)
        energyTimerRef.current = null
        const payload = pendingEnergyRef.current
        pendingEnergyRef.current = {}
        if (Object.keys(payload).length > 0) {
          void trackWrite(
            'energy',
            updateEnergySettingsForProject(projectId, payload),
            'Failed to save energy settings.'
          )
        }
      }
      reportStatus()
    }
    // trackWrite/reportStatus only touch refs, so the first render's copies
    // behave exactly like the latest render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  /** Debounced because these are typed-into number fields — a write per
   *  keystroke would send "1", "1.", "1.3", "1.33" and re-price the plan four
   *  times. */
  function patchCost(updates: Partial<ProjectCostSettings>) {
    if (readOnly) return
    setCostRow((prev) => (prev ? { ...prev, ...updates } : prev))
    pendingCostRef.current = { ...pendingCostRef.current, ...updates }
    if (costTimerRef.current) clearTimeout(costTimerRef.current)
    costTimerRef.current = setTimeout(() => {
      costTimerRef.current = null
      const payload = pendingCostRef.current
      pendingCostRef.current = {}
      void trackWrite(
        'cost',
        updateCostSettingsForProject(projectId, payload),
        'Failed to save cost settings.'
      )
    }, PERSIST_DEBOUNCE_MS)
    reportStatus()
  }

  function patchEnergy(updates: Partial<ProjectEnergySettings>) {
    if (readOnly) return
    setEnergyRow((prev) => (prev ? { ...prev, ...updates } : prev))
    pendingEnergyRef.current = { ...pendingEnergyRef.current, ...updates }
    if (energyTimerRef.current) clearTimeout(energyTimerRef.current)
    energyTimerRef.current = setTimeout(() => {
      energyTimerRef.current = null
      const payload = pendingEnergyRef.current
      pendingEnergyRef.current = {}
      void trackWrite(
        'energy',
        updateEnergySettingsForProject(projectId, payload),
        'Failed to save energy settings.'
      )
    }, PERSIST_DEBOUNCE_MS)
    reportStatus()
  }

  /**
   * A worked preview of the escalation curve: $1M escalated at 1-15 years out
   * makes the settings concrete, and amber marks the confidence horizon past
   * which the tool stops claiming precision.
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
    if (readOnly) return
    const year = Number.parseInt(overrideYear, 10)
    const rate = Number.parseFloat(overrideRate)
    if (!Number.isFinite(year) || year < 0 || !Number.isFinite(rate) || rate < 0) return

    void trackWrite(
      'override',
      setEscalationRateOverride(projectId, year, rate)
        .then(() => getCostSettingsForProject(projectId))
        .then((fresh) => {
          if (!isMountedRef.current) return
          setCostRow(fresh)
          setOverrideYear('')
          setOverrideRate('')
        }),
      'Failed to save the override.'
    )
  }

  function handleRemoveOverride(yearOffset: number) {
    if (readOnly) return
    void trackWrite(
      'override',
      clearEscalationRateOverride(projectId, yearOffset)
        .then(() => getCostSettingsForProject(projectId))
        .then((fresh) => {
          if (isMountedRef.current) setCostRow(fresh)
        }),
      'Failed to remove the override.'
    )
  }

  /**
   * The project has ONE phase template, and every package's phases come
   * from it. Changing it re-applies it to every package after a confirm:
   * each package keeps its place on the timeline (its earliest phase start
   * becomes the first new phase's start) and the template lays out the rest.
   * Dependency links between the old phases go with them.
   */
  async function handleTemplateSelect(templateId: string) {
    if (readOnly || !costRow || templateId === costRow.defaultPhaseTemplateId) return
    setTemplateFailed(null)
    try {
      const packages = await getChunkProjectsForProject(projectId)
      if (!isMountedRef.current) return
      if (packages.length === 0) {
        await saveTemplateChoice(templateId)
        return
      }
      setTemplateConfirm({ templateId, packages })
    } catch (err) {
      errorsRef.current.set(
        'template',
        err instanceof Error ? err.message : 'Failed to load the packages.'
      )
      reportStatus()
    }
  }

  async function saveTemplateChoice(templateId: string) {
    setCostRow((prev) => (prev ? { ...prev, defaultPhaseTemplateId: templateId } : prev))
    return trackWrite(
      'cost',
      updateCostSettingsForProject(projectId, { defaultPhaseTemplateId: templateId }),
      'Failed to save the phase template.'
    )
  }

  async function applyTemplateToPackages(templateId: string, packages: ChunkProject[]) {
    const template = templates.find((t) => t.id === templateId) ?? null
    setTemplateConfirm(null)
    setTemplateFailed(null)
    // No point re-phasing every package to a template the project did not
    // keep; the status line already shows why.
    if (!(await saveTemplateChoice(templateId))) return

    const failed: ChunkProject[] = []
    let firstError = ''
    const run = async () => {
      // One read of every phase, for each package's current start.
      const allPhases = await getChunkPhasesForProject(projectId)
      for (const [index, pkg] of packages.entries()) {
        if (isMountedRef.current) setTemplateBusy(`${index + 1}/${packages.length}`)
        try {
          const start = packageStartMonth(allPhases.filter((p) => p.chunkProjectId === pkg.id))
          await replaceChunkPhases(pkg.id, layoutTemplatePhases(template, start))
        } catch (err) {
          failed.push(pkg)
          if (!firstError) firstError = err instanceof Error ? err.message : String(err)
        }
      }
      if (failed.length > 0) {
        throw new Error(
          `Not applied to ${failed.map((p) => p.chunkNumber).join(', ')}: ${firstError}`
        )
      }
    }
    const ok = await trackWrite('template', run(), 'Failed to apply the phase template.')
    if (!isMountedRef.current) return
    setTemplateBusy(null)
    if (!ok) setTemplateFailed({ templateId, packages: failed.length > 0 ? failed : packages })
  }

  if (!costRow || !energyRow) {
    return (
      <div className="px-6 py-12 text-center text-sm font-medium text-slate-400">
        {costError || energyError ? 'Could not load the cost model.' : 'Loading…'}
      </div>
    )
  }

  const selectedTemplate = templates.find((t) => t.id === costRow.defaultPhaseTemplateId)

  return (
    /*
     * A native `fieldset disabled` rather than a `disabled` prop threaded
     * through fifteen inputs. It disables every form control inside it,
     * including ones added later, so a new field cannot accidentally ship
     * writable to a consultant — which is exactly the kind of gap that opens
     * up when the gate is per-control. `readOnly` is `!permissions.canEdit`,
     * which is also true while the role RPC is in flight: the safe direction.
     *
     * `min-w-0` because a fieldset carries a default `min-width: min-content`
     * that would otherwise stop the grids inside it from shrinking.
     */
    <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-4 border-0 p-0">
      {/* ------------------------------------------------ total project cost -- */}
      <section className={SECTION_CLASS}>
        <h3 className="text-sm font-semibold text-slate-950">Total project cost</h3>

        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <Field label="TPC factor (× ECC)">
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

          <Field label="Base year">
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
                Not set. Excel export is blocked.
              </p>
            ) : null}
          </Field>

          <Field label="Phase template">
            <select
              value={templateConfirm?.templateId ?? costRow.defaultPhaseTemplateId ?? ''}
              onChange={(e) => {
                if (e.target.value) void handleTemplateSelect(e.target.value)
              }}
              disabled={templateBusy !== null || templateConfirm !== null}
              className={INPUT_CLASS}
            >
              {costRow.defaultPhaseTemplateId === null ? (
                <option value="" disabled>
                  Not set
                </option>
              ) : null}
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.isBuiltin ? '' : ' (custom)'}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {templateConfirm ? (
          <div
            role="alertdialog"
            aria-label="Confirm phase template change"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[1rem] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          >
            <span>
              Apply{' '}
              <span className="font-semibold">
                {templates.find((t) => t.id === templateConfirm.templateId)?.name ?? 'this template'}
              </span>{' '}
              to all {templateConfirm.packages.length} package
              {templateConfirm.packages.length === 1 ? '' : 's'}? Their phases are replaced; what-if moves on them are discarded.
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => setTemplateConfirm(null)}
                className="rounded-[0.9rem] border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  void applyTemplateToPackages(templateConfirm.templateId, templateConfirm.packages)
                }
                className="rounded-[0.9rem] bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700"
              >
                Apply
              </button>
            </span>
          </div>
        ) : null}
        {templateBusy ? (
          <div role="status" className="mt-3 text-xs text-slate-500">
            Applying to packages… {templateBusy}
          </div>
        ) : null}
        {templateFailed && !templateBusy ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-rose-700">
            <span>
              {templateFailed.packages.length} package
              {templateFailed.packages.length === 1 ? '' : 's'} not updated.
            </span>
            <button
              type="button"
              onClick={() =>
                void applyTemplateToPackages(templateFailed.templateId, templateFailed.packages)
              }
              className="rounded-full border border-rose-300 bg-white px-2.5 py-0.5 font-semibold text-rose-700 transition hover:bg-rose-50"
            >
              Retry
            </button>
          </div>
        ) : null}

        {selectedTemplate ? (
          <div className="mt-4 overflow-hidden rounded-[1rem] border border-slate-200">
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
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------- escalation -- */}
      <section className={SECTION_CLASS}>
        <h3 className="text-sm font-semibold text-slate-950">Escalation</h3>

        <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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
            <Field label="Measured to">
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

          <Field label="Confidence horizon (years)">
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
        {costRow.rateOverrides.length > 0 || !readOnly ? (
          <div className="mt-4 rounded-[1rem] border border-slate-200 bg-slate-50/70 p-3">
            <div className="text-xs font-semibold text-slate-700">Per-year overrides</div>

            {costRow.rateOverrides.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {[...costRow.rateOverrides]
                  .sort((a, b) => a.yearOffset - b.yearOffset)
                  .map((override) => {
                    const yearName =
                      costRow.baseYear !== null
                        ? String(costRow.baseYear + override.yearOffset)
                        : `Year +${override.yearOffset}`
                    return (
                      <span
                        key={override.yearOffset}
                        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-700"
                      >
                        {yearName}: {override.ratePercent}%
                        {readOnly ? null : (
                          <button
                            type="button"
                            onClick={() => handleRemoveOverride(override.yearOffset)}
                            aria-label={`Remove the ${yearName} override`}
                            className="text-slate-400 transition hover:text-rose-600"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    )
                  })}
              </div>
            ) : null}

            {readOnly ? null : (
              <div className="mt-2 flex flex-wrap items-end gap-2">
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
            )}
          </div>
        ) : null}

        {/* ------------------------------------------------------ curve preview */}
        <div className="mt-4">
          <div className="text-xs font-semibold text-slate-700">What $1,000,000 becomes</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {preview.map((point) => (
              <div
                key={point.yearsOut}
                title={point.beyondHorizon ? 'Past the confidence horizon' : undefined}
                className={`rounded-[0.9rem] border px-3 py-1.5 ${
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
                <div className="text-[10px] text-slate-500">×{point.factor.toFixed(3)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- energy -- */}
      <section className={SECTION_CLASS}>
        <h3 className="text-sm font-semibold text-slate-950">Energy</h3>

        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <Field label="Unit">
            <input
              type="text"
              value={energyRow.unitLabel}
              onChange={(e) => patchEnergy({ unitLabel: e.target.value })}
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Annual baseline">
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
              // Mounts only once the rows have loaded, so autoFocus lands
              // after the popup is up.
              autoFocus={focusBaseline && !readOnly}
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Interaction factor">
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
  )
}
