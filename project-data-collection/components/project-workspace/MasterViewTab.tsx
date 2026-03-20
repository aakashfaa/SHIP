'use client'

import { useMemo, useRef } from 'react'
import { getLineItemsForProject } from '@/lib/store'
import { ConsultantType, LineItem, Project } from '@/lib/types'

type Props = {
  project: Project
}

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
  'HAZARDOUS MATERIALS': '#9C6B3A',
}

function getDisciplineKey(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '_')
}

function normalizeDiscipline(value: LineItem['discipline']): ConsultantType {
  return value === 'Admin' ? 'Architecture' : value
}

function getDisciplineColor(value: LineItem['discipline']) {
  const normalized = normalizeDiscipline(value)
  return DISCIPLINE_COLORS[getDisciplineKey(normalized)] || '#111111'
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

function yn(value: string) {
  return value === 'Yes' ? 'Y' : '—'
}

export default function MasterViewTab({ project }: Props) {
  const exportRef = useRef<HTMLDivElement | null>(null)

  const lineItems = useMemo(() => getLineItemsForProject(project.id), [project.id])

  const grouped = useMemo(() => {
    const byDiscipline = new Map<
      string,
      {
        color: string
        orgs: Map<string, LineItem[]>
      }
    >()

    for (const rawItem of lineItems) {
      const item: LineItem = {
      ...rawItem,
      discipline: normalizeDiscipline(rawItem.discipline),
      companyName: rawItem.companyName || 'FAA',
    }

      const discipline = item.discipline
      const org = item.companyName || 'Unknown Organization'
      const color = getDisciplineColor(discipline)

      if (!byDiscipline.has(discipline)) {
        byDiscipline.set(discipline, {
          color,
          orgs: new Map(),
        })
      }

      const group = byDiscipline.get(discipline)!
      if (!group.orgs.has(org)) {
        group.orgs.set(org, [])
      }

      group.orgs.get(org)!.push(item)
    }

    return Array.from(byDiscipline.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([discipline, value]) => ({
        discipline,
        color: value.color,
        orgs: Array.from(value.orgs.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([orgName, items]) => ({
            orgName,
            items: [...items].sort((a, b) => itemNumberSort(a.itemNumber, b.itemNumber)),
          })),
      }))
  }, [lineItems])

  function exportMatrixOnly() {
    const matrixHtml = exportRef.current?.innerHTML
    if (!matrixHtml) return

    const printWindow = window.open('', '_blank', 'width=1400,height=900')
    if (!printWindow) return

    printWindow.document.write(`
      <html>
        <head>
          <title>${project.name} - Master View Matrix</title>
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 24px;
              font-family: Arial, Helvetica, sans-serif;
              color: #111827;
              background: white;
            }
            .export-title {
              margin-bottom: 20px;
            }
            .export-title h1 {
              margin: 0;
              font-size: 24px;
            }
            .export-title p {
              margin: 6px 0 0 0;
              color: #6b7280;
              font-size: 12px;
            }
            .matrix-section {
              margin-bottom: 28px;
              border: 1px solid #e5e7eb;
              border-radius: 18px;
              overflow: hidden;
              page-break-inside: avoid;
              break-inside: avoid;
            }
            .discipline-header {
              padding: 16px 20px;
              font-weight: 700;
              font-size: 20px;
              color: #111;
            }
            .org-row {
              padding: 10px 16px;
              border-bottom: 1px solid #e5e7eb;
              background: #fafafa;
              font-size: 12px;
              color: #4b5563;
              font-weight: 600;
            }
            .matrix-wrap {
              overflow: visible;
            }
            table {
              width: 100%;
              min-width: 1800px;
              border-collapse: collapse;
              font-size: 11px;
            }
            th, td {
              border-right: 1px solid #e5e7eb;
              border-bottom: 1px solid #e5e7eb;
              padding: 8px 10px;
              vertical-align: top;
              text-align: left;
            }
            th {
              background: #f3f4f6;
              font-size: 10px;
              text-transform: uppercase;
              letter-spacing: .04em;
            }
            .item-chip {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 999px;
              font-size: 10px;
              font-weight: 700;
              color: #111;
            }
            .notes-cell {
              min-width: 220px;
              white-space: pre-wrap;
            }
            .name-cell {
              min-width: 220px;
            }
            .muted {
              color: #6b7280;
            }
            @media print {
              body { margin: 12px; }
            }
          </style>
        </head>
        <body>
          <div class="export-title">
            <h1>${project.name}</h1>
            <p>Master View Matrix Export</p>
          </div>
          ${matrixHtml}
        </body>
      </html>
    `)

    printWindow.document.close()
    printWindow.focus()
    printWindow.print()
  }

  return (
    <div className="space-y-6">
      <div className="no-print rounded-[2rem] bg-gradient-to-br from-gray-50 to-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500">Master View</p>
            <h3 className="mt-1 text-2xl font-semibold text-gray-900">
              Designer Matrix
            </h3>
            <p className="mt-2 max-w-4xl text-sm text-gray-600">
              All project line items in one dense matrix, grouped by discipline and organization,
              sorted by item number.
            </p>
          </div>

          <button
            type="button"
            onClick={exportMatrixOnly}
            className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
          >
            Export PDF
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-sm text-gray-500">
          <div className="rounded-full bg-white px-3 py-2">
            {grouped.length} disciplines
          </div>
          <div className="rounded-full bg-white px-3 py-2">
            {lineItems.length} total items
          </div>
          <div className="rounded-full bg-white px-3 py-2">{project.name}</div>
        </div>
      </div>

      {lineItems.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white p-12 text-center">
          <h4 className="text-lg font-semibold text-gray-900">No project data yet</h4>
          <p className="mt-2 text-sm text-gray-500">
            Once consultants add line items, the matrix will appear here.
          </p>
        </div>
      ) : (
        <div ref={exportRef} className="space-y-6">
          {grouped.map((disciplineGroup) => (
            <section
              key={disciplineGroup.discipline}
              className="matrix-section overflow-hidden rounded-[2rem] border border-gray-200 bg-white shadow-sm"
            >
              <div
                className="discipline-header px-6 py-5"
                style={{ backgroundColor: disciplineGroup.color }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-2xl font-semibold text-black">
                    {disciplineGroup.discipline}
                  </h4>

                  <div className="rounded-full bg-white/80 px-4 py-2 text-sm font-medium text-black">
                    {disciplineGroup.orgs.reduce((sum, org) => sum + org.items.length, 0)} items
                  </div>
                </div>
              </div>

              <div className="space-y-3 p-4">
                {disciplineGroup.orgs.map((orgGroup) => (
                  <div key={`${disciplineGroup.discipline}-${orgGroup.orgName}`}>
                    <div className="org-row mb-2 flex items-center justify-between rounded-xl bg-gray-50 px-4 py-2">
                      <span className="truncate font-medium text-gray-700">
                        {orgGroup.orgName}
                      </span>
                      <span className="text-xs text-gray-400">
                        {orgGroup.items.length} items
                      </span>
                    </div>

                    <div className="matrix-wrap overflow-x-auto rounded-[1.25rem] border border-gray-200">
                      <table className="min-w-[2200px] border-collapse text-sm">
                        <thead>
                          <tr className="bg-gray-100 text-left align-top">
                            <HeaderCell sticky style={{ backgroundColor: disciplineGroup.color }}>
                              #
                            </HeaderCell>
                            <HeaderCell style={{ backgroundColor: disciplineGroup.color }}>
                              Name / Description
                            </HeaderCell>
                            <HeaderCell>Category</HeaderCell>
                            <HeaderCell>Timeline</HeaderCell>
                            <HeaderCell>Area</HeaderCell>
                            <HeaderCell>Level</HeaderCell>
                            <HeaderCell>Op Impact</HeaderCell>
                            <HeaderCell>Users</HeaderCell>
                            <HeaderCell>Public</HeaderCell>
                            <HeaderCell>1st Cost</HeaderCell>
                            <HeaderCell>Op Cost</HeaderCell>
                            <HeaderCell>Energy / Emissions</HeaderCell>
                            <HeaderCell>EO 594</HeaderCell>
                            <HeaderCell>Resiliency</HeaderCell>
                            <HeaderCell>Deferred</HeaderCell>
                            <HeaderCell>Life Safety</HeaderCell>
                            <HeaderCell>Access</HeaderCell>
                            <HeaderCell>Historic</HeaderCell>
                            <HeaderCell>Synergies</HeaderCell>
                            <HeaderCell>Notes</HeaderCell>
                            <HeaderCell>Submitted By</HeaderCell>
                          </tr>
                        </thead>

                        <tbody>
                          {orgGroup.items.map((item, index) => (
                            <tr
                              key={item.id}
                              className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}
                            >
                              <BodyCell
                                sticky
                                style={{
                                  backgroundColor: index % 2 === 0 ? '#ffffff' : '#f9fafb',
                                }}
                              >
                                <span
                                  className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold text-black"
                                  style={{ backgroundColor: disciplineGroup.color }}
                                >
                                  {item.itemNumber}
                                </span>
                              </BodyCell>

                              <BodyCell className="min-w-[260px]">
                                <div className="font-semibold text-gray-900">{item.name}</div>
                                <div className="mt-1 text-xs leading-5 text-gray-500">
                                  {item.shortDescription || '—'}
                                </div>
                              </BodyCell>

                              <BodyCell>{item.category}</BodyCell>
                              <BodyCell>{item.timelinePriority}</BodyCell>
                              <BodyCell>{item.buildingAreaImpacted}</BodyCell>
                              <BodyCell>{item.buildingLevelImpacted}</BodyCell>
                              <BodyCell>{item.operationalImpact}</BodyCell>
                              <BodyCell>{item.benefitToUsers}</BodyCell>
                              <BodyCell>{item.benefitToPublic}</BodyCell>
                              <BodyCell>{item.relativeFirstCost}</BodyCell>
                              <BodyCell>{item.relativeOperationCostImpact}</BodyCell>
                              <BodyCell>{item.relativeOperationalEnergyUsage}</BodyCell>
                              <BodyCell>{item.electrificationEO594}</BodyCell>
                              <BodyCell centered>{yn(item.addressingResiliencySustainability)}</BodyCell>
                              <BodyCell centered>{yn(item.addressingDeferredMaintenance)}</BodyCell>
                              <BodyCell centered>{yn(item.codeLifeSafetyImprovement)}</BodyCell>
                              <BodyCell centered>{yn(item.accessibilityImprovement)}</BodyCell>
                              <BodyCell centered>{yn(item.historicImpact)}</BodyCell>
                              <BodyCell className="min-w-[170px]">
                                {item.potentialSynergies.length > 0
                                  ? item.potentialSynergies.join(', ')
                                  : '—'}
                              </BodyCell>
                              <BodyCell className="min-w-[230px] text-xs leading-5">
                                {item.supportingNotes || '—'}
                              </BodyCell>
                              <BodyCell className="min-w-[170px]">
                                {item.userEmail}
                              </BodyCell>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function HeaderCell({
  children,
  sticky = false,
  style,
}: {
  children: React.ReactNode
  sticky?: boolean
  style?: React.CSSProperties
}) {
  return (
    <th
      style={style}
      className={`border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700 ${
        sticky ? 'sticky left-0 z-20 min-w-[110px]' : ''
      }`}
    >
      {children}
    </th>
  )
}

function BodyCell({
  children,
  className = '',
  centered = false,
  sticky = false,
  style,
}: {
  children: React.ReactNode
  className?: string
  centered?: boolean
  sticky?: boolean
  style?: React.CSSProperties
}) {
  return (
    <td
      style={style}
      className={`border-r border-b border-gray-200 px-4 py-3 align-top text-gray-700 ${
        centered ? 'text-center' : ''
      } ${sticky ? 'sticky left-0 z-10 min-w-[110px]' : ''} ${className}`}
    >
      {children}
    </td>
  )
}