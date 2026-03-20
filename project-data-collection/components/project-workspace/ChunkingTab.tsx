'use client'

import { useMemo, useState } from 'react'
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
import { ChunkProject, LineItem, Project } from '@/lib/types'

type Props = {
  project: Project
}

const DISCIPLINE_STYLES: Record<string, { badge: string; panel: string; accent: string }> = {
  Architecture: {
    badge: 'bg-amber-100 text-amber-900 border-amber-200',
    panel: 'border-amber-200 bg-amber-50/80',
    accent: 'bg-amber-500',
  },
  Structural: {
    badge: 'bg-blue-100 text-blue-900 border-blue-200',
    panel: 'border-blue-200 bg-blue-50/80',
    accent: 'bg-blue-500',
  },
  Mechanical: {
    badge: 'bg-emerald-100 text-emerald-900 border-emerald-200',
    panel: 'border-emerald-200 bg-emerald-50/80',
    accent: 'bg-emerald-500',
  },
  Electrical: {
    badge: 'bg-violet-100 text-violet-900 border-violet-200',
    panel: 'border-violet-200 bg-violet-50/80',
    accent: 'bg-violet-500',
  },
  Plumbing: {
    badge: 'bg-cyan-100 text-cyan-900 border-cyan-200',
    panel: 'border-cyan-200 bg-cyan-50/80',
    accent: 'bg-cyan-500',
  },
  Civil: {
    badge: 'bg-rose-100 text-rose-900 border-rose-200',
    panel: 'border-rose-200 bg-rose-50/80',
    accent: 'bg-rose-500',
  },
  Landscape: {
    badge: 'bg-lime-100 text-lime-900 border-lime-200',
    panel: 'border-lime-200 bg-lime-50/80',
    accent: 'bg-lime-500',
  },
  Technology: {
    badge: 'bg-slate-200 text-slate-900 border-slate-300',
    panel: 'border-slate-200 bg-slate-100/80',
    accent: 'bg-slate-500',
  },
}

function getDisciplineStyles(discipline: string) {
  return (
    DISCIPLINE_STYLES[discipline] || {
      badge: 'bg-gray-100 text-gray-800 border-gray-200',
      panel: 'border-gray-200 bg-gray-50/80',
      accent: 'bg-gray-500',
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
      <div className="overflow-hidden rounded-[2rem] border border-orange-100 bg-gradient-to-r from-[#fff8ec] via-white to-[#eef6ff] shadow-sm">
        <div className="flex flex-col gap-5 p-6 md:flex-row md:items-center md:justify-between md:p-8">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-orange-500">
              Chunk Builder
            </p>
            <h3 className="mt-3 text-3xl font-semibold tracking-tight text-gray-900">Packages</h3>
          </div>

          <button
            type="button"
            onClick={handleOpenCreateDialog}
            className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg"
          >
            Create New
          </button>
        </div>
      </div>

      {isCreateDialogOpen ? (
        <div className="overflow-hidden rounded-[2rem] border border-gray-200 bg-white shadow-2xl">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-sky-50 px-6 py-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">New Package</p>
              <h4 className="mt-2 text-2xl font-semibold text-gray-900">Create Package</h4>
            </div>

            <button
              type="button"
              onClick={handleCloseCreateDialog}
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
            >
              Cancel
            </button>
          </div>

          <div className="space-y-4 p-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-[280px] flex-1">
                <label
                  htmlFor="chunk-project-name"
                  className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-gray-500"
                >
                  Project Name
                </label>
                <input
                  id="chunk-project-name"
                  value={newChunkName}
                  onChange={(e) => setNewChunkName(e.target.value)}
                  placeholder="Enter project package name"
                  className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-orange-400"
                />
              </div>

              <div className="rounded-full bg-orange-100 px-3 py-2 text-xs font-medium text-orange-700">
                {selectedLineItemIds.length} selected
              </div>
            </div>

            <div className="rounded-[1.5rem] border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mt-1 flex flex-col gap-3 md:flex-row">
                <input
                  id="chunk-line-item-search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by number, name, or discipline"
                  className="flex-1 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-orange-400"
                />
                <button
                  type="button"
                  onClick={handleSelectAllFiltered}
                  disabled={filteredLineItems.length === 0}
                  className="rounded-2xl border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Select Results
                </button>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  disabled={selectedLineItemIds.length === 0}
                  className="rounded-2xl border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={handleCreateChunk}
                  disabled={!newChunkName.trim()}
                  className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  Create Project
                </button>
              </div>

              <div className="mt-4 max-h-[520px] space-y-2 overflow-y-auto pr-1">
                {filteredLineItems.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                    No line items match this search.
                  </div>
                ) : (
                  filteredLineItems.map((item) => {
                    const selected = selectedLineItemIds.includes(item.id)
                    const styles = getDisciplineStyles(item.discipline)

                    return (
                      <label
                        key={item.id}
                        className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${
                          selected
                            ? `${styles.panel} shadow-sm`
                            : 'border-gray-200 bg-gray-50/70 hover:border-gray-300 hover:bg-white'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => handleToggleSelectedLineItem(item.id)}
                          className="mt-1 h-4 w-4 rounded border-gray-300 text-black focus:ring-black"
                        />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-black px-2.5 py-1 text-xs font-medium text-white">
                              {item.itemNumber}
                            </span>
                            <span
                              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${styles.badge}`}
                            >
                              {item.discipline}
                            </span>
                            {selected ? (
                              <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-gray-700">
                                Selected
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-3 text-sm font-semibold text-gray-900">
                            {item.name}
                          </div>
                          <div className="mt-1 text-sm text-gray-600">
                            {item.shortDescription || 'No short description'}
                          </div>
                        </div>
                      </label>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {chunkProjects.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white p-12 text-center">
          <h4 className="text-lg font-semibold text-gray-900">No chunk projects yet</h4>
          <p className="mt-2 text-sm text-gray-500">
            Create a project package above, pick its line items, and it will appear here.
          </p>
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

            const availableItems = allLineItems.filter(
              (item) => !chunk.itemLinks.some((link) => link.lineItemId === item.id)
            )

            return (
              <div
                key={chunk.id}
                className="overflow-hidden rounded-[2rem] border border-gray-200 bg-white shadow-sm"
              >
                <div className="border-b border-gray-100 bg-gradient-to-r from-white via-orange-50/70 to-sky-50/70 px-6 py-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                          {chunk.chunkNumber}
                        </span>
                        <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-medium text-orange-700">
                          {linkedItems.length} line items
                        </span>
                      </div>

                      {editingChunkId === chunk.id ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <input
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            className="min-w-[260px] rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-black"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(chunk.id)}
                            className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingChunkId(null)
                              setEditingName('')
                            }}
                            className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <h4 className="mt-3 text-2xl font-semibold text-gray-900">
                            {chunk.name}
                          </h4>
                        </>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {editingChunkId !== chunk.id ? (
                        <button
                          type="button"
                          onClick={() => handleStartEdit(chunk)}
                          className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
                        >
                          Rename
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={() => setExpandedChunkId(expanded ? null : chunk.id)}
                        className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
                      >
                        {expanded ? 'Close' : 'Manage'}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteChunk(chunk.id)}
                        className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

                <div className="px-6 py-6">
                  {linkedItems.length === 0 ? (
                    <div className="rounded-[1.5rem] border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-400">
                      No line items attached yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-[1.5rem] border border-gray-200">
                      <table className="min-w-[1220px] border-collapse text-sm">
                        <thead>
                          <tr className="bg-gray-100 text-left">
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Discipline
                            </th>
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              #
                            </th>
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Name
                            </th>
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Short Desc
                            </th>
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Category
                            </th>
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Timeline
                            </th>
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Relative First Cost
                            </th>
                            <th className="border-b border-r border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Notes
                            </th>
                            <th className="border-b px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-700">
                              Estimated Qty
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {linkedItems.map(({ item, link }, index) => {
                            const styles = getDisciplineStyles(item.discipline)

                            return (
                              <tr
                                key={item.id}
                                className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50/70'}
                              >
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top">
                                  <span
                                    className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${styles.badge}`}
                                  >
                                    {item.discipline}
                                  </span>
                                </td>
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top text-gray-900">
                                  {item.itemNumber}
                                </td>
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top font-medium text-gray-900">
                                  {item.name}
                                </td>
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top text-gray-700">
                                  {item.shortDescription || 'No short description'}
                                </td>
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top text-gray-700">
                                  {item.category}
                                </td>
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top text-gray-700">
                                  {item.timelinePriority}
                                </td>
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top text-gray-700">
                                  {item.relativeFirstCost}
                                </td>
                                <td className="border-r border-b border-gray-200 px-4 py-3 align-top text-gray-700">
                                  <div className="max-w-[320px] whitespace-pre-wrap">
                                    {item.supportingNotes || 'No notes'}
                                  </div>
                                </td>
                                <td className="border-b border-gray-200 px-4 py-3 align-top">
                                  <input
                                    value={link.quantity}
                                    onChange={(e) =>
                                      handleQuantityChange(chunk.id, item.id, e.target.value)
                                    }
                                    placeholder="Enter quantity"
                                    className="w-36 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400"
                                  />
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {expanded ? (
                  <div className="border-t border-gray-100 bg-gray-50/70 px-6 py-6">
                    <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
                      <div className="rounded-[1.5rem] border border-gray-200 bg-white p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-gray-900">Available Line Items</p>
                          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                            {availableItems.length} available
                          </span>
                        </div>

                        <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                          {availableItems.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                              All project line items are already in this package.
                            </div>
                          ) : (
                            availableItems.map((item) => {
                              const styles = getDisciplineStyles(item.discipline)

                              return (
                                <div
                                  key={item.id}
                                  className="flex items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50/70 p-4"
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="rounded-full bg-black px-2.5 py-1 text-xs font-medium text-white">
                                        {item.itemNumber}
                                      </span>
                                      <span
                                        className={`rounded-full border px-2.5 py-1 text-xs font-medium ${styles.badge}`}
                                      >
                                        {item.discipline}
                                      </span>
                                    </div>
                                    <div className="mt-3 text-sm font-semibold text-gray-900">
                                      {item.name}
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => handleAddLineItem(chunk.id, item.id)}
                                    className="rounded-xl bg-black px-3 py-2 text-xs font-medium text-white"
                                  >
                                    Add
                                  </button>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </div>

                      <div className="rounded-[1.5rem] border border-gray-200 bg-white p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-gray-900">Current Line Items</p>
                          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                            {linkedItems.length} attached
                          </span>
                        </div>

                        <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                          {linkedItems.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                              No line items to remove.
                            </div>
                          ) : (
                            linkedItems.map(({ item }) => {
                              const styles = getDisciplineStyles(item.discipline)

                              return (
                                <div
                                  key={item.id}
                                  className={`flex items-start justify-between gap-3 rounded-2xl border p-4 ${styles.panel}`}
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-gray-900">
                                        {item.itemNumber}
                                      </span>
                                      <span
                                        className={`rounded-full border px-2.5 py-1 text-xs font-medium ${styles.badge}`}
                                      >
                                        {item.discipline}
                                      </span>
                                    </div>
                                    <div className="mt-3 text-sm font-semibold text-gray-900">
                                      {item.name}
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => handleRemoveLineItem(chunk.id, item.id)}
                                    className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
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
    </div>
  )
}
