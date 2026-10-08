'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyPhaseTemplateToChunk,
  createChunkPhase,
  deleteChunkPhase,
  reorderChunkPhases,
  updateChunkPhase,
} from '@/lib/store'
import { formatCurrency } from '@/lib/costs'
import { ChunkPhase, PhaseKind, PhaseTemplate } from '@/lib/types'
import { PHASE_STYLES } from '@/components/project-workspace/timeline/layout'

type Props = {
  chunkProjectId: string
  /** This package's phases, already scoped to this chunk. Sort order is the
   *  caller's problem to have gotten right upstream (ChunkingTab sorts by
   *  sortOrder before handing them down); this component trusts the array
   *  order as the display order. */
  phases: ChunkPhase[]
  templates: PhaseTemplate[]
  defaultTemplateId: string | null
  /** Package TPC = eccBase * tpcFactor. Passed down rather than recomputed
   *  here so this component never has to know how a package's line items
   *  roll up into an ECC - that arithmetic lives in one place (ChunkingTab,
   *  mirroring lib/cost-model.ts's own eccBase -> tpcBase step). */
  eccBase: number
  tpcFactor: number
  /** Re-fetches chunk_phases for the whole project. Phases are loaded once
   *  at the project level (see ChunkingTab), not per-package, so every
   *  mutation here reloads the same shared list every other package's editor
   *  reads from. */
  onChanged: () => void
  /** Render the allocation and timing for reading, with no way to change it.
   *  Consultants and viewers need to SEE how a package's cost is split across
   *  design and construction -- that is the substance of the plan -- they just
   *  do not get to move it. */
  readOnly?: boolean
}

const KIND_OPTIONS: PhaseKind[] = ['study', 'design', 'construction', 'closeout']

const PCT_TOLERANCE = 1e-6

function clampNonNegativeNumber(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export default function PhaseEditor({
  chunkProjectId,
  phases,
  templates,
  defaultTemplateId,
  eccBase,
  tpcFactor,
  onChanged,
  readOnly = false,
}: Props) {
  // The user's explicit pick, if any. Until they pick, the effective choice
  // follows the project default / first template as those props load in
  // (derived at render rather than synced from an effect).
  const [pickedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const selectedTemplateId = pickedTemplateId ?? defaultTemplateId ?? templates[0]?.id ?? null
  const [applyingTemplate, setApplyingTemplate] = useState(false)
  const [addingPhase, setAddingPhase] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Two-step inline confirm (no window.confirm): the first click on Delete
  // only arms this; the second, on "Confirm delete", actually deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Local drafts for the text/number fields, keyed by `${phaseId}:${field}`,
  // exactly the pattern ChunkingTab already uses for quantity inputs: the
  // input stays responsive on every keystroke, only the persisted write is
  // debounced, so typing "1", "1.", "1.3" is one round trip, not three.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    const pending = timers.current
    return () => {
      isMountedRef.current = false
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const tpcBase = eccBase * tpcFactor

  const totalPct = useMemo(
    () => phases.reduce((sum, phase) => sum + phase.pctOfTpc, 0),
    [phases]
  )
  const totalIsComplete = Math.abs(totalPct - 100) <= PCT_TOLERANCE

  function draftKey(phaseId: string, field: string) {
    return `${phaseId}:${field}`
  }

  function getDraft(phaseId: string, field: string, fallback: string) {
    const key = draftKey(phaseId, field)
    return drafts[key] ?? fallback
  }

  async function persist(phaseId: string, updates: Partial<ChunkPhase>) {
    setError(null)
    try {
      await updateChunkPhase(phaseId, updates)
      if (!isMountedRef.current) return
      onChanged()
    } catch (err) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to update phase.')
    }
  }

  function handleDebouncedFieldChange(
    phaseId: string,
    field: string,
    value: string,
    toUpdates: (value: string) => Partial<ChunkPhase>
  ) {
    const key = draftKey(phaseId, field)
    setDrafts((prev) => ({ ...prev, [key]: value }))

    const existingTimer = timers.current.get(key)
    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(() => {
      timers.current.delete(key)
      void persist(phaseId, toUpdates(value)).finally(() => {
        if (!isMountedRef.current) return
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      })
    }, 400)

    timers.current.set(key, timer)
  }

  async function handleImmediateUpdate(phaseId: string, updates: Partial<ChunkPhase>) {
    setSavingId(phaseId)
    await persist(phaseId, updates)
    if (isMountedRef.current) setSavingId(null)
  }

  async function handleApplyTemplate() {
    if (!selectedTemplateId) return
    setError(null)
    setApplyingTemplate(true)
    try {
      await applyPhaseTemplateToChunk(chunkProjectId, selectedTemplateId)
      if (!isMountedRef.current) return
      onChanged()
    } catch (err) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to apply template.')
    } finally {
      if (isMountedRef.current) setApplyingTemplate(false)
    }
  }

  async function handleAddPhase() {
    setError(null)
    setAddingPhase(true)
    try {
      await createChunkPhase({
        chunkProjectId,
        templateStepId: null,
        name: 'New Phase',
        kind: 'construction',
        sortOrder: phases.length,
        pctOfTpc: 0,
        startSlot: 0,
        durationSlots: 1,
        durationLocked: false,
      })
      if (!isMountedRef.current) return
      onChanged()
    } catch (err) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to add phase.')
    } finally {
      if (isMountedRef.current) setAddingPhase(false)
    }
  }

  async function handleDeletePhase(phaseId: string) {
    setError(null)
    setConfirmDeleteId(null)
    setDeletingId(phaseId)
    try {
      await deleteChunkPhase(phaseId)
      if (!isMountedRef.current) return
      onChanged()
    } catch (err) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to delete phase.')
    } finally {
      if (isMountedRef.current) setDeletingId(null)
    }
  }

  // Up/down buttons rather than drag. The Chunking tab already has a lot of
  // drag surface (line-item selection, quantity focus, the modal), and a
  // reorder here only ever moves one row one slot at a time - a button pair
  // is unambiguous, keyboard-accessible (a real <button>, not a drop target a
  // screen reader user can't operate), and it cannot half-fail the way a drag
  // can if the pointer leaves the row mid-gesture. reorderChunkPhases writes
  // the whole new order in one round trip, so there's no intermediate state
  // to get stuck in either.
  async function handleMove(phaseId: string, direction: -1 | 1) {
    const index = phases.findIndex((phase) => phase.id === phaseId)
    const targetIndex = index + direction
    if (index === -1 || targetIndex < 0 || targetIndex >= phases.length) return

    const reordered = phases.slice()
    const [moved] = reordered.splice(index, 1)
    reordered.splice(targetIndex, 0, moved)

    setError(null)
    setMovingId(phaseId)
    try {
      await reorderChunkPhases(
        chunkProjectId,
        reordered.map((phase) => phase.id)
      )
      if (!isMountedRef.current) return
      onChanged()
    } catch (err) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to reorder phases.')
    } finally {
      if (isMountedRef.current) setMovingId(null)
    }
  }

  return (
    /* Same `fieldset disabled` approach as the Cost Model tab: one gate that
       covers every control inside, including ones added later. */
    <fieldset
      disabled={readOnly}
      className="m-0 min-w-0 rounded-[2rem] border border-slate-200 bg-white/90 p-5 shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Phases
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Design separable from construction: each phase carries its own timing and share of
            this package&apos;s cost.
          </p>
        </div>
        {phases.length > 0 ? (
          <div className="flex items-center gap-2">
            {/* Green at exactly 100, amber otherwise, showing the actual figure.
                This is deliberately never auto-corrected: pct_of_tpc is not
                constrained in the database (see 0007_ship_phases.sql), because
                silently rescaling a number a cost estimator typed is worse than
                showing them it's wrong. This badge IS the fix. */}
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
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mb-4 rounded-[1.4rem] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {phases.length === 0 ? (
        <div className="rounded-[1.6rem] border border-dashed border-slate-300 bg-slate-50/60 p-5">
          <div className="text-sm font-semibold text-slate-950">
            This package isn&apos;t scheduled yet
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Apply a template to seed its phases, then edit percentages and timing per package.
          </p>

          {templates.length === 0 ? (
            <div className="mt-4 text-sm text-slate-400">No phase templates available.</div>
          ) : (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-[260px] flex-1">
                <label
                  htmlFor={`phase-template-${chunkProjectId}`}
                  className="mb-1 block text-xs font-medium text-slate-600"
                >
                  Template
                </label>
                <select
                  id={`phase-template-${chunkProjectId}`}
                  value={selectedTemplateId ?? ''}
                  onChange={(e) => setSelectedTemplateId(e.target.value || null)}
                  className="w-full rounded-[0.95rem] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                      {template.id === defaultTemplateId ? ' (project default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={handleApplyTemplate}
                disabled={!selectedTemplateId || applyingTemplate}
                className="rounded-[1rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {applyingTemplate ? 'Applying…' : 'Apply Template'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[1.6rem] border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-[980px] border-collapse text-sm">
              <thead>
                <tr className="bg-slate-950 text-left">
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    Order
                  </th>
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    Name
                  </th>
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    Kind
                  </th>
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    % of TPC
                  </th>
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    Duration (slots)
                  </th>
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    Locked
                  </th>
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    Cost
                  </th>
                  <th className="px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    &nbsp;
                  </th>
                </tr>
              </thead>
              <tbody>
                {phases.map((phase, index) => {
                  const style = PHASE_STYLES[phase.kind]
                  // Base-cost only (no escalation) - just enough to make the
                  // percentage mean something in dollars while editing it.
                  // Escalated cost depends on where the phase sits on the
                  // timeline, which is the Timeline tab's job, not this one's.
                  const derivedCost = tpcBase * (phase.pctOfTpc / 100)
                  const saving = savingId === phase.id

                  return (
                    <tr key={phase.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                      <td className="px-3 py-3 align-top">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleMove(phase.id, -1)}
                            disabled={index === 0 || movingId !== null}
                            aria-label={`Move ${phase.name || 'phase'} up`}
                            className="flex h-7 w-7 items-center justify-center rounded-[0.6rem] border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMove(phase.id, 1)}
                            disabled={index === phases.length - 1 || movingId !== null}
                            aria-label={`Move ${phase.name || 'phase'} down`}
                            className="flex h-7 w-7 items-center justify-center rounded-[0.6rem] border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            ↓
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <label htmlFor={`phase-name-${phase.id}`} className="sr-only">
                          Phase name
                        </label>
                        <input
                          id={`phase-name-${phase.id}`}
                          value={getDraft(phase.id, 'name', phase.name)}
                          onChange={(e) =>
                            handleDebouncedFieldChange(phase.id, 'name', e.target.value, (v) => ({
                              name: v,
                            }))
                          }
                          className="w-48 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                        />
                      </td>
                      <td className="px-3 py-3 align-top">
                        <label htmlFor={`phase-kind-${phase.id}`} className="sr-only">
                          Phase kind
                        </label>
                        <select
                          id={`phase-kind-${phase.id}`}
                          value={phase.kind}
                          onChange={(e) =>
                            handleImmediateUpdate(phase.id, {
                              kind: e.target.value as PhaseKind,
                            })
                          }
                          disabled={saving}
                          className="rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:opacity-60"
                        >
                          {KIND_OPTIONS.map((kind) => (
                            <option key={kind} value={kind}>
                              {PHASE_STYLES[kind].label}
                            </option>
                          ))}
                        </select>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${style.swatch}`} />
                          <span className="text-[11px] text-slate-500">{style.label}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <label htmlFor={`phase-pct-${phase.id}`} className="sr-only">
                          Percent of total project cost
                        </label>
                        <input
                          id={`phase-pct-${phase.id}`}
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={getDraft(phase.id, 'pctOfTpc', String(phase.pctOfTpc))}
                          onChange={(e) =>
                            handleDebouncedFieldChange(
                              phase.id,
                              'pctOfTpc',
                              e.target.value,
                              (v) => ({
                                pctOfTpc: Math.min(
                                  100,
                                  clampNonNegativeNumber(v, phase.pctOfTpc)
                                ),
                              })
                            )
                          }
                          className="w-24 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                        />
                      </td>
                      <td className="px-3 py-3 align-top">
                        <label htmlFor={`phase-duration-${phase.id}`} className="sr-only">
                          Duration in timeline slots
                        </label>
                        <input
                          id={`phase-duration-${phase.id}`}
                          type="number"
                          min={1}
                          step={1}
                          value={getDraft(
                            phase.id,
                            'durationSlots',
                            String(phase.durationSlots)
                          )}
                          onChange={(e) =>
                            handleDebouncedFieldChange(
                              phase.id,
                              'durationSlots',
                              e.target.value,
                              (v) => ({
                                durationSlots: Math.max(
                                  1,
                                  clampNonNegativeNumber(v, phase.durationSlots)
                                ),
                              })
                            )
                          }
                          className="w-20 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                        />
                      </td>
                      <td className="px-3 py-3 align-top">
                        <label className="inline-flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={phase.durationLocked}
                            disabled={saving}
                            onChange={(e) =>
                              handleImmediateUpdate(phase.id, {
                                durationLocked: e.target.checked,
                              })
                            }
                            aria-label={`Lock duration for ${phase.name || 'phase'}`}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          <span className="text-xs text-slate-500">
                            {phase.durationLocked ? 'Fixed' : 'Flexible'}
                          </span>
                        </label>
                      </td>
                      <td className="px-3 py-3 align-top font-medium text-slate-700">
                        {formatCurrency(derivedCost)}
                      </td>
                      <td className="px-3 py-3 align-top">
                        {confirmDeleteId === phase.id ? (
                          <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] text-rose-700">
                              Delete this phase? Can&apos;t be undone.
                            </span>
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDeletePhase(phase.id)}
                                disabled={deletingId === phase.id}
                                aria-label={`Confirm delete ${phase.name || 'phase'}`}
                                className="rounded-[0.85rem] bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {deletingId === phase.id ? '…' : 'Confirm delete'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                disabled={deletingId === phase.id}
                                className="rounded-[0.85rem] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(phase.id)}
                            disabled={deletingId === phase.id}
                            aria-label={`Delete ${phase.name || 'phase'}`}
                            className="rounded-[0.85rem] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/60 px-4 py-3">
            <div className="text-xs text-slate-500">
              TPC base: {formatCurrency(tpcBase)} ({formatCurrency(eccBase)} ECC ×{' '}
              {tpcFactor.toFixed(2)})
            </div>
            <button
              type="button"
              onClick={handleAddPhase}
              disabled={addingPhase}
              className="rounded-[0.95rem] border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {addingPhase ? 'Adding…' : '+ Add Phase'}
            </button>
          </div>
        </div>
      )}
    </fieldset>
  )
}
