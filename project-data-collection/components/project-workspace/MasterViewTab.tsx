'use client'

import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { useAsyncData } from '@/lib/useAsyncData'
import { getFormFieldsForProject, getLineItemsForProject, visibleFormFields } from '@/lib/store'
import type { ProjectPermissions } from '@/lib/project-role'
import { FormField, LineItem, Project } from '@/lib/types'

type Props = {
  project: Project
  /** Resolved once by the shell (ProjectDashboardShell) so every tab agrees
   *  on one answer without re-issuing the role RPC per tab. */
  permissions: ProjectPermissions
}

type SortKey = 'itemNumber' | 'name' | 'discipline' | 'companyName' | 'relativeFirstCost'

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

/*
 * migration 0012 turned the fixed column list into `form_fields` data (see
 * lib/store.ts getFormFieldsForProject / visibleFormFields). Everything a
 * consultant actually FILLS IN on the form -- name, category, the strategic
 * flags, a custom "Funding source" a firm added in Settings -- is rendered
 * here as one column per visible field, in field sort order, instead of a
 * column list this component owns.
 *
 * The columns that survive as hardcoded are the ones that are NOT form
 * fields at all: the discipline colour stripe, item number, discipline,
 * organization and submitted-by are system-managed (item/company/discipline
 * triggers, auth) -- see the "Columns deliberately absent" comment in
 * migration 0012's default_form_fields().
 */

/** Same mechanical key->property mapping AddDataTab.tsx uses, and the same
 *  one exception -- see the comment there. Duplicated rather than shared
 *  because lib/ is off limits for this change and these two components do
 *  not otherwise import from each other. */
const CAMEL_CASE_OVERRIDES: Record<string, string> = {
  electrification_eo594: 'electrificationEO594',
}

function toCamelCase(key: string): string {
  return CAMEL_CASE_OVERRIDES[key] ?? key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** Reads a field's value off a line item, hiding the `storage: 'column'` vs
 *  `'custom'` split the same way AddDataTab's get/set pair does -- this
 *  side only ever needs to read. */
function getFieldValue(item: LineItem, field: FormField): unknown {
  if (field.storage === 'custom') return item.customFields?.[field.key]
  return (item as unknown as Record<string, unknown>)[toCamelCase(field.key)]
}

function formatFieldValue(field: FormField, value: unknown): string {
  if (field.inputType === 'multiselect') {
    return Array.isArray(value) && value.length > 0 ? value.join(', ') : '-'
  }
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

function columnWidthClass(field: FormField): string {
  if (field.inputType === 'textarea') return 'min-w-[200px]'
  if (field.inputType === 'boolean') return 'w-[104px]'
  if (field.inputType === 'multiselect') return 'w-[140px]'
  return 'min-w-[128px]'
}

function getDisciplineKey(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '_')
}

function normalizeDiscipline(value: LineItem['discipline']) {
  return value === 'Admin' ? 'Architecture' : value
}

function getDisciplineColor(value: LineItem['discipline']) {
  return DISCIPLINE_COLORS[getDisciplineKey(normalizeDiscipline(value))] || '#94A3B8'
}

function colorTint(hex: string, opacity: string) {
  return `${hex}${opacity}`
}

function itemNumberSort(a: string, b: string) {
  const aMatch = a.match(/^([A-Z]+)(\d+)$/i)
  const bMatch = b.match(/^([A-Z]+)(\d+)$/i)

  if (!aMatch || !bMatch) return a.localeCompare(b)

  const [, aPrefix, aNum] = aMatch
  const [, bPrefix, bNum] = bMatch

  if (aPrefix !== bPrefix) return aPrefix.localeCompare(bPrefix)
  return Number(aNum) - Number(bNum)
}

function sortLineItems(items: LineItem[], sortKey: SortKey) {
  return [...items].sort((a, b) => {
    if (sortKey === 'itemNumber') return itemNumberSort(a.itemNumber, b.itemNumber)
    return a[sortKey].localeCompare(b[sortKey])
  })
}

export default function MasterViewTab({ project, permissions }: Props) {
  const exportRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState('')
  const [disciplineFilter, setDisciplineFilter] = useState('all')
  const [orgFilter, setOrgFilter] = useState('all')
  const [sortKey, setSortKey] = useState<SortKey>('itemNumber')
  const deferredQuery = useDeferredValue(query)

  const {
    data: formFields,
    loading: fieldsLoading,
  } = useAsyncData<FormField[]>(
    () => getFormFieldsForProject(project.id),
    [project.id],
    []
  )

  const visibleFields = useMemo(() => visibleFormFields(formFields), [formFields])

  // Empty rather than crashing: an unseeded project has no columns to build,
  // and the right response is pointing at Settings, not a hardcoded list of
  // some other firm's questions.
  const formNotSeeded = !fieldsLoading && visibleFields.length === 0

  const {
    data: rawLineItems,
    loading: lineItemsLoading,
    error: lineItemsError,
  } = useAsyncData<LineItem[]>(
    () => getLineItemsForProject(project.id),
    [project.id],
    []
  )

  const lineItems = useMemo(
    () =>
      rawLineItems.map((item) => ({
        ...item,
        discipline: normalizeDiscipline(item.discipline),
        companyName: item.companyName || 'FAA',
        estimatedFirstCost: item.estimatedFirstCost || '',
      })),
    [rawLineItems]
  )

  const disciplineOptions = useMemo(
    () => Array.from(new Set(lineItems.map((item) => item.discipline))).sort(),
    [lineItems]
  )

  const orgOptions = useMemo(
    () => Array.from(new Set(lineItems.map((item) => item.companyName))).sort(),
    [lineItems]
  )

  const filteredItems = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase()

    const filtered = lineItems.filter((item) => {
      const matchesQuery =
        !normalizedQuery ||
        [
          item.itemNumber,
          item.name,
          item.shortDescription,
          item.discipline,
          item.companyName,
          item.category,
          item.timelinePriority,
          item.buildingAreaImpacted,
          item.buildingLevelImpacted,
          item.supportingNotes,
          item.relativeFirstCost,
          item.estimatedFirstCost,
          JSON.stringify(item.customFields ?? {}),
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery)

      const matchesDiscipline =
        disciplineFilter === 'all' || item.discipline === disciplineFilter
      const matchesOrg = orgFilter === 'all' || item.companyName === orgFilter

      return matchesQuery && matchesDiscipline && matchesOrg
    })

    return sortLineItems(filtered, sortKey)
  }, [deferredQuery, disciplineFilter, lineItems, orgFilter, sortKey])

  function exportMatrixOnly() {
    const matrixHtml = exportRef.current?.innerHTML
    if (!matrixHtml) return

    const printWindow = window.open('', '_blank', 'width=1500,height=900')
    if (!printWindow) return

    printWindow.document.write(`
      <html>
        <head>
          <title>${project.name} - Master View</title>
          <style>
            * { box-sizing: border-box; }
            body { margin: 24px; font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; }
            th, td { border: 1px solid #dbe1ea; padding: 8px 6px; vertical-align: top; word-break: break-word; }
            th { background: #e2e8f0; text-transform: uppercase; letter-spacing: .04em; font-size: 9px; }
          </style>
        </head>
        <body>
          <h1>${project.name}</h1>
          <p>Master View export</p>
          ${matrixHtml}
        </body>
      </html>
    `)

    printWindow.document.close()
    printWindow.focus()
    printWindow.print()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-950">Master View</h2>
            <p className="mt-1 text-sm text-slate-500">
              Query, filter, and sort the full line-item matrix without discipline section breaks.
            </p>
          </div>

          {/* R8.4: a viewer does not get a copy of the plan to carry off, only
              the on-screen read of it. Master View is open to every role
              (unlike Add Data), so this button — not a route gate — is the
              only thing standing between a viewer and the full matrix, and it
              has to be hidden rather than merely disabled. */}
          {permissions.isViewer ? null : (
            <button
              type="button"
              onClick={exportMatrixOnly}
              className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
            >
              Export PDF
            </button>
          )}
        </div>

        <div className="grid gap-3 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search line items, notes, orgs, disciplines"
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-900"
          />
          <select
            value={disciplineFilter}
            onChange={(e) => setDisciplineFilter(e.target.value)}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-900"
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
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-900"
          >
            <option value="all">All organizations</option>
            {orgOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-900"
          >
            <option value="itemNumber">Sort: Item #</option>
            <option value="name">Sort: Name</option>
            <option value="discipline">Sort: Discipline</option>
            <option value="companyName">Sort: Organization</option>
            <option value="relativeFirstCost">Sort: First Cost</option>
          </select>
        </div>

        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-slate-100 px-3 py-1.5">
            {filteredItems.length} shown
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">
            {lineItems.length} total
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">{project.name}</span>
        </div>
      </div>

      {formNotSeeded ? (
        <div className="rounded-[2rem] border border-dashed border-amber-300 bg-white p-12 text-center">
          <h4 className="text-lg font-semibold text-gray-900">No form configured</h4>
          <p className="mt-2 text-sm text-gray-500">
            This project has no line-item form fields yet. Add fields in Settings &rarr; Line item
            form.
          </p>
        </div>
      ) : lineItemsLoading || fieldsLoading ? (
        <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white p-12 text-center">
          <p className="text-sm text-gray-500">Loading line items...</p>
        </div>
      ) : lineItemsError ? (
        <div className="rounded-[2rem] border border-dashed border-rose-300 bg-white p-12 text-center">
          <p className="text-sm text-rose-600">Could not load line items. Please try again.</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white p-12 text-center">
          <h4 className="text-lg font-semibold text-gray-900">No matching line items</h4>
          <p className="mt-2 text-sm text-gray-500">Adjust the search or filters to widen the view.</p>
        </div>
      ) : (
        <div
          ref={exportRef}
          className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm"
        >
          <table className="w-full border-collapse text-[11px] leading-4 text-slate-700">
            <thead>
              <tr className="bg-slate-100 text-left">
                <th className="w-2 border-b border-r border-slate-200 p-0" />
                <HeaderCell className="w-[72px]">#</HeaderCell>
                <HeaderCell className="min-w-[128px]">Discipline</HeaderCell>
                <HeaderCell className="min-w-[144px]">Organization</HeaderCell>
                {visibleFields.map((field) => (
                  <HeaderCell key={field.id} className={columnWidthClass(field)}>
                    {field.label}
                  </HeaderCell>
                ))}
                <HeaderCell className="w-[150px]">Submitted By</HeaderCell>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => {
                const color = getDisciplineColor(item.discipline)

                return (
                  <tr key={item.id} style={{ backgroundColor: colorTint(color, '10') }}>
                    <td className="w-2 p-0" style={{ backgroundColor: color }} />
                    <BodyCell>
                      <span
                        className="inline-flex rounded-full px-2 py-1 text-[10px] font-semibold text-slate-950"
                        style={{ backgroundColor: colorTint(color, '2A') }}
                      >
                        {item.itemNumber}
                      </span>
                    </BodyCell>
                    <BodyCell>{item.discipline}</BodyCell>
                    <BodyCell>{item.companyName}</BodyCell>
                    {visibleFields.map((field) => {
                      const raw = getFieldValue(item, field)

                      if (field.inputType === 'boolean') {
                        const isYes = raw === true || raw === 'Yes'
                        return (
                          <BodyCell key={field.id} centered>
                            {isYes ? 'Y' : ''}
                          </BodyCell>
                        )
                      }

                      return <BodyCell key={field.id}>{formatFieldValue(field, raw)}</BodyCell>
                    })}
                    <BodyCell>{item.userEmail}</BodyCell>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function HeaderCell({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <th className={`border-b border-r border-slate-200 px-2 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 ${className}`}>
      {children}
    </th>
  )
}

function BodyCell({
  children,
  centered = false,
}: {
  children: React.ReactNode
  centered?: boolean
}) {
  return (
    <td
      className={`border-b border-r border-slate-200 px-2 py-3 align-top ${
        centered ? 'text-center text-sm font-semibold text-slate-800' : ''
      }`}
    >
      {children}
    </td>
  )
}
