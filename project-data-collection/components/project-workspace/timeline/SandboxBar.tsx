'use client'

import { useState } from 'react'
import type { Scenario } from '@/lib/types'

/**
 * The scenario control, and — when one is active — the banner that says so.
 *
 * Megan specified this almost to the pixel:
 *
 *   "from a UI standpoint, how do you know that you're looking at the official
 *    published one versus your own? So there's going to be a big button on the
 *    top right or somewhere. I don't know where. But if it's active, that means
 *    that you're looking at a local copy."
 *
 * This is the highest-risk piece of UX in the release and it is worth being
 * blunt about why: a user who spends twenty minutes rescheduling a plan without
 * realising they are in a sandbox, and then loses it, will not trust the tool
 * again. So the active state is not a subtle tint or a small chip — it is a
 * full-width amber bar that cannot be mistaken for chrome, it names the
 * scenario, and Publish and Discard are both one click away from it.
 *
 * The inverse matters just as much: when no scenario is active this renders a
 * single quiet button. Being on the live plan is the normal case and must not
 * look like a mode.
 */

type Props = {
  scenarios: Scenario[]
  activeScenario: Scenario | null
  /** True while a viewer-role user is in an ephemeral sandbox that is never
   *  persisted — Steve's "they could play with things a little bit, but it
   *  won't save". */
  ephemeral?: boolean
  busy?: boolean
  conflict?: string | null
  /** What the last "Pull in the latest plan" did, in words. Shown until the
   *  user leaves the what-if, so the outcome of a rebase is never a guess. */
  rebaseNotice?: string | null
  onBranch: (name: string) => void
  onEnter: (scenarioId: string) => void
  onExit: () => void
  onPublish: () => void
  onDiscard: () => void
  onRebase: () => void
}

export default function SandboxBar({
  scenarios,
  activeScenario,
  ephemeral = false,
  busy = false,
  conflict = null,
  rebaseNotice = null,
  onBranch,
  onEnter,
  onExit,
  onPublish,
  onDiscard,
  onRebase,
}: Props) {
  const [isNaming, setIsNaming] = useState(false)
  const [draftName, setDraftName] = useState('')

  /**
   * Discard is a hard DELETE with no undo (D-15: confirm-only, no soft
   * delete), and it sits one button away from "Back to live plan". So it takes
   * two clicks: the first only swaps the buttons for an inline question that
   * names the what-if being thrown away. No `window.confirm` -- it blocks the
   * page, looks like a browser error, and can be suppressed by the browser.
   */
  //
  // The armed confirm is keyed by scenario id: it belongs to ONE what-if, so
  // switching or leaving can never carry an armed "Yes, delete" over to a
  // different one.
  const [confirmingDiscardFor, setConfirmingDiscardFor] = useState<string | null>(null)
  const confirmingDiscard =
    activeScenario !== null && confirmingDiscardFor === activeScenario.id
  const setConfirmingDiscard = (on: boolean) =>
    setConfirmingDiscardFor(on && activeScenario ? activeScenario.id : null)

  const openScenarios = scenarios.filter((s) => s.publishedAt === null)

  /* ------------------------------------------------------- ephemeral mode -- */

  if (ephemeral) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 rounded-[1.25rem] border border-sky-300 bg-sky-50 px-5 py-3"
      >
        <div>
          <div className="text-sm font-semibold text-sky-950">Exploring — nothing is saved</div>
          <p className="mt-0.5 text-xs text-sky-800">
            Move anything you like. None of it reaches the plan, and it resets when you
            reload.
          </p>
        </div>
        <button
          type="button"
          onClick={onExit}
          className="rounded-[0.95rem] border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-900 transition hover:bg-sky-100"
        >
          Reset
        </button>
      </div>
    )
  }

  /* ---------------------------------------------------------- active mode -- */

  if (activeScenario) {
    return (
      <div
        role="status"
        className="rounded-[1.25rem] border-2 border-amber-400 bg-amber-50 px-5 py-4 shadow-[0_8px_30px_rgba(217,119,6,0.12)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">
                Local copy
              </span>
            </div>
            <div className="mt-1 truncate text-base font-semibold text-amber-950">
              {activeScenario.name}
            </div>
            <p className="mt-0.5 text-xs text-amber-900">
              Changes stay here until you publish. The live plan is untouched.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onExit}
              disabled={busy}
              className="rounded-[0.95rem] border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
            >
              Back to live plan
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDiscard(true)}
              disabled={busy || confirmingDiscard}
              aria-expanded={confirmingDiscard}
              className="rounded-[0.95rem] border border-rose-200 bg-white px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={onPublish}
              disabled={busy}
              className="rounded-[0.95rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-4 py-2 text-sm font-medium text-white shadow transition hover:-translate-y-[1px] disabled:opacity-50"
            >
              {busy ? 'Publishing…' : 'Publish to live plan'}
            </button>
          </div>
        </div>

        {confirmingDiscard ? (
          <div
            role="alertdialog"
            aria-label="Confirm discard"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[1rem] border border-rose-300 bg-rose-50 px-4 py-3"
          >
            <p className="text-sm text-rose-900">
              Discard <span className="font-semibold">&lsquo;{activeScenario.name}&rsquo;</span>?
              Every move in it is deleted. This can&apos;t be undone.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDiscard(false)}
                disabled={busy}
                autoFocus
                className="rounded-[0.9rem] border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDiscard(false)
                  onDiscard()
                }}
                disabled={busy}
                className="rounded-[0.9rem] bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-800 disabled:opacity-50"
              >
                Yes, delete this what-if
              </button>
            </div>
          </div>
        ) : null}

        {rebaseNotice ? (
          <div
            role="status"
            className="mt-3 rounded-[1rem] border border-emerald-300 bg-emerald-50 px-4 py-3 text-xs text-emerald-900"
          >
            {rebaseNotice}
          </div>
        ) : null}

        {/* The conflict is the Revit sync-with-central moment. It gets its own
            explanation and its own action, because "it failed, try again" is
            useless advice here — retrying without rebasing fails identically. */}
        {conflict ? (
          <div className="mt-3 rounded-[1rem] border border-rose-300 bg-rose-50 px-4 py-3">
            <div className="text-sm font-semibold text-rose-900">
              The live plan changed while you were working
            </div>
            <p className="mt-1 text-xs text-rose-800">{conflict}</p>
            <button
              type="button"
              onClick={onRebase}
              disabled={busy}
              className="mt-2 rounded-[0.9rem] border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 transition hover:bg-rose-100 disabled:opacity-50"
            >
              {busy ? 'Pulling in the latest plan…' : 'Pull in the latest plan and keep my moves'}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  /* ------------------------------------------------------------ idle mode -- */

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {isNaming ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!draftName.trim()) return
              onBranch(draftName.trim())
              setDraftName('')
              setIsNaming(false)
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor="scenario-name" className="sr-only">
              Name this what-if
            </label>
            <input
              id="scenario-name"
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="What if we defer the east wing…"
              className="w-72 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
            <button
              type="submit"
              disabled={busy || !draftName.trim()}
              className="rounded-[0.95rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-4 py-2 text-sm font-medium text-white shadow transition hover:-translate-y-[1px] disabled:opacity-50"
            >
              Start
            </button>
            <button
              type="button"
              onClick={() => {
                setIsNaming(false)
                setDraftName('')
              }}
              className="px-2 py-2 text-sm font-medium text-slate-500 transition hover:text-slate-800"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setIsNaming(true)}
            className="rounded-[0.95rem] border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-900"
          >
            Try a what-if
          </button>
        )}

        {openScenarios.length > 0 ? (
          <>
            <label htmlFor="scenario-resume" className="sr-only">
              Resume a saved what-if
            </label>
            <select
              id="scenario-resume"
              value=""
              onChange={(event) => {
                if (event.target.value) onEnter(event.target.value)
              }}
              className="rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            >
              <option value="">Resume… ({openScenarios.length})</option>
              {openScenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
    </div>
  )
}
