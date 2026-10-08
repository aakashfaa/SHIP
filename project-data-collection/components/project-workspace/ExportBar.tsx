'use client'

import { useState } from 'react'
import type { Project } from '@/lib/types'

/**
 * Excel + PDF export controls (spec R8). Deliberately NOT wired into any
 * tab here — the caller decides where it belongs and positions it via
 * `className`.
 *
 * Excel hits the server route (`app/api/projects/[id]/export/xlsx`), which
 * builds a flat, formula-free workbook straight from `lib/cost-model.ts` —
 * see that route and `lib/export/report-data.ts` for the actual work and
 * the commercial constraint (R8.3) on what the file may contain.
 *
 * PDF is a plain browser print (`window.print()`), not a server-rendered
 * one — see the `@media print` block appended to app/globals.css. This is
 * the intentional replacement for the `window.open(...).print()` popup
 * hack in MasterViewTab.tsx's `exportMatrixOnly`: printing the page in
 * place, styled by CSS, is what lets a package's bars and the energy chart
 * (colours, gradients, pixel alignment) survive into the PDF instead of
 * being re-flowed into a bare HTML table in a detached window.
 */

type Props = {
  project: Project
  /**
   * The what-if currently on screen, if any (M-24). Excel then exports THAT
   * schedule (`?scenario=<id>`, priced server-side through the same overlay as
   * the Timeline), so the workbook matches the screen and the printed PDF.
   * Omit / null for the live plan.
   */
  scenario?: { id: string; name: string } | null
  className?: string
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

export default function ExportBar({ project, scenario = null, className = '' }: Props) {
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  async function handleExportExcel() {
    setExportError(null)
    setIsExporting(true)

    try {
      const query = scenario ? `?scenario=${encodeURIComponent(scenario.id)}` : ''
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/export/xlsx${query}`)

      if (!response.ok) {
        let message = `Export failed (${response.status})`
        try {
          const body = (await response.json()) as { error?: string }
          if (body?.error) message = body.error
        } catch {
          // Response body wasn't JSON — the generic status message stands.
        }
        throw new Error(message)
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const slug = scenario
        ? `${slugify(project.name)}-scenario-${slugify(scenario.name)}`
        : slugify(project.name)

      link.href = url
      link.download = `${slug}-export.xlsx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setIsExporting(false)
    }
  }

  function handleExportPdf() {
    window.print()
  }

  return (
    // `.no-print`: these are export controls, not report content — printing
    // them into their own PDF output would be nonsensical. See the
    // `@media print` block in app/globals.css.
    <div className={`no-print flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={handleExportExcel}
        disabled={isExporting}
        className="rounded-[1rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-5 py-3 text-[11px] font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isExporting ? 'Exporting…' : scenario ? 'Export Excel (this what-if)' : 'Export Excel'}
      </button>

      <button
        type="button"
        onClick={handleExportPdf}
        className="rounded-[1rem] border border-slate-200 bg-white px-5 py-3 text-[11px] font-medium text-slate-700 transition hover:-translate-y-[1px] hover:border-slate-300"
      >
        Export PDF
      </button>

      {exportError ? (
        <span className="text-[11px] font-medium text-rose-600">{exportError}</span>
      ) : null}
    </div>
  )
}
