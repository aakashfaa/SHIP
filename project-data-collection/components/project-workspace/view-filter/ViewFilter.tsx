'use client'

import { ReactNode, useEffect, useRef, useState } from 'react'

/**
 * The "Filter" button every view (Master View, Packaging, Timeline) puts in its
 * header, and the popover it opens. The view supplies the controls; this
 * supplies the shell: a badge with how much is hidden, "Reset to project
 * default" when this person has their own filter, and -- for project
 * admins -- "Save as default for everyone".
 *
 * See lib/use-effective-view-settings.ts for how personal and project
 * settings combine.
 */
type Props = {
  /** How many things are hidden/off; 0 shows no badge. */
  badge: number
  isPersonal: boolean
  onReset: () => void
  /** Project admins only. */
  canSaveDefault: boolean
  /** False until the project default has loaded: the save button shows,
   *  disabled. */
  saveDefaultReady?: boolean
  onSaveDefault: () => Promise<void>
  children: ReactNode
  align?: 'left' | 'right'
}

export default function ViewFilter({
  badge,
  isPersonal,
  onReset,
  canSaveDefault,
  saveDefaultReady = true,
  onSaveDefault,
  children,
  align = 'right',
}: Props) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function saveDefault() {
    setSaving(true)
    setError(null)
    try {
      await onSaveDefault()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={ref} className="relative no-print">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="view-filter-button"
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition ${
          badge > 0 || isPersonal
            ? 'border-slate-900 bg-slate-900 text-white'
            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
        }`}
      >
        <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" strokeLinejoin="round" />
        </svg>
        Filter
        {badge > 0 ? (
          <span
            data-testid="view-filter-badge"
            className="ml-0.5 rounded-full bg-white px-1.5 text-[10px] font-semibold leading-4 text-slate-900"
          >
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Filter"
          className={`absolute top-full z-50 mt-2 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_20px_60px_rgba(15,23,42,0.18)] ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="max-h-[55vh] overflow-auto">{children}</div>

          {isPersonal || error ? (
            <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
              {isPersonal ? (
                <button
                  type="button"
                  onClick={onReset}
                  disabled={saving}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:border-slate-300 disabled:opacity-60"
                >
                  Reset to project default
                </button>
              ) : null}
              {isPersonal && canSaveDefault ? (
                <button
                  type="button"
                  onClick={() => void saveDefault()}
                  disabled={saving || !saveDefaultReady}
                  className="w-full rounded-xl bg-black px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save as default for everyone'}
                </button>
              ) : null}
              {error ? (
                <p role="alert" className="text-[11px] text-rose-600">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
