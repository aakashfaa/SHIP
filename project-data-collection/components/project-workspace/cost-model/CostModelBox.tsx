'use client'

import { useState } from 'react'
import Modal from '@/components/ui/Modal'
import { getPhaseTemplates } from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import type { PhaseTemplate, ProjectCostSettings, ProjectEnergySettings } from '@/lib/types'
import CostModelEditor, { type CostModelSaveStatus } from './CostModelEditor'

/**
 * The Timeline's "Cost model" box: a terse read-only summary of the
 * assumptions every figure on the Timeline is priced from, and the button
 * that opens the full editor in a popup.
 *
 * Escalation is NOT a slider you nudge while presenting -- changing it
 * re-prices the entire plan, which is a decision, not a gesture -- hence a
 * popup rather than inline controls. Anyone who cannot edit gets the same
 * popup read-only.
 *
 * The summary renders the rows the Timeline itself prices from (passed in),
 * so what it says and what the totals use can never disagree.
 *
 * Save state is held HERE, not in the editor, because the editor's last
 * write can land (or fail) after the popup has closed. A failure then shows
 * under the box with a way back in, instead of the user walking away
 * believing it saved.
 */

type Props = {
  projectId: string
  canEdit: boolean
  costRow: ProjectCostSettings | null
  energyRow: ProjectEnergySettings | null
  /** A cost or energy setting was written; re-read and re-price. */
  onChanged: () => void
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  )
}

function describeEscalation(row: ProjectCostSettings): string {
  const rate = `${row.escalationAnnualPercent}%/yr`
  const shape =
    row.escalationMode === 'stepped'
      ? `stepped every ${row.escalationStepYears} yr${row.escalationStepYears === 1 ? '' : 's'}`
      : `compound, to ${row.escalationBasis}`
  const overrides =
    row.rateOverrides.length > 0
      ? ` · ${row.rateOverrides.length} year${row.rateOverrides.length === 1 ? '' : 's'} overridden`
      : ''
  return `${rate} ${shape}${overrides}`
}

function SummaryItem({
  label,
  value,
  warn = false,
}: {
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </dt>
      <dd
        className={`truncate text-sm font-semibold ${warn ? 'text-amber-700' : 'text-slate-900'}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

export default function CostModelBox({ projectId, canEdit, costRow, energyRow, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<CostModelSaveStatus>({ state: 'idle' })

  // The project's one phase template; every package's phases come from it.
  const { data: templates } = useAsyncData<PhaseTemplate[]>(
    () => getPhaseTemplates(projectId),
    [projectId],
    []
  )
  const templateName = costRow?.defaultPhaseTemplateId
    ? (templates.find((t) => t.id === costRow.defaultPhaseTemplateId)?.name ?? '…')
    : 'Not set'

  function openEditor() {
    // A fresh editor starts with a clean slate; the old failure is shown
    // again only if a write in this session fails too.
    setStatus({ state: 'idle' })
    setOpen(true)
  }

  function close() {
    setOpen(false)
    // Belt and braces with the editor's per-write callback: whatever was
    // written while the popup was open, the Timeline re-reads it now.
    onChanged()
  }

  return (
    <div className="no-print rounded-[1.25rem] border border-slate-200 bg-slate-50/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-slate-700">Cost model</div>
        <button
          type="button"
          onClick={openEditor}
          className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-500"
        >
          {canEdit ? 'Edit cost model' : 'View'}
        </button>
      </div>

      {costRow ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
          <div className="col-span-2">
            <SummaryItem label="Phase template" value={templateName} />
          </div>
          <SummaryItem label="TPC factor" value={`${costRow.tpcFactor}×`} />
          <SummaryItem
            label="Base year"
            value={costRow.baseYear !== null ? String(costRow.baseYear) : 'Not set'}
            warn={costRow.baseYear === null}
          />
          <SummaryItem
            label="Energy baseline"
            value={
              energyRow?.baselineAnnual != null
                ? `${formatCompact(energyRow.baselineAnnual)} ${energyRow.unitLabel}`.trim()
                : 'Not set'
            }
          />
          <div className="col-span-2">
            <SummaryItem label="Escalation" value={describeEscalation(costRow)} />
          </div>
        </dl>
      ) : (
        <div className="mt-3 text-xs text-slate-400">Loading…</div>
      )}

      {!open && status.state === 'error' ? (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[0.9rem] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span>Couldn&apos;t save cost model change: {status.message}</span>
          <button
            type="button"
            onClick={openEditor}
            className="rounded-full border border-red-300 bg-white px-2.5 py-0.5 font-semibold text-red-700 transition hover:bg-red-100"
          >
            Reopen
          </button>
        </div>
      ) : null}
      {!open && status.state === 'saving' ? (
        <div role="status" className="mt-3 text-xs text-slate-500">
          Saving…
        </div>
      ) : null}

      <Modal
        open={open}
        onClose={close}
        // With a failed save on screen, Escape and the backdrop do nothing:
        // the only way out is the button that says "Close anyway".
        dismissable={status.state !== 'error'}
        title={canEdit ? 'Cost model' : 'Cost model (read-only)'}
        size="xl"
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
              onClick={close}
              className={`rounded-[0.95rem] px-4 py-2 text-sm font-medium text-white transition ${
                status.state === 'error'
                  ? 'bg-red-700 hover:bg-red-800'
                  : 'bg-slate-950 hover:bg-slate-800'
              }`}
            >
              {status.state === 'error' ? 'Close anyway' : 'Done'}
            </button>
          </>
        }
      >
        {open ? (
          <CostModelEditor
            projectId={projectId}
            readOnly={!canEdit}
            onSaved={onChanged}
            onStatus={setStatus}
          />
        ) : null}
      </Modal>
    </div>
  )
}
