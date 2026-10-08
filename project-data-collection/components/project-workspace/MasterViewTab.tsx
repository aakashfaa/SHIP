'use client'

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import Modal from '@/components/ui/Modal'
import ExportBar from './ExportBar'
import EditableCell from './master-view/EditableCell'
import ColumnsFilter from './view-filter/ColumnsFilter'
import {
  buildRowPatch,
  initialCellValue,
  sameCellValue,
  validateRowDraft,
  type CellValue,
  type RowDraft,
} from './master-view/cell-edit'
import { useAsyncData } from '@/lib/useAsyncData'
import { getFormFieldsForProject, getLineItemsForProject, updateLineItem } from '@/lib/store'
import type { ProjectPermissions } from '@/lib/project-role'
import { useEffectiveViewSettings } from '@/lib/use-effective-view-settings'
import { visibleColumns } from '@/lib/view-settings'
import {
  MASTER_COLUMN_KEYS,
  getMasterViewColumnDefs,
  masterCellText,
  masterExportCell,
  masterExportColumn,
  masterGroupLineText,
  sortMasterRows,
  type MasterColumnDef,
  type MasterSort,
} from '@/lib/view-columns/master'
import { FormField, LineItem, Project } from '@/lib/types'
import {
  clampColumnWidth,
  columnWidthsStorageKey,
  parseColumnWidths,
  type ColumnWidths,
} from '@/lib/column-widths'

type Props = {
  project: Project
  /** Resolved once by the shell (ProjectDashboardShell) so every tab agrees
   *  on one answer without re-issuing the role RPC per tab. */
  permissions: ProjectPermissions
}

/*
 * Columns come from lib/view-columns/master.ts (the client's State House
 * layout: every visible form field, custom ones included, some grouped into
 * one stacked cell, plus the system columns), minus the hidden ones:
 * the project default an admin set for everyone, or this person's own
 * choice from the Filter button (lib/use-effective-view-settings.ts). The
 * exports take the same visible columns.
 *
 * Edit mode (project admins, which includes platform admins: project_role()
 * resolves a platform admin to 'admin'): every form-field cell of every row
 * becomes an input, whoever submitted the row. RLS already allows it --
 * line_items_update (0009) admits any row in my_editable_project_ids(), and
 * 0014's system-column guard only blocks the filing columns, which this
 * never sends. Rows save one at a time, sending only the changed fields.
 */

const DISCIPLINE_COLORS: Record<string, string> = {
  MECHANICAL: '#F4B400',
  PLUMBING: '#D6B3D6',
  ELECTRICAL: '#8CC63F',
  SECURITY: '#9E9E9E',
  FIRE_PROTECTION: '#D9D9D9',
  FIRE_ALARM: '#D9D9D9',
  STRUCTURAL: '#4CC3C7',
  ARCHITECTURE: '#F39C34',
  ARCHITECTURAL: '#F39C34',
  ACCESSIBILITY: '#1F6F2B',
  ENVELOPE: '#1F5E78',
  HISTORIC_PRESERVATION: '#E6CDBF',
  LANDSCAPE: '#C5D9B6',
  CIVIL: '#FF2FB3',
  TELECOM: '#A9D18E',
  TELECOMM: '#A9D18E',
  HAZARDOUS_MATERIALS: '#9C6B3A',
}

function normalizeDiscipline(value: LineItem['discipline']) {
  return value === 'Admin' ? 'Architecture' : value
}

function getDisciplineColor(value: LineItem['discipline']) {
  const key = normalizeDiscipline(value).trim().toUpperCase().replace(/\s+/g, '_')
  return DISCIPLINE_COLORS[key] || '#94A3B8'
}

/** Sticky left offsets (px): 8px colour stripe, then # (72px), then
 *  Name / Description. Both are locked columns, so the offsets never shift. */
const STRIPE_WIDTH = 8
const NUMBER_WIDTH = 72
const NAME_WIDTH = 240

function columnWidthClass(def: MasterColumnDef): string {
  if (def.kind === 'group') return 'min-w-[160px]'
  if (def.kind !== 'field') return def.kind === 'submittedBy' ? 'min-w-[160px]' : 'min-w-[120px]'
  switch (def.field.inputType) {
    case 'textarea':
      return 'min-w-[220px]'
    case 'boolean':
      return 'w-[96px] min-w-[96px]'
    case 'multiselect':
      return 'min-w-[160px]'
    default:
      return 'min-w-[132px]'
  }
}

type RowStatus = { saving?: boolean; error?: string; fieldErrors?: Record<string, string> }

export default function MasterViewTab({ project, permissions }: Props) {
  const [query, setQuery] = useState('')
  const [disciplineFilter, setDisciplineFilter] = useState('all')
  const [orgFilter, setOrgFilter] = useState('all')
  const [sort, setSort] = useState<MasterSort>({ key: MASTER_COLUMN_KEYS.itemNumber, direction: 'asc' })
  const deferredQuery = useDeferredValue(query)

  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({})
  const [confirmDone, setConfirmDone] = useState(false)

  // Project default, or this person's own column choice on top of it.
  const viewSettings = useEffectiveViewSettings(project.id, 'masterView', permissions.isAdmin)
  const hiddenColumns = viewSettings.effective.hiddenColumns

  const { data: formFields, loading: fieldsLoading } = useAsyncData<FormField[]>(
    () => getFormFieldsForProject(project.id),
    [project.id],
    []
  )

  const {
    data: rawLineItems,
    setData: setRawLineItems,
    loading: lineItemsLoading,
    error: lineItemsError,
  } = useAsyncData<LineItem[]>(() => getLineItemsForProject(project.id), [project.id], [])

  const allDefs = useMemo(() => getMasterViewColumnDefs(formFields), [formFields])
  const defs = useMemo(() => {
    const shown = new Set(visibleColumns(allDefs, hiddenColumns).map((c) => c.key))
    return allDefs.filter((def) => shown.has(def.key))
  }, [allDefs, hiddenColumns])

  const fieldByKey = useMemo(() => new Map(formFields.map((f) => [f.key, f])), [formFields])
  const formNotSeeded =
    !fieldsLoading && !allDefs.some((def) => def.kind === 'field' || def.kind === 'group')

  const lineItems = useMemo(
    () =>
      rawLineItems.map((item) => ({
        ...item,
        discipline: normalizeDiscipline(item.discipline),
        companyName: item.companyName || 'FAA',
      })),
    [rawLineItems]
  )
  const rawById = useMemo(() => new Map(rawLineItems.map((item) => [item.id, item])), [rawLineItems])

  const disciplineOptions = useMemo(
    () => Array.from(new Set(lineItems.map((item) => item.discipline))).sort(),
    [lineItems]
  )
  const orgOptions = useMemo(
    () => Array.from(new Set(lineItems.map((item) => item.companyName))).sort(),
    [lineItems]
  )
  const synergyOptions = useMemo(
    () => Array.from(new Set(project.consultants.map((c) => c.type))),
    [project.consultants]
  )

  // Filters and sort apply to what is on screen, and the export takes the
  // rows exactly as filtered and ordered here.
  const rows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    const filtered = lineItems.filter((item) => {
      if (disciplineFilter !== 'all' && item.discipline !== disciplineFilter) return false
      if (orgFilter !== 'all' && item.companyName !== orgFilter) return false
      if (!q) return true
      return defs.some((def) => masterCellText(def, item).toLowerCase().includes(q))
    })
    return sortMasterRows(filtered, defs, sort)
  }, [deferredQuery, defs, disciplineFilter, lineItems, orgFilter, sort])

  const dirtyIds = Object.keys(drafts)
  const savingAny = Object.values(rowStatus).some((s) => s.saving)

  function toggleSort(key: string) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    )
  }

  function exportTable() {
    const filters = [
      disciplineFilter !== 'all' ? disciplineFilter : null,
      orgFilter !== 'all' ? orgFilter : null,
      deferredQuery.trim() ? `"${deferredQuery.trim()}"` : null,
    ].filter(Boolean)
    return {
      title: `${project.name} - Master View`,
      sheetName: 'Master View',
      subtitle: `${rows.length} of ${lineItems.length} items${filters.length ? ` · ${filters.join(' · ')}` : ''}`,
      columns: defs.map(masterExportColumn),
      rows: rows.map((item) => defs.map((def) => masterExportCell(def, item))),
    }
  }

  /* --------------------------------------------------------- edit mode -- */

  function setCell(item: LineItem, field: FormField, value: CellValue) {
    const initial = initialCellValue(field, rawById.get(item.id) ?? item)
    setDrafts((prev) => {
      const row = { ...(prev[item.id] ?? {}) }
      if (sameCellValue(value, initial)) delete row[field.key]
      else row[field.key] = value
      const next = { ...prev }
      if (Object.keys(row).length === 0) delete next[item.id]
      else next[item.id] = row
      return next
    })
    setRowStatus((prev) => {
      const status = prev[item.id]
      if (!status?.fieldErrors?.[field.key] && !status?.error) return prev
      const fieldErrors = { ...(status.fieldErrors ?? {}) }
      delete fieldErrors[field.key]
      return { ...prev, [item.id]: { ...status, error: undefined, fieldErrors } }
    })
  }

  function revertRow(id: string) {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRowStatus((prev) => ({ ...prev, [id]: {} }))
  }

  async function saveRow(id: string): Promise<boolean> {
    const draft = drafts[id]
    const item = rawById.get(id)
    if (!draft || !item) return true

    const fieldErrors = validateRowDraft(formFields, draft)
    if (Object.keys(fieldErrors).length > 0) {
      setRowStatus((prev) => ({ ...prev, [id]: { error: 'Fix the highlighted cells.', fieldErrors } }))
      return false
    }

    setRowStatus((prev) => ({ ...prev, [id]: { saving: true } }))
    try {
      const updated = await updateLineItem(id, buildRowPatch(item, formFields, draft))
      if (!updated) throw new Error('Not saved: this row no longer exists or you lost access to it.')
      setRawLineItems((prev) => prev.map((row) => (row.id === id ? updated : row)))
      setDrafts((prev) => {
        // Keep anything typed into the row while the save was in flight.
        const current = prev[id]
        const next = { ...prev }
        if (!current || current === draft) delete next[id]
        return next
      })
      setRowStatus((prev) => ({ ...prev, [id]: {} }))
      return true
    } catch (err) {
      setRowStatus((prev) => ({
        ...prev,
        [id]: { error: err instanceof Error ? err.message : 'Failed to save.' },
      }))
      return false
    }
  }

  async function saveAll() {
    for (const id of dirtyIds) await saveRow(id)
  }

  function finishEditing() {
    if (dirtyIds.length > 0) {
      setConfirmDone(true)
      return
    }
    setEditing(false)
    setRowStatus({})
  }

  function discardAndFinish() {
    setDrafts({})
    setRowStatus({})
    setConfirmDone(false)
    setEditing(false)
  }

  const canEditRows = permissions.isAdmin && !lineItemsLoading && !lineItemsError && !formNotSeeded

  // Personal column widths (localStorage, per project). # stays fixed;
  // every other column, Name / Description included, can be dragged.
  const [colWidths, setColWidths] = useState<ColumnWidths>({})
  const colWidthsRef = useRef<ColumnWidths>({})
  const dragRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  const storageKey = columnWidthsStorageKey(project.id)

  useEffect(() => {
    let stored: ColumnWidths = {}
    try {
      stored = parseColumnWidths(window.localStorage.getItem(storageKey))
    } catch {
      // Storage unavailable: default widths.
    }
    colWidthsRef.current = stored
    setColWidths(stored)
  }, [storageKey])

  function applyWidths(next: ColumnWidths) {
    colWidthsRef.current = next
    setColWidths(next)
  }

  function saveWidths() {
    try {
      const current = colWidthsRef.current
      if (Object.keys(current).length === 0) window.localStorage.removeItem(storageKey)
      else window.localStorage.setItem(storageKey, JSON.stringify(current))
    } catch {
      // Storage unavailable: the width still applies for this visit.
    }
  }

  function startResize(e: ReactPointerEvent<HTMLElement>, key: string) {
    e.preventDefault()
    e.stopPropagation()
    const th = e.currentTarget.parentElement
    const startWidth = colWidthsRef.current[key] ?? th?.getBoundingClientRect().width ?? 0
    dragRef.current = { key, startX: e.clientX, startWidth }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function moveResize(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag) return
    applyWidths({
      ...colWidthsRef.current,
      [drag.key]: clampColumnWidth(drag.startWidth + e.clientX - drag.startX),
    })
  }

  function endResize(e: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    saveWidths()
  }

  function resetWidth(key: string) {
    const next = { ...colWidthsRef.current }
    delete next[key]
    applyWidths(next)
    saveWidths()
  }

  /** The width a column is pinned to, or undefined to let it size itself. */
  function widthOf(def: MasterColumnDef): number | undefined {
    if (def.key === MASTER_COLUMN_KEYS.itemNumber) return NUMBER_WIDTH
    const custom = colWidths[def.key]
    if (custom !== undefined) return custom
    return def.key === MASTER_COLUMN_KEYS.nameDescription ? NAME_WIDTH : undefined
  }

  // # and Name / Description are the only sticky columns and # is fixed, so
  // Name's offset never moves; Name's own width does not affect any offset.
  function stickyLeft(def: MasterColumnDef): number | undefined {
    if (def.key === MASTER_COLUMN_KEYS.itemNumber) return STRIPE_WIDTH
    if (def.key === MASTER_COLUMN_KEYS.nameDescription) return STRIPE_WIDTH + NUMBER_WIDTH
    return undefined
  }

  /** One field's edit control (shared by single-field and grouped cells). */
  function fieldEditor(
    item: LineItem,
    raw: LineItem,
    draft: RowDraft | undefined,
    status: RowStatus,
    base: FormField
  ) {
    const field = fieldByKey.get(base.key) ?? base
    const value = draft && field.key in draft ? draft[field.key] : initialCellValue(field, raw)
    return (
      <>
        <EditableCell
          field={field}
          value={value}
          onChange={(next) => setCell(item, field, next)}
          error={status.fieldErrors?.[field.key]}
          disabled={status.saving}
          synergyOptions={synergyOptions.filter((t) => t !== item.discipline)}
        />
        {status.fieldErrors?.[field.key] ? (
          <p className="mt-1 max-w-[220px] text-[10px] text-rose-600">{status.fieldErrors[field.key]}</p>
        ) : null}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search line items"
          className="min-w-[180px] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 sm:max-w-xs"
        />
        <select
          value={disciplineFilter}
          onChange={(e) => setDisciplineFilter(e.target.value)}
          aria-label="Discipline"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900"
        >
          <option value="all">All disciplines</option>
          {disciplineOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <select
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          aria-label="Organization"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900"
        >
          <option value="all">All organizations</option>
          {orgOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-500">
          {rows.length} of {lineItems.length}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              {dirtyIds.length > 0 ? (
                <>
                  <span className="text-xs text-amber-700">{dirtyIds.length} unsaved</span>
                  <button
                    type="button"
                    onClick={saveAll}
                    disabled={savingAny}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-300 disabled:opacity-60"
                  >
                    Save all
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={finishEditing}
                disabled={savingAny}
                className="rounded-xl bg-black px-4 py-2 text-xs font-medium text-white transition hover:-translate-y-[1px] disabled:opacity-60"
              >
                Done
              </button>
            </>
          ) : (
            <>
              {/* R8.4: a viewer gets the on-screen read only, no file to
                  carry off -- hidden, not just disabled. */}
              <ColumnsFilter view={viewSettings} columns={allDefs} />
              {permissions.isViewer ? null : <ExportBar project={project} table={exportTable} />}
              {canEditRows ? (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-300"
                >
                  Edit
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {formNotSeeded ? (
        <EmptyState tone="amber">No form fields yet. Add them in Settings.</EmptyState>
      ) : lineItemsLoading || fieldsLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : lineItemsError ? (
        <EmptyState tone="rose">Couldn&apos;t load line items.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>{lineItems.length === 0 ? 'No line items yet.' : 'No matches.'}</EmptyState>
      ) : (
        // Its own scroll box, both axes: sticky header and sticky columns
        // stick to THIS box, not to the workspace scroller around it.
        <div data-testid="master-view-table" className="min-h-0 flex-1 overflow-auto rounded-[1.5rem] border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-max border-separate border-spacing-0 text-[11px] leading-4 text-slate-700">
            <thead>
              <tr className="text-left">
                <th
                  className="sticky left-0 top-0 z-30 border-b border-r border-slate-200 bg-slate-100 p-0"
                  style={{ width: STRIPE_WIDTH, minWidth: STRIPE_WIDTH }}
                />
                {defs.map((def) => {
                  const left = stickyLeft(def)
                  const width = widthOf(def)
                  const resizable = def.key !== MASTER_COLUMN_KEYS.itemNumber
                  const active = sort.key === def.key
                  return (
                    <th
                      key={def.key}
                      style={{ left, width, minWidth: width, maxWidth: width }}
                      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={`sticky top-0 border-b border-r border-slate-200 bg-slate-100 p-0 ${
                        left !== undefined ? 'z-30' : 'z-20'
                      } ${width ? '' : columnWidthClass(def)}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(def.key)}
                        className="flex w-full items-center gap-1 px-2 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 hover:text-slate-950"
                      >
                        <span>{def.label}</span>
                        <span aria-hidden className="inline-block w-2 text-slate-950">
                          {active ? (sort.direction === 'desc' ? '↓' : '↑') : null}
                        </span>
                      </button>
                      {resizable ? (
                        <span
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${def.label} column`}
                          title="Drag to resize, double-click to reset"
                          onPointerDown={(e) => startResize(e, def.key)}
                          onPointerMove={moveResize}
                          onPointerUp={endResize}
                          onPointerCancel={endResize}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            resetWidth(def.key)
                          }}
                          className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize touch-none select-none bg-slate-400/0 transition-colors hover:bg-slate-400/60 active:bg-slate-500/70"
                        />
                      ) : null}
                    </th>
                  )
                })}
                {editing ? (
                  <th className="sticky right-0 top-0 z-30 min-w-[132px] border-b border-l border-slate-200 bg-slate-100 px-2 py-3" />
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const color = getDisciplineColor(item.discipline)
                const tint = `${color}10`
                const draft = drafts[item.id]
                const status = rowStatus[item.id] ?? {}
                const raw = rawById.get(item.id) ?? item

                return (
                  <tr
                    key={item.id}
                    style={{ backgroundColor: tint }}
                    onKeyDown={(e) => {
                      // Enter in a single-line input saves the row.
                      const target = e.target as HTMLElement
                      if (
                        editing &&
                        e.key === 'Enter' &&
                        target instanceof HTMLInputElement &&
                        target.type !== 'checkbox' &&
                        draft
                      ) {
                        e.preventDefault()
                        void saveRow(item.id)
                      }
                    }}
                  >
                    <td
                      className="sticky left-0 z-10 border-b border-slate-200 p-0"
                      style={{ backgroundColor: color, width: STRIPE_WIDTH, minWidth: STRIPE_WIDTH }}
                    />
                    {defs.map((def) => {
                      const left = stickyLeft(def)
                      const w = widthOf(def)
                      const widthStyle = w !== undefined ? { width: w, minWidth: w, maxWidth: w } : undefined
                      const stickyStyle =
                        left !== undefined
                          ? {
                              left,
                              ...widthStyle,
                              // Opaque, or the cells scrolling under it show through.
                              backgroundImage: `linear-gradient(${tint}, ${tint})`,
                              backgroundColor: '#fff',
                            }
                          : widthStyle
                      // A pinned width wraps long text instead of widening the column.
                      const cellClass = `border-b border-r border-slate-200 px-2 py-2 align-top ${
                        left !== undefined ? 'sticky z-10' : ''
                      } ${w !== undefined ? '[overflow-wrap:anywhere]' : ''}`

                      if (def.kind === 'itemNumber') {
                        return (
                          <td key={def.key} style={stickyStyle} className={cellClass}>
                            <span
                              className="inline-flex rounded-full px-2 py-1 text-[10px] font-semibold text-slate-950"
                              style={{ backgroundColor: `${color}2A` }}
                            >
                              {item.itemNumber}
                            </span>
                          </td>
                        )
                      }

                      if (def.kind === 'field' && editing) {
                        return (
                          <td
                            key={def.key}
                            style={stickyStyle}
                            className={`${cellClass} ${draft && def.key in draft ? 'bg-amber-50/70' : ''}`}
                          >
                            {fieldEditor(item, raw, draft, status, def.field)}
                          </td>
                        )
                      }

                      if (def.kind === 'group' && editing) {
                        // One edit control per member field, stacked; each
                        // drafts and validates under its own field key.
                        const changed = Boolean(draft && def.lines.some((line) => line.field.key in draft))
                        return (
                          <td
                            key={def.key}
                            style={stickyStyle}
                            className={`${cellClass} ${changed ? 'bg-amber-50/70' : ''}`}
                          >
                            <div className="space-y-1.5">
                              {def.lines.map((line) => (
                                <div key={line.field.key}>
                                  {line.prefix ? (
                                    <span className="mb-0.5 block text-[10px] font-medium text-slate-500">
                                      {line.prefix}
                                    </span>
                                  ) : null}
                                  {fieldEditor(item, raw, draft, status, line.field)}
                                </div>
                              ))}
                            </div>
                          </td>
                        )
                      }

                      if (def.kind === 'group') {
                        const lines = def.lines
                          .map((line, index) => ({
                            key: line.field.key,
                            text: masterGroupLineText(line, item),
                            bold: def.emphasizeFirst === true && index === 0,
                          }))
                          .filter((line) => line.text !== '')
                        return (
                          <td key={def.key} style={stickyStyle} className={cellClass}>
                            {lines.length === 0
                              ? '-'
                              : lines.map((line) => (
                                  <div
                                    key={line.key}
                                    className={`whitespace-pre-line ${
                                      line.bold ? 'font-semibold text-slate-900' : ''
                                    }`}
                                  >
                                    {line.text}
                                  </div>
                                ))}
                          </td>
                        )
                      }

                      if (def.kind === 'field' && def.field.inputType === 'boolean') {
                        const v = initialCellValue(def.field, item)
                        return (
                          <td key={def.key} style={stickyStyle} className={`${cellClass} text-center text-sm font-semibold text-slate-800`}>
                            {v === true ? 'Y' : v === false ? 'N' : '-'}
                          </td>
                        )
                      }

                      return (
                        <td key={def.key} style={stickyStyle} className={cellClass}>
                          {masterCellText(def, item) || '-'}
                        </td>
                      )
                    })}
                    {editing ? (
                      <td className="sticky right-0 z-10 border-b border-l border-slate-200 bg-white px-2 py-2 align-top">
                        <RowActions
                          dirty={Boolean(draft)}
                          saving={Boolean(status.saving)}
                          error={status.error}
                          onSave={() => void saveRow(item.id)}
                          onRevert={() => revertRow(item.id)}
                        />
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={confirmDone}
        onClose={() => setConfirmDone(false)}
        title="Discard unsaved changes?"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmDone(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={discardAndFinish}
              className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white"
            >
              Discard
            </button>
          </div>
        }
      >
        <p className="text-sm text-slate-600">
          {dirtyIds.length} {dirtyIds.length === 1 ? 'row has' : 'rows have'} unsaved changes.
        </p>
      </Modal>
    </div>
  )
}

function RowActions({
  dirty,
  saving,
  error,
  onSave,
  onRevert,
}: {
  dirty: boolean
  saving: boolean
  error?: string
  onSave: () => void
  onRevert: () => void
}) {
  if (saving) return <span className="text-[11px] text-slate-500">Saving…</span>
  return (
    <div className="space-y-1">
      {dirty ? (
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onSave}
            className="rounded-lg bg-black px-2.5 py-1 text-[11px] font-medium text-white"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onRevert}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600"
          >
            Revert
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-[160px] text-[10px] text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function EmptyState({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'amber' | 'rose' }) {
  const border = tone === 'amber' ? 'border-amber-300' : tone === 'rose' ? 'border-rose-300' : 'border-gray-300'
  const text = tone === 'rose' ? 'text-rose-600' : 'text-gray-500'
  return (
    <div className={`rounded-[1.5rem] border border-dashed ${border} bg-white p-12 text-center`}>
      <p className={`text-sm ${text}`}>{children}</p>
    </div>
  )
}
