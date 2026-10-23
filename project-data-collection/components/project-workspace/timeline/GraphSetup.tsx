'use client'

import { useEffect, useRef, useState } from 'react'
import Modal from '@/components/ui/Modal'
import {
  ENERGY_SOURCE_KEY,
  GRAPH_PALETTE,
  graphSourceOptions,
  hasCustomNumericField,
  isHexColor,
  nextGraphColor,
} from '@/lib/graphs'
import {
  createProjectGraph,
  deleteProjectGraph,
  reorderProjectGraphs,
  updateProjectGraph,
} from '@/lib/store'
import type { FormField, ProjectGraph } from '@/lib/types'

/**
 * Setting up the graphs under the Timeline (migration 0032).
 *
 * The owner: "We show them the energy consumption graph in green that is
 * linked to the energy reduction line item column. Similarly allow them to
 * create graphs from any column they want. For one example they want to do
 * that for carbon reduction too. The parameter for that will also be there
 * so let them set that up manually. Even the energy: make it so that,
 * essentially, they set it up in the timeline setting."
 *
 * So this lives on the Timeline itself -- a "Graphs" button beside the view
 * Filter -- and it is THE one place a graph is defined: label, the
 * line-item column it sums, unit, baseline, interaction factor, colour and
 * order. Energy is just the first graph here. The Cost model popup no
 * longer has its own energy form; it lists the graphs with their colour
 * swatches ("Maybe in the cost model we have control over ... the colors")
 * and links back here for everything else, so no setting has two forms.
 *
 * Edits are live: the parent owns the graph list (`setGraphs`), so the
 * charts behind the popup redraw as the user types, and each change is
 * written debounced, like the Cost model. Anything still pending when the
 * popup closes is flushed on unmount.
 *
 * Project-wide, never per what-if/version: a graph describes what a
 * package delivers, not when it is scheduled.
 */

const PERSIST_DEBOUNCE_MS = 600

const INPUT_CLASS =
  'w-full rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:bg-slate-50 disabled:text-slate-600'

const SMALL_BUTTON =
  'rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40'

type GraphPatch = Partial<Omit<ProjectGraph, 'id' | 'projectId'>>

export type GraphSaveStatus =
  | { state: 'idle' | 'saving' | 'saved' }
  | { state: 'error'; message: string }

/* -------------------------------------------------------- colour picker -- */

/**
 * Palette swatches (green first for energy, blue second -- Megan's "blue
 * maybe?" for carbon) plus, when `allowCustom`, any hex colour.
 */
export function GraphColorPicker({
  value,
  onChange,
  allowCustom = true,
  disabled = false,
  labelledBy,
}: {
  value: string
  onChange: (hex: string) => void
  allowCustom?: boolean
  disabled?: boolean
  labelledBy?: string
}) {
  const [hexDraft, setHexDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)
  // Follow outside changes (a swatch click) into the text box.
  if (value !== lastValue) {
    setLastValue(value)
    setHexDraft(value)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-labelledby={labelledBy}>
      {GRAPH_PALETTE.map((swatch) => {
        const active = swatch.hex === value.toLowerCase()
        return (
          <button
            key={swatch.hex}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={swatch.name}
            title={swatch.name}
            disabled={disabled}
            onClick={() => onChange(swatch.hex)}
            className={`h-6 w-6 rounded-full border-2 transition disabled:cursor-not-allowed ${
              active ? 'border-slate-900 ring-2 ring-slate-300' : 'border-white shadow-[0_0_0_1px_rgba(148,163,184,0.6)]'
            }`}
            style={{ backgroundColor: swatch.hex }}
          />
        )
      })}
      {allowCustom ? (
        <span className="ml-1 flex items-center gap-1.5">
          <input
            type="color"
            aria-label="Custom colour"
            value={isHexColor(value) ? value : '#059669'}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="h-6 w-8 cursor-pointer rounded border border-slate-200 bg-white p-0 disabled:cursor-not-allowed"
          />
          <input
            type="text"
            aria-label="Hex colour"
            value={hexDraft}
            disabled={disabled}
            maxLength={7}
            onChange={(e) => {
              const next = e.target.value.trim()
              setHexDraft(next)
              if (isHexColor(next)) onChange(next.toLowerCase())
            }}
            aria-invalid={!isHexColor(hexDraft)}
            className="w-24 rounded-[0.7rem] border border-slate-200 px-2 py-1 font-mono text-xs outline-none focus:border-teal-500 aria-[invalid=true]:border-rose-400"
          />
        </span>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------- editor -- */

type EditorProps = {
  projectId: string
  graphs: ProjectGraph[]
  /** The parent's graph list setter -- edits show on the Timeline at once. */
  setGraphs: (update: (prev: ProjectGraph[]) => ProjectGraph[]) => void
  formFields: readonly FormField[]
  readOnly: boolean
  /** Scroll to and focus this graph's baseline (the chart's empty state). */
  focusGraphId?: string | null
  /** Settings → Input form. Omit when the user cannot open it (not a
   *  project admin); the hint then says who can. */
  onOpenFormBuilder?: () => void
  onStatus?: (status: GraphSaveStatus) => void
}

export function GraphSettingsEditor({
  projectId,
  graphs,
  setGraphs,
  formFields,
  readOnly,
  focusGraphId,
  onOpenFormBuilder,
  onStatus,
}: EditorProps) {
  const sources = graphSourceOptions(formFields)
  const sourceKeys = new Set(sources.map((s) => s.key))
  const noCustomNumeric = !hasCustomNumericField(formFields)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const pendingRef = useRef(new Map<string, GraphPatch>())
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const inFlightRef = useRef(0)
  const errorRef = useRef<string | null>(null)
  const savedOnceRef = useRef(false)
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])

  function report() {
    const pending = timersRef.current.size > 0 || inFlightRef.current > 0
    onStatusRef.current?.(
      errorRef.current !== null
        ? { state: 'error', message: errorRef.current }
        : pending
          ? { state: 'saving' }
          : savedOnceRef.current
            ? { state: 'saved' }
            : { state: 'idle' }
    )
  }

  function track<T>(write: Promise<T>): Promise<T | null> {
    inFlightRef.current += 1
    report()
    return write
      .then((result) => {
        errorRef.current = null
        savedOnceRef.current = true
        return result
      })
      .catch((err: unknown) => {
        errorRef.current = err instanceof Error ? err.message : 'Failed to save the graph.'
        return null
      })
      .finally(() => {
        inFlightRef.current -= 1
        report()
      })
  }

  function flush(graphId: string) {
    const timer = timersRef.current.get(graphId)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(graphId)
    const patch = pendingRef.current.get(graphId)
    pendingRef.current.delete(graphId)
    if (patch && Object.keys(patch).length > 0) void track(updateProjectGraph(graphId, patch))
  }

  // Closing inside the debounce window still saves.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const graphId of [...timers.keys()]) flush(graphId)
      report()
    }
    // flush/report only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function patch(graphId: string, updates: GraphPatch) {
    if (readOnly) return
    setGraphs((prev) => prev.map((g) => (g.id === graphId ? { ...g, ...updates } : g)))
    pendingRef.current.set(graphId, { ...(pendingRef.current.get(graphId) ?? {}), ...updates })
    const existing = timersRef.current.get(graphId)
    if (existing) clearTimeout(existing)
    timersRef.current.set(
      graphId,
      setTimeout(() => flush(graphId), PERSIST_DEBOUNCE_MS)
    )
    report()
  }

  async function addGraph() {
    if (readOnly) return
    setBusy(true)
    // Default to a custom numeric field nobody graphs yet (the "parameter"
    // they added, e.g. carbon), else energy.
    const used = new Set(graphs.map((g) => g.sourceKey))
    const firstUnused = sources.find((s) => s.kind === 'custom' && !used.has(s.key))
    const created = await track(
      createProjectGraph(projectId, {
        label: firstUnused?.label ?? 'New graph',
        sourceKey: firstUnused?.key ?? ENERGY_SOURCE_KEY,
        unitLabel: '',
        baselineAnnual: null,
        interactionFactor: 1,
        color: nextGraphColor(graphs),
        sortOrder: graphs.length === 0 ? 0 : Math.max(...graphs.map((g) => g.sortOrder)) + 1,
      })
    )
    if (created) setGraphs((prev) => [...prev, created])
    setBusy(false)
  }

  async function removeGraph(graphId: string) {
    if (readOnly) return
    setConfirmDelete(null)
    const timer = timersRef.current.get(graphId)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(graphId)
    pendingRef.current.delete(graphId)
    setBusy(true)
    const ok = await track(deleteProjectGraph(graphId).then(() => true))
    if (ok) setGraphs((prev) => prev.filter((g) => g.id !== graphId))
    setBusy(false)
  }

  async function move(index: number, delta: -1 | 1) {
    if (readOnly) return
    const target = index + delta
    if (target < 0 || target >= graphs.length) return
    const next = [...graphs]
    ;[next[index], next[target]] = [next[target], next[index]]
    setBusy(true)
    const ok = await track(reorderProjectGraphs(next).then(() => true))
    if (ok) setGraphs(() => next.map((g, i) => ({ ...g, sortOrder: i })))
    setBusy(false)
  }

  return (
    <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <p className="text-sm text-slate-600">
        Each graph sums one line-item column per package, times its quantity, and steps the
        total in when the package&apos;s construction finishes. Graphs are drawn under the
        timeline in this order.
      </p>

      {graphs.length === 0 ? (
        <div className="rounded-[1.25rem] border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
          No graphs. Add one to chart a column under the timeline.
        </div>
      ) : null}

      {graphs.map((graph, index) => {
        const sourceMissing = !sourceKeys.has(graph.sourceKey)
        const labelId = `graph-${graph.id}-colour`
        return (
          <section
            key={graph.id}
            aria-label={`Graph: ${graph.label}`}
            data-testid="graph-setup-card"
            className="rounded-[1.25rem] border border-slate-200 bg-white p-4"
            style={{ borderLeft: `4px solid ${graph.color}` }}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Label</span>
                <input
                  type="text"
                  value={graph.label}
                  maxLength={80}
                  onChange={(e) => {
                    // An empty label would be refused by the database; keep
                    // what is typed on screen but only save a real one.
                    const label = e.target.value
                    if (label.trim() === '') {
                      setGraphs((prev) => prev.map((g) => (g.id === graph.id ? { ...g, label } : g)))
                    } else {
                      patch(graph.id, { label })
                    }
                  }}
                  className={INPUT_CLASS}
                />
              </label>

              <label className="block">
                <span className="text-xs font-medium text-slate-600">Column</span>
                <select
                  value={graph.sourceKey}
                  onChange={(e) => patch(graph.id, { sourceKey: e.target.value })}
                  aria-invalid={sourceMissing}
                  className={INPUT_CLASS}
                >
                  {sourceMissing ? (
                    <option value={graph.sourceKey} disabled>
                      {graph.sourceKey} (no longer exists)
                    </option>
                  ) : null}
                  <optgroup label="Built-in">
                    {sources
                      .filter((s) => s.kind === 'builtin')
                      .map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                          {s.hiddenFromForm ? ' (hidden from the form)' : ''}
                        </option>
                      ))}
                  </optgroup>
                  {sources.some((s) => s.kind === 'custom') ? (
                    <optgroup label="Your fields">
                      {sources
                        .filter((s) => s.kind === 'custom')
                        .map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                            {s.hiddenFromForm ? ' (hidden from the form)' : ''}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                </select>
                {sourceMissing ? (
                  <p role="alert" className="mt-1 text-[11px] font-medium text-rose-600">
                    The column this graph used was deleted or is no longer a number. Pick another.
                  </p>
                ) : null}
              </label>

              <label className="block">
                <span className="text-xs font-medium text-slate-600">Unit</span>
                <input
                  type="text"
                  value={graph.unitLabel}
                  maxLength={40}
                  placeholder="e.g. kBtu/yr, MTCO2e/yr"
                  onChange={(e) => patch(graph.id, { unitLabel: e.target.value })}
                  className={INPUT_CLASS}
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-medium text-slate-600">Annual baseline</span>
                  <input
                    type="number"
                    min={0}
                    value={graph.baselineAnnual ?? ''}
                    placeholder="Not set"
                    onChange={(e) => {
                      const raw = e.target.value
                      const value = Number(raw)
                      if (raw === '') patch(graph.id, { baselineAnnual: null })
                      else if (Number.isFinite(value) && value >= 0) patch(graph.id, { baselineAnnual: value })
                    }}
                    autoFocus={!readOnly && focusGraphId === graph.id}
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-slate-600">Interaction factor</span>
                  <input
                    type="number"
                    min={0.1}
                    max={2}
                    step={0.01}
                    value={graph.interactionFactor}
                    title="De-rate for measures whose savings overlap. 1.00 = values taken as summed."
                    onChange={(e) =>
                      patch(graph.id, {
                        interactionFactor: Math.min(2, Math.max(0.1, Number(e.target.value) || 1)),
                      })
                    }
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span id={labelId} className="text-xs font-medium text-slate-600">
                  Colour
                </span>
                <GraphColorPicker
                  value={graph.color}
                  onChange={(color) => patch(graph.id, { color })}
                  disabled={readOnly}
                  labelledBy={labelId}
                />
              </div>

              {readOnly ? null : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void move(index, -1)}
                    disabled={busy || index === 0}
                    aria-label={`Move ${graph.label} up`}
                    className={SMALL_BUTTON}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => void move(index, 1)}
                    disabled={busy || index === graphs.length - 1}
                    aria-label={`Move ${graph.label} down`}
                    className={SMALL_BUTTON}
                  >
                    ↓
                  </button>
                  {confirmDelete === graph.id ? (
                    <>
                      <button type="button" onClick={() => setConfirmDelete(null)} className={SMALL_BUTTON}>
                        Keep
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeGraph(graph.id)}
                        disabled={busy}
                        className="rounded-full bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-rose-700"
                      >
                        Delete graph
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(graph.id)}
                      disabled={busy}
                      className={`${SMALL_BUTTON} hover:border-rose-400 hover:text-rose-700`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        )
      })}

      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void addGraph()}
            disabled={busy}
            className="rounded-[0.95rem] bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            Add graph
          </button>
        </div>
      )}

      {/* "The parameter for that will also be there so let them set that up
          manually": a graph can only chart a column that exists, so when the
          form has no number field of the project's own, say how to add one. */}
      {noCustomNumeric ? (
        <div
          data-testid="graph-setup-no-fields"
          className="rounded-[1rem] border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
        >
          To graph something the form doesn&apos;t ask for yet, such as{' '}
          <span className="font-medium">Annual carbon reduction (MTCO2e)</span>, add a Number
          question to the line-item form first; it then appears under &ldquo;Your fields&rdquo;
          above.{' '}
          {onOpenFormBuilder ? (
            <button
              type="button"
              onClick={onOpenFormBuilder}
              className="font-semibold text-sky-800 underline underline-offset-2 hover:text-sky-950"
            >
              Open the form builder
            </button>
          ) : (
            <span>A project admin can add it in Settings → Input form.</span>
          )}
        </div>
      ) : null}
    </fieldset>
  )
}

/* ------------------------------------------------------- button + popup -- */

/**
 * The Timeline's "Graphs" button and its popup. `openRequest` lets other
 * places open it (a chart's empty state, the Cost model's graph list): bump
 * `n`, optionally naming the graph whose baseline to focus.
 */
export default function GraphSetupButton({
  projectId,
  graphs,
  setGraphs,
  formFields,
  canEdit,
  onOpenFormBuilder,
  openRequest,
}: {
  projectId: string
  graphs: ProjectGraph[]
  setGraphs: (update: (prev: ProjectGraph[]) => ProjectGraph[]) => void
  formFields: readonly FormField[]
  canEdit: boolean
  onOpenFormBuilder?: () => void
  openRequest?: { n: number; graphId: string | null }
}) {
  const [open, setOpen] = useState(false)
  const [focusGraphId, setFocusGraphId] = useState<string | null>(null)
  const [handled, setHandled] = useState(openRequest?.n ?? 0)
  const [status, setStatus] = useState<GraphSaveStatus>({ state: 'idle' })

  if (openRequest && openRequest.n !== handled) {
    setHandled(openRequest.n)
    setFocusGraphId(openRequest.graphId)
    setStatus({ state: 'idle' })
    setOpen(true)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFocusGraphId(null)
          setStatus({ state: 'idle' })
          setOpen(true)
        }}
        className="no-print inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:border-slate-500"
      >
        <span aria-hidden className="flex -space-x-1">
          {graphs.slice(0, 3).map((g) => (
            <span key={g.id} className="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white" style={{ backgroundColor: g.color }} />
          ))}
        </span>
        Graphs
      </button>
      {!open && status.state === 'error' ? (
        <span role="alert" className="text-xs text-red-700">
          Graph not saved: {status.message}
        </span>
      ) : null}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        dismissable={status.state !== 'error'}
        title={canEdit ? 'Timeline graphs' : 'Timeline graphs (read-only)'}
        size="lg"
        footer={
          <>
            {status.state === 'error' ? (
              <span role="alert" className="mr-auto text-sm text-red-700">
                Couldn&apos;t save: {status.message}
              </span>
            ) : status.state === 'saving' ? (
              <span role="status" className="mr-auto text-sm text-slate-500">
                Saving…
              </span>
            ) : status.state === 'saved' ? (
              <span role="status" className="mr-auto text-sm text-emerald-700">
                Saved
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={`rounded-[0.95rem] px-4 py-2 text-sm font-medium text-white transition ${
                status.state === 'error' ? 'bg-red-700 hover:bg-red-800' : 'bg-slate-950 hover:bg-slate-800'
              }`}
            >
              {status.state === 'error' ? 'Close anyway' : 'Done'}
            </button>
          </>
        }
      >
        {open ? (
          <GraphSettingsEditor
            projectId={projectId}
            graphs={graphs}
            setGraphs={setGraphs}
            formFields={formFields}
            readOnly={!canEdit}
            focusGraphId={focusGraphId}
            onOpenFormBuilder={
              onOpenFormBuilder
                ? () => {
                    setOpen(false)
                    onOpenFormBuilder()
                  }
                : undefined
            }
            onStatus={setStatus}
          />
        ) : null}
      </Modal>
    </>
  )
}
