'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  addLineItemToChunkProject,
  createChunkProject,
  deleteChunkProject,
  getChunkProjectsForProject,
  getLineItemsForProject,
  removeLineItemFromChunkProject,
  updateChunkProject,
  updateChunkProjectItemQuantity,
} from '@/lib/store'
import { formatCurrency, parseCostInput, parseQuantityInput } from '@/lib/costs'
import { ChunkProject, LineItem, Project } from '@/lib/types'

type Props = {
  project: Project
}

const DISCIPLINE_STYLES: Record<
  string,
  { badge: string; dot: string; row: string; surface: string }
> = {
  Architecture: {
    badge: 'border-amber-200 bg-amber-50 text-amber-900',
    dot: 'bg-amber-500',
    row: 'hover:bg-amber-50/45',
    surface: 'bg-amber-50/55',
  },
  Structural: {
    badge: 'border-blue-200 bg-blue-50 text-blue-900',
    dot: 'bg-blue-500',
    row: 'hover:bg-blue-50/45',
    surface: 'bg-blue-50/50',
  },
  Mechanical: {
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    dot: 'bg-emerald-500',
    row: 'hover:bg-emerald-50/45',
    surface: 'bg-emerald-50/55',
  },
  Electrical: {
    badge: 'border-violet-200 bg-violet-50 text-violet-900',
    dot: 'bg-violet-500',
    row: 'hover:bg-violet-50/45',
    surface: 'bg-violet-50/55',
  },
  Plumbing: {
    badge: 'border-cyan-200 bg-cyan-50 text-cyan-900',
    dot: 'bg-cyan-500',
    row: 'hover:bg-cyan-50/45',
    surface: 'bg-cyan-50/55',
  },
  Civil: {
    badge: 'border-rose-200 bg-rose-50 text-rose-900',
    dot: 'bg-rose-500',
    row: 'hover:bg-rose-50/45',
    surface: 'bg-rose-50/55',
  },
  Landscape: {
    badge: 'border-lime-200 bg-lime-50 text-lime-900',
    dot: 'bg-lime-500',
    row: 'hover:bg-lime-50/45',
    surface: 'bg-lime-50/55',
  },
  Technology: {
    badge: 'border-slate-200 bg-slate-100 text-slate-900',
    dot: 'bg-slate-500',
    row: 'hover:bg-slate-100/70',
    surface: 'bg-slate-100/70',
  },
}

function getDisciplineStyles(discipline: string) {
  return (
    DISCIPLINE_STYLES[discipline] || {
      badge: 'border-slate-200 bg-slate-50 text-slate-800',
      dot: 'bg-slate-500',
      row: 'hover:bg-slate-50',
      surface: 'bg-slate-50/80',
    }
  )
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

function getLineItemTotal(item: LineItem, quantity: string) {
  return parseCostInput(item.estimatedFirstCost) * parseQuantityInput(quantity)
}

export default function ChunkingTab({ project }: Props) {
  const [chunkProjects, setChunkProjects] = useState<ChunkProject[]>(() =>
    getChunkProjectsForProject(project.id)
  )
  const [allLineItems] = useState<LineItem[]>(() =>
    getLineItemsForProject(project.id).sort((a, b) => itemNumberSort(a.itemNumber, b.itemNumber))
  )
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [newChunkName, setNewChunkName] = useState('')
  const [selectedLineItemIds, setSelectedLineItemIds] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null)
  const [editingChunkId, setEditingChunkId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  function refreshChunks() {
    setChunkProjects(getChunkProjectsForProject(project.id))
  }

  function handleToggleSelectedLineItem(lineItemId: string) {
    setSelectedLineItemIds((current) =>
      current.includes(lineItemId)
        ? current.filter((id) => id !== lineItemId)
        : [...current, lineItemId]
    )
  }

  function handleOpenCreateDialog() {
    setIsCreateDialogOpen(true)
  }

  function handleCloseCreateDialog() {
    setIsCreateDialogOpen(false)
    setNewChunkName('')
    setSelectedLineItemIds([])
    setSearchQuery('')
  }

  function handleSelectAllFiltered() {
    setSelectedLineItemIds((current) => {
      const merged = new Set(current)
      filteredLineItems.forEach((item) => merged.add(item.id))
      return Array.from(merged)
    })
  }

  function handleClearSelection() {
    setSelectedLineItemIds([])
  }

  function handleCreateChunk() {
    if (!newChunkName.trim()) return

    const created = createChunkProject({
      projectId: project.id,
      name: newChunkName.trim(),
    })

    selectedLineItemIds.forEach((lineItemId) => {
      addLineItemToChunkProject(created.id, lineItemId)
    })

    setNewChunkName('')
    setSelectedLineItemIds([])
    setSearchQuery('')
    setIsCreateDialogOpen(false)
    refreshChunks()
    setExpandedChunkId(created.id)
  }

  function handleDeleteChunk(chunkId: string) {
    deleteChunkProject(chunkId)
    refreshChunks()

    if (expandedChunkId === chunkId) setExpandedChunkId(null)
    if (editingChunkId === chunkId) {
      setEditingChunkId(null)
      setEditingName('')
    }
  }

  function handleStartEdit(chunk: ChunkProject) {
    setEditingChunkId(chunk.id)
    setEditingName(chunk.name)
  }

  function handleSaveEdit(chunkId: string) {
    if (!editingName.trim()) return
    updateChunkProject(chunkId, { name: editingName.trim() })
    refreshChunks()
    setEditingChunkId(null)
    setEditingName('')
  }

  function handleAddLineItem(chunkId: string, lineItemId: string) {
    addLineItemToChunkProject(chunkId, lineItemId)
    refreshChunks()
  }

  function handleRemoveLineItem(chunkId: string, lineItemId: string) {
    removeLineItemFromChunkProject(chunkId, lineItemId)
    refreshChunks()
  }

  function handleQuantityChange(chunkId: string, lineItemId: string, quantity: string) {
    updateChunkProjectItemQuantity(chunkId, lineItemId, quantity)
    refreshChunks()
  }

  const lineItemMap = useMemo(
    () => new Map(allLineItems.map((item) => [item.id, item])),
    [allLineItems]
  )

  const filteredLineItems = (() => {
    const query = searchQuery.trim().toLowerCase()

    if (!query) return allLineItems

    return allLineItems.filter((item) => {
      return (
        item.itemNumber.toLowerCase().includes(query) ||
        item.name.toLowerCase().includes(query) ||
        item.discipline.toLowerCase().includes(query)
      )
    })
  })()

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">Packages</h2>
          <p className="mt-1 text-sm text-slate-500">
            Group line items into package chunks and manage quantities in place.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-full bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
            {chunkProjects.length} Packages
          </div>
          <button
            type="button"
            onClick={handleOpenCreateDialog}
            className="rounded-[1rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
          >
            Create Package
          </button>
        </div>
      </div>

      {chunkProjects.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-sm font-medium text-slate-400">
          No packages
        </div>
      ) : (
        <div className="space-y-5">
          {chunkProjects.map((chunk) => {
            const expanded = expandedChunkId === chunk.id
            const linkedItems = chunk.itemLinks
              .map((link) => ({
                link,
                item: lineItemMap.get(link.lineItemId),
              }))
              .filter(
                (entry): entry is { link: ChunkProject['itemLinks'][number]; item: LineItem } =>
                  Boolean(entry.item)
              )
              .sort((a, b) => itemNumberSort(a.item.itemNumber, b.item.itemNumber))
            const chunkTotalCost = linkedItems.reduce(
              (sum, entry) => sum + getLineItemTotal(entry.item, entry.link.quantity),
              0
            )

            const availableItems = allLineItems.filter(
              (item) => !chunk.itemLinks.some((link) => link.lineItemId === item.id)
            )

            return (
              <div
                key={chunk.id}
                className="overflow-hidden rounded-[2rem] border border-white/80 bg-white/82 shadow-[0_24px_80px_rgba(15,23,42,0.10)] backdrop-blur-xl"
              >
                <div className="border-b border-slate-100 bg-[linear-gradient(135deg,rgba(255,255,255,0.92)_0%,rgba(248,250,252,0.92)_45%,rgba(224,242,254,0.86)_100%)] px-6 py-5">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold text-white">
                          {chunk.chunkNumber}
                        </span>
                        <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-900">
                          {linkedItems.length}
                        </span>
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-900">
                          {formatCurrency(chunkTotalCost)}
                        </span>
                      </div>

                      {editingChunkId === chunk.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            className="min-w-[280px] rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-teal-500"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(chunk.id)}
                            className="rounded-[1rem] bg-slate-950 px-4 py-2.5 text-sm font-medium text-white"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingChunkId(null)
                              setEditingName('')
                            }}
                            className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="text-2xl font-semibold tracking-tight text-slate-950">
                          {chunk.name}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {editingChunkId !== chunk.id ? (
                        <button
                          type="button"
                          onClick={() => handleStartEdit(chunk)}
                          className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300"
                        >
                          Rename
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={() => setExpandedChunkId(expanded ? null : chunk.id)}
                        className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300"
                      >
                        {expanded ? 'Hide' : 'Edit'}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteChunk(chunk.id)}
                        className="rounded-[1rem] border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

                <div className="px-6 py-6">
                  {linkedItems.length === 0 ? (
                    <div className="rounded-[1.5rem] border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400">
                      Empty
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-[1.6rem] border border-slate-200 bg-white">
                      <div className="overflow-x-auto">
                        <table className="min-w-[1220px] border-collapse text-sm">
                          <thead>
                            <tr className="bg-slate-950 text-left">
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Discipline
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                #
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Name
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Desc
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Category
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Timeline
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Cost
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Notes
                              </th>
                              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                                Qty
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {linkedItems.map(({ item, link }) => {
                              const styles = getDisciplineStyles(item.discipline)
                              const lineItemTotal = getLineItemTotal(item, link.quantity)

                              return (
                                <tr
                                  key={item.id}
                                  className={`border-t border-slate-100 ${styles.surface} ${styles.row}`}
                                >
                                  <td className="px-4 py-3 align-top">
                                    <span
                                      className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles.badge}`}
                                    >
                                      {item.discipline}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 align-top font-medium text-slate-950">
                                    {item.itemNumber}
                                  </td>
                                  <td className="px-4 py-3 align-top font-medium text-slate-950">
                                    {item.name}
                                  </td>
                                  <td className="px-4 py-3 align-top text-slate-600">
                                    {item.shortDescription || '-'}
                                  </td>
                                  <td className="px-4 py-3 align-top text-slate-600">
                                    {item.category}
                                  </td>
                                  <td className="px-4 py-3 align-top text-slate-600">
                                    {item.timelinePriority}
                                  </td>
                                  <td className="px-4 py-3 align-top text-slate-600">
                                    <div>{item.relativeFirstCost}</div>
                                    <div className="mt-1 text-xs text-slate-500">
                                      Base: {item.estimatedFirstCost || '-'}
                                    </div>
                                    <div className="mt-1 text-xs font-semibold text-slate-700">
                                      Total: {formatCurrency(lineItemTotal)}
                                    </div>
                                  </td>
                                  <td className="max-w-[340px] px-4 py-3 align-top text-slate-600">
                                    <div className="whitespace-pre-wrap">
                                      {item.supportingNotes || '-'}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 align-top">
                                    <input
                                      value={link.quantity}
                                      onChange={(e) =>
                                        handleQuantityChange(chunk.id, item.id, e.target.value)
                                      }
                                      placeholder="Qty"
                                      className="w-28 rounded-[0.95rem] border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                                    />
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>

                {expanded ? (
                  <div className="border-t border-slate-100 bg-[linear-gradient(180deg,rgba(248,250,252,0.88)_0%,rgba(255,255,255,0.80)_100%)] px-6 py-6">
                    <div className="grid gap-6 xl:grid-cols-2">
                      <div className="rounded-[1.7rem] border border-slate-200 bg-white/90 p-5 shadow-sm">
                        <div className="mb-4 flex items-center justify-between">
                          <div className="text-sm font-semibold text-slate-950">Add</div>
                          <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                            {availableItems.length}
                          </div>
                        </div>

                        <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                          {availableItems.length === 0 ? (
                            <div className="rounded-[1.35rem] border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                              Full
                            </div>
                          ) : (
                            availableItems.map((item) => {
                              const styles = getDisciplineStyles(item.discipline)

                              return (
                                <div
                                  key={item.id}
                                  className={`flex items-center justify-between gap-3 rounded-[1.25rem] border border-slate-200 ${styles.surface} px-4 py-4 transition ${styles.row}`}
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`} />
                                      <span className="rounded-full bg-slate-950 px-2.5 py-1 text-[11px] font-semibold text-white">
                                        {item.itemNumber}
                                      </span>
                                      <span
                                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles.badge}`}
                                      >
                                        {item.discipline}
                                      </span>
                                    </div>
                                    <div className="mt-3 text-sm font-semibold text-slate-950">
                                      {item.name}
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => handleAddLineItem(chunk.id, item.id)}
                                    className="rounded-[1rem] bg-slate-950 px-3 py-2 text-xs font-semibold text-white"
                                  >
                                    Add
                                  </button>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </div>

                      <div className="rounded-[1.7rem] border border-slate-200 bg-white/90 p-5 shadow-sm">
                        <div className="mb-4 flex items-center justify-between">
                          <div className="text-sm font-semibold text-slate-950">Remove</div>
                          <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                            {linkedItems.length}
                          </div>
                        </div>

                        <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                          {linkedItems.length === 0 ? (
                            <div className="rounded-[1.35rem] border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                              Empty
                            </div>
                          ) : (
                            linkedItems.map(({ item }) => {
                              const styles = getDisciplineStyles(item.discipline)

                              return (
                                <div
                                  key={item.id}
                                  className={`flex items-center justify-between gap-3 rounded-[1.25rem] border border-slate-200 ${styles.surface} px-4 py-4 ${styles.row}`}
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`} />
                                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-900">
                                        {item.itemNumber}
                                      </span>
                                      <span
                                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles.badge}`}
                                      >
                                        {item.discipline}
                                      </span>
                                    </div>
                                    <div className="mt-3 text-sm font-semibold text-slate-950">
                                      {item.name}
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => handleRemoveLineItem(chunk.id, item.id)}
                                    className="rounded-[1rem] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"
                                  >
                                    Remove
                                  </button>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {isCreateDialogOpen ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-[90] bg-black/42"
                >
                  <div className="flex min-h-full items-center justify-center p-4 md:p-6">
                    <motion.div
                      initial={{ opacity: 0, y: 24, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 12, scale: 0.98 }}
                      transition={{ duration: 0.24 }}
                      className="w-full max-w-4xl overflow-hidden rounded-[2.25rem] bg-white shadow-2xl"
                    >
                <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
                  <div>
                    <p className="text-sm text-slate-500">New Package</p>
                    <div className="text-xl font-semibold tracking-tight text-slate-950">
                      Select line items
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCloseCreateDialog}
                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300"
                  >
                    Close
                  </button>
                </div>

                <div className="max-h-[80vh] overflow-y-auto p-6">
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-end gap-4">
                      <div className="min-w-[320px] flex-1">
                        <input
                          id="chunk-project-name"
                          value={newChunkName}
                          onChange={(e) => setNewChunkName(e.target.value)}
                          placeholder="Package name"
                          className="w-full rounded-[1.35rem] border border-slate-200 bg-white/95 px-5 py-4 text-base outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                        />
                      </div>

                      <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                        {selectedLineItemIds.length} selected
                      </div>
                    </div>

                    <div className="rounded-[1.8rem] border border-slate-200 bg-white/88 p-4 shadow-sm">
                      <div className="flex flex-col gap-3 lg:flex-row">
                        <input
                          id="chunk-line-item-search"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search"
                          className="flex-1 rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                        />
                        <button
                          type="button"
                          onClick={handleSelectAllFiltered}
                          disabled={filteredLineItems.length === 0}
                          className="rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          All
                        </button>
                        <button
                          type="button"
                          onClick={handleClearSelection}
                          disabled={selectedLineItemIds.length === 0}
                          className="rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={handleCreateChunk}
                          disabled={!newChunkName.trim()}
                          className="rounded-[1.2rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:bg-slate-300"
                        >
                          Create
                        </button>
                      </div>

                      <div className="mt-4 grid gap-2">
                        {filteredLineItems.length === 0 ? (
                          <div className="rounded-[1.4rem] border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400">
                            Nothing found
                          </div>
                        ) : (
                          filteredLineItems.map((item) => {
                            const selected = selectedLineItemIds.includes(item.id)
                            const styles = getDisciplineStyles(item.discipline)

                            return (
                              <label
                                key={item.id}
                                className={`group flex cursor-pointer items-start gap-4 rounded-[1.4rem] border px-4 py-4 transition ${
                                  selected
                                    ? 'border-slate-900 bg-slate-950 text-white shadow-lg'
                                    : `border-slate-200 ${styles.surface} ${styles.row}`
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => handleToggleSelectedLineItem(item.id)}
                                  className="mt-1 h-4 w-4 rounded border-slate-300"
                                />

                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span
                                      className={`h-2.5 w-2.5 rounded-full ${
                                        selected ? 'bg-white' : styles.dot
                                      }`}
                                    />
                                    <span
                                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                                        selected
                                          ? 'border-white/20 bg-white/10 text-white'
                                          : styles.badge
                                      }`}
                                    >
                                      {item.itemNumber}
                                    </span>
                                    <span
                                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                                        selected
                                          ? 'border-white/20 bg-white/10 text-white/90'
                                          : 'border-slate-200 bg-slate-50 text-slate-700'
                                      }`}
                                    >
                                      {item.discipline}
                                    </span>
                                  </div>
                                  <div
                                    className={`mt-3 text-sm font-semibold ${
                                      selected ? 'text-white' : 'text-slate-950'
                                    }`}
                                  >
                                    {item.name}
                                  </div>
                                  {item.shortDescription ? (
                                    <div
                                      className={`mt-1 text-sm ${
                                        selected ? 'text-white/70' : 'text-slate-500'
                                      }`}
                                    >
                                      {item.shortDescription}
                                    </div>
                                  ) : null}
                                </div>
                              </label>
                            )
                          })
                        )}
                      </div>
                      </div>
                    </div>
                  </div>
                    </motion.div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
    </div>
  )
}
