'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addLineItemToChunkProject,
  addLineItemsToChunkProject,
  createChunkProject,
  deleteChunkProject,
  getChunkPhasesForProject,
  getChunkProjectsForProject,
  getCostSettingsForProject,
  getFormFieldsForProject,
  getLineItemsForProject,
  getPhaseDependenciesForProject,
  getPhaseTemplates,
  removeLineItemFromChunkProject,
  replaceChunkPhases,
  updateChunkProject,
  updateChunkProjectItemQuantity,
  updateLineItem,
} from '@/lib/store'
import { useAuth } from '@/lib/auth-context'
import Modal from '@/components/ui/Modal'
import EditableCell from '@/components/project-workspace/master-view/EditableCell'
import {
  buildRowPatch,
  initialCellValue,
  sameCellValue,
  validateRowDraft,
  type CellValue,
  type RowDraft,
} from '@/components/project-workspace/master-view/cell-edit'
import { useAsyncData } from '@/lib/useAsyncData'
import { formatFieldValue, getFieldValue } from '@/lib/form-values'
import { useEffectiveViewSettings } from '@/lib/use-effective-view-settings'
import { visibleColumns } from '@/lib/view-settings'
import { CHUNKING_COLUMN_KEYS, getChunkingColumns } from '@/lib/view-columns/chunking'
import ColumnsFilter from './view-filter/ColumnsFilter'
import {
  QUANTITY_PARSE_MESSAGES,
  formatCurrency,
  parseCostInput,
  parseQuantity,
  quantityInputFeedback,
} from '@/lib/costs'
import {
  ChunkPhase,
  ChunkProject,
  FormField,
  LineItem,
  PhaseDependency,
  PhaseTemplate,
  Project,
  ProjectCostSettings,
} from '@/lib/types'
import PhaseEditor from '@/components/project-workspace/PhaseEditor'
import {
  layoutTemplatePhases,
  resolveProjectTemplate,
} from '@/components/project-workspace/cost-model/phase-layout'
import type { ProjectPermissions } from '@/lib/project-role'

type Props = {
  project: Project
  permissions: ProjectPermissions
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

/** Answer edits that commit the moment they change: there is no "still
 *  typing" state for a tick box or a dropdown. Everything else -- dates
 *  included, since typing one by keyboard passes through invalid years --
 *  commits when focus leaves the cell (or on Enter). */
const COMMIT_ON_CHANGE = new Set<FormField['inputType']>(['boolean', 'select'])

/** What is left to do for a package whose creation half-failed. */
type CreateRepair = { chunkId: string; needsPhases: boolean; lineItemIds: string[] }

function itemNumberSort(a: string, b: string) {
  const aMatch = a.match(/^([A-Z]+)(\d+)$/i)
  const bMatch = b.match(/^([A-Z]+)(\d+)$/i)

  if (!aMatch || !bMatch) return a.localeCompare(b)

  const [, aPrefix, aNum] = aMatch
  const [, bPrefix, bNum] = bMatch

  if (aPrefix !== bPrefix) return aPrefix.localeCompare(bPrefix)
  return Number(aNum) - Number(bNum)
}

/**
 * Reads the shared strict quantity parser (lib/costs.ts `parseQuantity`):
 * commas and a trailing unit are fine ("1,200 sf"), 0 is zero, blank is one
 * unit, and non-numeric / negative text is invalid and must not be saved.
 */
function readQuantity(text: string): { ok: boolean; value: number; message: string } {
  const result = parseQuantity(text)
  if (!result.ok) return { ok: false, value: 0, message: QUANTITY_PARSE_MESSAGES[result.reason] }
  return { ok: true, value: result.quantity ?? 1, message: '' }
}

function getLineItemTotal(item: LineItem, quantity: string) {
  return parseCostInput(item.estimatedFirstCost) * readQuantity(quantity).value
}

export default function ChunkingTab({ project, permissions }: Props) {
  const canEdit = permissions.canEdit
  // `canEdit` is false for everyone until the role RPC answers, so gating a
  // control's very presence on `canEdit` alone hides it from an editor for
  // that first beat and then pops it in once the role lands. Below, the
  // three write controls this bit affects render throughout the loading
  // window -- just disabled -- so an editor sees a control go from disabled
  // to enabled rather than from absent to present.
  const permissionsLoading = permissions.loading

  const {
    data: chunkProjects,
    loading: chunkProjectsLoading,
    error: chunkProjectsError,
    reload: reloadChunks,
  } = useAsyncData<ChunkProject[]>(
    () => getChunkProjectsForProject(project.id),
    [project.id],
    []
  )
  const {
    data: allLineItems,
    setData: setAllLineItems,
    error: lineItemsError,
  } = useAsyncData<LineItem[]>(
    async () => {
      const items = await getLineItemsForProject(project.id)
      return [...items].sort((a, b) => itemNumberSort(a.itemNumber, b.itemNumber))
    },
    [project.id],
    []
  )
  // Phases are fetched once for the whole project, not per package: every
  // package's PhaseEditor below just filters this one list by
  // chunkProjectId. That keeps a mutation in one package's editor a single
  // reload for everyone, instead of N independent per-chunk queries getting
  // out of sync with each other.
  const {
    data: allPhases,
    error: phasesError,
    reload: reloadPhases,
  } = useAsyncData<ChunkPhase[]>(() => getChunkPhasesForProject(project.id), [project.id], [])
  // Only used to name, in the delete confirm, how many dependency links go
  // with a package (a link row cascades when either of its phases goes).
  const { data: allDependencies, reload: reloadDependencies } = useAsyncData<PhaseDependency[]>(
    () => getPhaseDependenciesForProject(project.id),
    [project.id],
    []
  )
  const { data: phaseTemplates } = useAsyncData<PhaseTemplate[]>(
    () => getPhaseTemplates(project.id),
    [project.id],
    []
  )
  const { data: costSettings } = useAsyncData<ProjectCostSettings | null>(
    () => getCostSettingsForProject(project.id),
    [project.id],
    null
  )
  const { data: formFields } = useAsyncData<FormField[]>(
    () => getFormFieldsForProject(project.id),
    [project.id],
    []
  )
  // Project default, or this person's own Filter choice on top of it.
  const phasingView = useEffectiveViewSettings(project.id, 'chunking', permissions.isAdmin)
  const columnCatalog = useMemo(() => getChunkingColumns(formFields), [formFields])
  const columns = useMemo(
    () => visibleColumns(columnCatalog, phasingView.effective.hiddenColumns),
    [columnCatalog, phasingView.effective.hiddenColumns]
  )
  const fieldByKey = useMemo(() => new Map(formFields.map((f) => [f.key, f])), [formFields])
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  // Set when a package was created but a later step failed: the dialog
  // closes (retrying Create would make a duplicate) and the page offers to
  // finish just the failed steps on THAT package.
  const [createRepair, setCreateRepair] = useState<CreateRepair | null>(null)
  const [newChunkName, setNewChunkName] = useState('')
  const [selectedLineItemIds, setSelectedLineItemIds] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null)
  const [editingChunkId, setEditingChunkId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [isCreatingChunk, setIsCreatingChunk] = useState(false)
  const [deletingChunkId, setDeletingChunkId] = useState<string | null>(null)
  // Two-step inline confirm (no window.confirm): first click arms, second deletes.
  const [confirmDeleteChunkId, setConfirmDeleteChunkId] = useState<string | null>(null)
  const [savingEditChunkId, setSavingEditChunkId] = useState<string | null>(null)
  const [addingItemKey, setAddingItemKey] = useState<string | null>(null)
  const [removingItemKey, setRemovingItemKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({})
  const [quantityErrors, setQuantityErrors] = useState<Record<string, string>>({})

  const { user } = useAuth()
  const synergyOptions = useMemo(
    () => Array.from(new Set(project.consultants.map((c) => c.type))),
    [project.consultants]
  )
  // Line-item answers edited in place (same pieces as Master View's edit
  // mode). Drafts are mirrored in a ref so a blur handler reads what was
  // typed, not the value from the render it was created in.
  const [answersEditingChunkId, setAnswersEditingChunkId] = useState<string | null>(null)
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, RowDraft>>({})
  const [answerStatus, setAnswerStatus] = useState<
    Record<string, { saving?: boolean; error?: string }>
  >({})
  const answerDraftsRef = useRef<Record<string, RowDraft>>({})
  const lineItemsRef = useRef(allLineItems)
  const answerSaveChains = useRef(new Map<string, Promise<void>>())
  // The value each cell is saving right now, so the blur that follows a
  // dropdown's commit-on-change does not send the same write twice.
  const answerInFlight = useRef(new Map<string, CellValue>())

  useEffect(() => {
    lineItemsRef.current = allLineItems
  }, [allLineItems])

  const isMountedRef = useRef(true)
  const quantityTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    isMountedRef.current = true
    const pending = quantityTimers.current
    return () => {
      isMountedRef.current = false
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

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

  /**
   * The remaining steps of a package creation: its phases from the project's
   * one phase template (Cost model; DCAMM if unset, then one Construction
   * phase), then its line items. Returns what is still left if a step fails.
   */
  async function finishPackage(repair: CreateRepair): Promise<CreateRepair | null> {
    let left = repair
    try {
      if (left.needsPhases) {
        const template = resolveProjectTemplate(
          phaseTemplates,
          costSettings?.defaultPhaseTemplateId ?? null
        )
        await replaceChunkPhases(left.chunkId, layoutTemplatePhases(template, 0))
        left = { ...left, needsPhases: false }
      }
      if (left.lineItemIds.length > 0) {
        await addLineItemsToChunkProject(left.chunkId, left.lineItemIds)
        left = { ...left, lineItemIds: [] }
      }
      return null
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { left })
    }
  }

  async function handleCreateChunk() {
    if (!newChunkName.trim()) return

    setActionError(null)
    setCreateRepair(null)
    setIsCreatingChunk(true)
    let created: ChunkProject | null = null
    try {
      created = await createChunkProject({
        projectId: project.id,
        name: newChunkName.trim(),
      })
      await finishPackage({
        chunkId: created.id,
        needsPhases: true,
        lineItemIds: selectedLineItemIds,
      })

      if (!isMountedRef.current) return
      handleCloseCreateDialog()
      reloadChunks()
      reloadPhases()
      setExpandedChunkId(created.id)
    } catch (err) {
      if (!isMountedRef.current) return
      const message = err instanceof Error ? err.message : 'Failed to create package.'
      if (created) {
        // The package exists. Close the dialog so Create cannot make a
        // second one, open the package, and offer to finish it.
        const left = (err as { left?: CreateRepair }).left ?? {
          chunkId: created.id,
          needsPhases: true,
          lineItemIds: selectedLineItemIds,
        }
        handleCloseCreateDialog()
        reloadChunks()
        reloadPhases()
        setExpandedChunkId(created.id)
        setCreateRepair(left)
        setActionError(`${created.chunkNumber} was created, but not finished: ${message}`)
      } else {
        setActionError(message)
      }
    } finally {
      if (isMountedRef.current) setIsCreatingChunk(false)
    }
  }

  async function handleRetryCreate() {
    if (!createRepair) return
    setIsCreatingChunk(true)
    try {
      await finishPackage(createRepair)
      if (!isMountedRef.current) return
      setCreateRepair(null)
      setActionError(null)
    } catch (err) {
      if (!isMountedRef.current) return
      setCreateRepair((err as { left?: CreateRepair }).left ?? createRepair)
      setActionError(err instanceof Error ? err.message : 'Failed to finish the package.')
    } finally {
      if (isMountedRef.current) {
        setIsCreatingChunk(false)
        reloadChunks()
        reloadPhases()
      }
    }
  }

  async function handleDeleteChunk(chunkId: string) {
    setActionError(null)
    setConfirmDeleteChunkId(null)
    setDeletingChunkId(chunkId)
    try {
      await deleteChunkProject(chunkId)
      if (!isMountedRef.current) return

      reloadChunks()
      reloadPhases()
      reloadDependencies()

      if (expandedChunkId === chunkId) setExpandedChunkId(null)
      if (editingChunkId === chunkId) {
        setEditingChunkId(null)
        setEditingName('')
      }
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err instanceof Error ? err.message : 'Failed to delete package.')
    } finally {
      if (isMountedRef.current) setDeletingChunkId(null)
    }
  }

  function handleStartEdit(chunk: ChunkProject) {
    setEditingChunkId(chunk.id)
    setEditingName(chunk.name)
  }

  async function handleSaveEdit(chunkId: string) {
    if (!editingName.trim()) return

    setActionError(null)
    setSavingEditChunkId(chunkId)
    try {
      await updateChunkProject(chunkId, { name: editingName.trim() })
      if (!isMountedRef.current) return

      reloadChunks()
      setEditingChunkId(null)
      setEditingName('')
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err instanceof Error ? err.message : 'Failed to rename package.')
    } finally {
      if (isMountedRef.current) setSavingEditChunkId(null)
    }
  }

  async function handleAddLineItem(chunkId: string, lineItemId: string) {
    const key = `${chunkId}:${lineItemId}`
    setActionError(null)
    setAddingItemKey(key)
    try {
      await addLineItemToChunkProject(chunkId, lineItemId)
      if (!isMountedRef.current) return
      reloadChunks()
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err instanceof Error ? err.message : 'Failed to add line item.')
    } finally {
      if (isMountedRef.current) setAddingItemKey(null)
    }
  }

  async function handleRemoveLineItem(chunkId: string, lineItemId: string) {
    const key = `${chunkId}:${lineItemId}`
    setActionError(null)
    setRemovingItemKey(key)
    try {
      await removeLineItemFromChunkProject(chunkId, lineItemId)
      if (!isMountedRef.current) return
      reloadChunks()
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err instanceof Error ? err.message : 'Failed to remove line item.')
    } finally {
      if (isMountedRef.current) setRemovingItemKey(null)
    }
  }

  function getQuantityKey(chunkId: string, lineItemId: string) {
    return `${chunkId}:${lineItemId}`
  }

  function getEffectiveQuantity(chunkId: string, lineItemId: string, fallback: string) {
    const key = getQuantityKey(chunkId, lineItemId)
    return quantityDrafts[key] ?? fallback
  }

  // What the totals should price: the draft while it parses, otherwise the
  // last saved quantity (so an invalid half-typed value never moves the money).
  function getPricedQuantity(chunkId: string, lineItemId: string, fallback: string) {
    const effective = getEffectiveQuantity(chunkId, lineItemId, fallback)
    return readQuantity(effective).ok ? effective : fallback
  }

  async function persistQuantityChange(chunkId: string, lineItemId: string, quantity: string) {
    const key = getQuantityKey(chunkId, lineItemId)
    try {
      await updateChunkProjectItemQuantity(chunkId, lineItemId, quantity)
      if (!isMountedRef.current) return

      reloadChunks()
      setQuantityDrafts((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      setQuantityErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    } catch (err) {
      if (!isMountedRef.current) return
      setQuantityErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Failed to update quantity.',
      }))
    }
  }

  function handleQuantityChange(chunkId: string, lineItemId: string, quantity: string) {
    const key = getQuantityKey(chunkId, lineItemId)

    // Keep the input responsive immediately; only the persistence write is debounced.
    setQuantityDrafts((prev) => ({ ...prev, [key]: quantity }))

    const existingTimer = quantityTimers.current.get(key)
    if (existingTimer) clearTimeout(existingTimer)

    // Invalid text is never persisted (it used to be stored verbatim and then
    // silently priced as 1). The user's text stays in the box with an inline
    // error until they fix it; totals keep using the last saved quantity.
    const parsedQuantity = readQuantity(quantity)
    if (!parsedQuantity.ok) {
      quantityTimers.current.delete(key)
      setQuantityErrors((prev) => ({ ...prev, [key]: parsedQuantity.message }))
      return
    }
    setQuantityErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })

    const timer = setTimeout(() => {
      quantityTimers.current.delete(key)
      void persistQuantityChange(chunkId, lineItemId, quantity)
    }, 400)

    quantityTimers.current.set(key, timer)
  }

  /* ------------------------------------------------ line-item answers -- */

  const myEmail = user?.email?.toLowerCase() ?? null

  /**
   * Exactly what line_items_update (migration 0009) allows: admins and
   * editors any row in the project, a consultant only rows they submitted,
   * a viewer nothing. False while the role is still loading.
   */
  function canEditAnswers(item: LineItem): boolean {
    if (permissions.loading || permissions.isViewer) return false
    if (permissions.canEdit) return true
    return (
      permissions.canContribute && myEmail !== null && item.userEmail.toLowerCase() === myEmail
    )
  }

  function setAnswerDraft(item: LineItem, field: FormField, value: CellValue) {
    const initial = initialCellValue(field, item)
    const row = { ...(answerDraftsRef.current[item.id] ?? {}) }
    if (sameCellValue(value, initial)) delete row[field.key]
    else row[field.key] = value
    const next = { ...answerDraftsRef.current }
    if (Object.keys(row).length > 0) next[item.id] = row
    else delete next[item.id]
    answerDraftsRef.current = next
    setAnswerDrafts(next)
    const statusKey = `${item.id}:${field.key}`
    setAnswerStatus((prev) => {
      if (!prev[statusKey]?.error) return prev
      const copy = { ...prev }
      delete copy[statusKey]
      return copy
    })
  }

  /**
   * Saves one changed answer through the same validation and patch builder
   * as Master View (master-view/cell-edit.ts). The ECC is re-derived by the
   * database trigger from the saved cost, and the returned row replaces the
   * old one, so the package totals above re-price from it.
   *
   * Saves for one row run one at a time: a custom-field patch carries the
   * row's whole customFields object, so two in flight at once would let the
   * second undo the first.
   */
  function commitAnswer(itemId: string, field: FormField) {
    const value = answerDraftsRef.current[itemId]?.[field.key]
    if (value === undefined) return
    const statusKey = `${itemId}:${field.key}`
    const inFlight = answerInFlight.current.get(statusKey)
    if (inFlight !== undefined && sameCellValue(inFlight, value)) return
    const draft: RowDraft = { [field.key]: value }
    const errors = validateRowDraft(formFields, draft)
    if (errors[field.key]) {
      setAnswerStatus((prev) => ({ ...prev, [statusKey]: { error: errors[field.key] } }))
      return
    }
    setAnswerStatus((prev) => ({ ...prev, [statusKey]: { saving: true } }))
    answerInFlight.current.set(statusKey, value)

    const run = async () => {
      const item = lineItemsRef.current.find((row) => row.id === itemId)
      if (!item) {
        answerInFlight.current.delete(statusKey)
        return
      }
      try {
        const updated = await updateLineItem(itemId, buildRowPatch(item, formFields, draft))
        if (!updated) throw new Error('Not saved: you no longer have access to this item.')
        lineItemsRef.current = lineItemsRef.current.map((row) =>
          row.id === updated.id ? updated : row
        )
        if (!isMountedRef.current) return
        setAllLineItems((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
        // Drop the draft only if nothing new was typed while saving.
        const current = answerDraftsRef.current[itemId]
        if (current && field.key in current && sameCellValue(current[field.key], value)) {
          const row = { ...current }
          delete row[field.key]
          const next = { ...answerDraftsRef.current }
          if (Object.keys(row).length > 0) next[itemId] = row
          else delete next[itemId]
          answerDraftsRef.current = next
          setAnswerDrafts(next)
        }
        setAnswerStatus((prev) => {
          const copy = { ...prev }
          delete copy[statusKey]
          return copy
        })
      } catch (err) {
        if (!isMountedRef.current) return
        setAnswerStatus((prev) => ({
          ...prev,
          [statusKey]: { error: err instanceof Error ? err.message : 'Failed to save.' },
        }))
      } finally {
        if (answerInFlight.current.get(statusKey) === value) answerInFlight.current.delete(statusKey)
      }
    }

    const chained = (answerSaveChains.current.get(itemId) ?? Promise.resolve()).then(run)
    answerSaveChains.current.set(itemId, chained)
  }

  function toggleAnswersEditing(chunkId: string) {
    const closing = answersEditingChunkId === chunkId
    setAnswersEditingChunkId(closing ? null : chunkId)
    // Anything still showing is either saved already or failed validation;
    // leaving edit mode drops the failed text rather than keeping it hidden.
    answerDraftsRef.current = {}
    setAnswerDrafts({})
    setAnswerStatus({})
  }

  const lineItemMap = useMemo(
    () => new Map(allLineItems.map((item) => [item.id, item])),
    [allLineItems]
  )

  // Group once per render rather than filtering allPhases inside the .map()
  // below - that would be O(packages x phases) on every keystroke anywhere
  // in an expanded editor, since ChunkingTab re-renders the whole list.
  const phasesByChunk = useMemo(() => {
    const map = new Map<string, ChunkPhase[]>()
    for (const phase of allPhases) {
      const list = map.get(phase.chunkProjectId)
      if (list) {
        list.push(phase)
      } else {
        map.set(phase.chunkProjectId, [phase])
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return map
  }, [allPhases])

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
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-full bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
            {chunkProjects.length} Packages
          </div>
          <ColumnsFilter view={phasingView} columns={columnCatalog} />
          {canEdit || permissionsLoading ? (
            <button
              type="button"
              onClick={handleOpenCreateDialog}
              disabled={!canEdit}
              className="rounded-[1rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create Package
            </button>
          ) : null}
        </div>
      </div>

      {chunkProjectsError || lineItemsError || phasesError || actionError ? (
        <div className="rounded-[1.5rem] border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          {actionError ||
            chunkProjectsError?.message ||
            lineItemsError?.message ||
            phasesError?.message ||
            'Something went wrong.'}
          {createRepair && actionError ? (
            <button
              type="button"
              onClick={() => void handleRetryCreate()}
              disabled={isCreatingChunk}
              className="ml-3 rounded-full border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
            >
              {isCreatingChunk ? 'Retrying…' : 'Retry'}
            </button>
          ) : null}
        </div>
      ) : null}

      {chunkProjects.length === 0 ? (
        <div className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-sm font-medium text-slate-400">
          {chunkProjectsLoading ? 'Loading packages…' : 'No packages'}
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
              (sum, entry) =>
                sum +
                getLineItemTotal(
                  entry.item,
                  getPricedQuantity(chunk.id, entry.item.id, entry.link.quantity)
                ),
              0
            )
            // eccAmount (not estimatedFirstCost) is the package's ECC for
            // phase costing, to match lib/cost-model.ts's PackageInput.eccBase
            // exactly: it is the trigger-derived numeric column, not a
            // re-parse of the free-text first-cost field the table above
            // displays. The two can differ by a rounding hair; phase dollars
            // should agree with the engine that will eventually escalate them,
            // not with the display-only total above.
            const chunkEccBase = linkedItems.reduce(
              (sum, entry) =>
                sum +
                // Null = unanswered or unreadable cost (0019); it prices as $0
                // here, the same as on the Timeline and in the export.
                (entry.item.eccAmount ?? 0) *
                  readQuantity(
                    getPricedQuantity(chunk.id, entry.item.id, entry.link.quantity)
                  ).value,
              0
            )
            const chunkPhases = phasesByChunk.get(chunk.id) ?? []
            // What a package delete takes with it, for the confirm text.
            const chunkPhaseIds = new Set(chunkPhases.map((p) => p.id))
            const chunkLinks = allDependencies.filter(
              (d) =>
                chunkPhaseIds.has(d.predecessorPhaseId) || chunkPhaseIds.has(d.successorPhaseId)
            )
            const crossPackageLinks = chunkLinks.filter(
              (d) =>
                !(chunkPhaseIds.has(d.predecessorPhaseId) && chunkPhaseIds.has(d.successorPhaseId))
            ).length

            const answersEditing = answersEditingChunkId === chunk.id
            const anyAnswerEditable = linkedItems.some((entry) => canEditAnswers(entry.item))

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
                            disabled={savingEditChunkId === chunk.id}
                            className="rounded-[1rem] bg-slate-950 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {savingEditChunkId === chunk.id ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingChunkId(null)
                              setEditingName('')
                            }}
                            disabled={savingEditChunkId === chunk.id}
                            className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                      {(canEdit || permissionsLoading) && editingChunkId !== chunk.id ? (
                        <button
                          type="button"
                          onClick={() => handleStartEdit(chunk)}
                          disabled={!canEdit}
                          className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Rename
                        </button>
                      ) : null}

                      {/* The visible label stays short, but the accessible name
                          carries the package number. Five cards in a row each
                          offering a button called "Edit" tells a screen-reader
                          user nothing about which package they are about to
                          open. `permissionsLoading` keeps this from claiming
                          "View" for an editor and then relabeling the button
                          right as the pointer is on it -- a neutral "Open"
                          until the role is actually known. */}
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Hide' : permissionsLoading ? 'Open' : canEdit ? 'Edit' : 'View'} package ${chunk.chunkNumber}`}
                        onClick={() => setExpandedChunkId(expanded ? null : chunk.id)}
                        className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300"
                      >
                        {expanded ? 'Hide' : permissionsLoading ? 'Open' : canEdit ? 'Edit' : 'View'}
                      </button>

                      {canEdit || permissionsLoading ? (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteChunkId(chunk.id)}
                          disabled={
                            !canEdit ||
                            deletingChunkId === chunk.id ||
                            confirmDeleteChunkId === chunk.id
                          }
                          className="rounded-[1rem] border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {deletingChunkId === chunk.id ? 'Deleting…' : 'Delete'}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {confirmDeleteChunkId === chunk.id ? (
                    <div
                      role="alertdialog"
                      aria-label={`Confirm delete package ${chunk.chunkNumber}`}
                      className="mt-4 flex flex-col gap-3 rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 md:flex-row md:items-center md:justify-between"
                    >
                      <span>
                        Delete {chunk.chunkNumber} &ldquo;{chunk.name}&rdquo;? This also deletes its{' '}
                        {chunkPhases.length} {chunkPhases.length === 1 ? 'phase' : 'phases'} and{' '}
                        {chunkLinks.length} dependency {chunkLinks.length === 1 ? 'link' : 'links'}
                        {crossPackageLinks > 0
                          ? ` (${crossPackageLinks} used by other packages)`
                          : ''}
                        . Can&apos;t be undone.
                      </span>
                      <span className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleDeleteChunk(chunk.id)}
                          disabled={deletingChunkId === chunk.id}
                          className="rounded-[1rem] bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteChunkId(null)}
                          disabled={deletingChunkId === chunk.id}
                          className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="px-6 py-6">
                  {linkedItems.length > 0 && (anyAnswerEditable || answersEditing) ? (
                    <div className="mb-3 flex justify-end">
                      <button
                        type="button"
                        onClick={() => toggleAnswersEditing(chunk.id)}
                        aria-pressed={answersEditing}
                        aria-label={`${answersEditing ? 'Done editing' : 'Edit'} answers in package ${chunk.chunkNumber}`}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                          answersEditing
                            ? 'border-slate-900 bg-slate-950 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                        }`}
                      >
                        {answersEditing ? 'Done' : 'Edit answers'}
                      </button>
                    </div>
                  ) : null}
                  {linkedItems.length === 0 ? (
                    <div className="rounded-[1.5rem] border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400">
                      Empty
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-[1.6rem] border border-slate-200 bg-white">
                      <div className="overflow-x-auto">
                        <table className="min-w-full border-collapse text-sm">
                          <thead>
                            <tr className="bg-slate-950 text-left">
                              {columns.map((column) => (
                                <th
                                  key={column.key}
                                  className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70"
                                >
                                  {column.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {linkedItems.map(({ item, link }) => {
                              const styles = getDisciplineStyles(item.discipline)
                              const quantityKey = getQuantityKey(chunk.id, item.id)
                              const effectiveQuantity = getEffectiveQuantity(
                                chunk.id,
                                item.id,
                                link.quantity
                              )
                              const lineItemTotal = getLineItemTotal(item, effectiveQuantity)
                              const quantityError = quantityErrors[quantityKey]

                              return (
                                <tr
                                  key={item.id}
                                  className={`border-t border-slate-100 ${styles.surface} ${styles.row}`}
                                >
                                  {columns.map((column) => {
                                    if (column.key === CHUNKING_COLUMN_KEYS.itemNumber) {
                                      return (
                                        <td
                                          key={column.key}
                                          className="px-4 py-3 align-top font-medium text-slate-950"
                                        >
                                          {item.itemNumber}
                                        </td>
                                      )
                                    }
                                    const editField =
                                      answersEditing && canEditAnswers(item)
                                        ? fieldByKey.get(column.key)
                                        : undefined
                                    if (editField) {
                                      const statusKey = `${item.id}:${editField.key}`
                                      const status = answerStatus[statusKey]
                                      const draftRow = answerDrafts[item.id]
                                      const dirty = Boolean(draftRow && editField.key in draftRow)
                                      const value = dirty
                                        ? draftRow[editField.key]
                                        : initialCellValue(editField, item)
                                      return (
                                        <td
                                          key={column.key}
                                          onBlur={(event) => {
                                            // Focus moving inside the cell (a
                                            // multiselect's popover) is not leaving it.
                                            if (
                                              !event.currentTarget.contains(
                                                event.relatedTarget as Node | null
                                              )
                                            ) {
                                              commitAnswer(item.id, editField)
                                            }
                                          }}
                                          onKeyDown={(event) => {
                                            if (
                                              event.key === 'Enter' &&
                                              !(event.target instanceof HTMLTextAreaElement)
                                            ) {
                                              commitAnswer(item.id, editField)
                                            }
                                          }}
                                          className={`min-w-[140px] max-w-[340px] px-4 py-3 align-top ${
                                            dirty ? 'bg-amber-50/70' : ''
                                          }`}
                                        >
                                          <EditableCell
                                            field={editField}
                                            value={value}
                                            onChange={(next) => {
                                              setAnswerDraft(item, editField, next)
                                              if (COMMIT_ON_CHANGE.has(editField.inputType)) {
                                                commitAnswer(item.id, editField)
                                              }
                                            }}
                                            error={status?.error}
                                            disabled={status?.saving}
                                            synergyOptions={synergyOptions.filter(
                                              (t) => t !== item.discipline
                                            )}
                                          />
                                          {status?.error ? (
                                            <p className="mt-1 max-w-[220px] text-[10px] text-rose-600">
                                              {status.error}
                                            </p>
                                          ) : null}
                                        </td>
                                      )
                                    }
                                    if (column.key === CHUNKING_COLUMN_KEYS.name) {
                                      return (
                                        <td
                                          key={column.key}
                                          className="px-4 py-3 align-top font-medium text-slate-950"
                                        >
                                          {item.name}
                                        </td>
                                      )
                                    }
                                    if (column.key === CHUNKING_COLUMN_KEYS.total) {
                                      return (
                                        <td
                                          key={column.key}
                                          className="px-4 py-3 align-top font-semibold text-slate-700"
                                        >
                                          {formatCurrency(lineItemTotal)}
                                        </td>
                                      )
                                    }
                                    if (column.key === CHUNKING_COLUMN_KEYS.quantity) {
                                      return (
                                        <td key={column.key} className="px-4 py-3 align-top">
                                          <input
                                            aria-label={`Quantity for ${item.itemNumber}`}
                                            aria-invalid={quantityError ? true : undefined}
                                            value={effectiveQuantity}
                                            onChange={(e) =>
                                              handleQuantityChange(chunk.id, item.id, e.target.value)
                                            }
                                            // Quantity multiplies straight into the
                                            // package ECC, so it is a cost edit even
                                            // though it looks like a table cell.
                                            readOnly={!canEdit}
                                            placeholder="Qty"
                                            title={quantityError}
                                            className={`w-28 rounded-[0.95rem] border bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 ${
                                              quantityError ? 'border-red-300' : 'border-slate-200'
                                            }`}
                                          />
                                          {quantityError ? (
                                            <div
                                              role="alert"
                                              className="mt-1 max-w-[11rem] text-xs text-red-600"
                                            >
                                              {quantityError}
                                            </div>
                                          ) : quantityInputFeedback(effectiveQuantity).kind === 'ok' ? (
                                            // Echo the parsed value ("1,200" -> "= 1,200") so a
                                            // quantity that feeds straight into the ECC is
                                            // confirmed as read, not just accepted (M-10).
                                            <div className="mt-1 text-xs text-slate-500">
                                              {quantityInputFeedback(effectiveQuantity).message}
                                            </div>
                                          ) : null}
                                        </td>
                                      )
                                    }

                                    // Not a form field: the system stamps it from
                                    // the submitter, so it is read off the item.
                                    if (column.key === CHUNKING_COLUMN_KEYS.discipline) {
                                      return (
                                        <td key={column.key} className="px-4 py-3 align-top">
                                          <span
                                            className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles.badge}`}
                                          >
                                            {item.discipline || '-'}
                                          </span>
                                        </td>
                                      )
                                    }

                                    const field = fieldByKey.get(column.key)
                                    if (!field) return <td key={column.key} className="px-4 py-3" />
                                    const text = formatFieldValue(field, getFieldValue(item, field), {
                                      empty: '-',
                                    })
                                    return (
                                      <td
                                        key={column.key}
                                        className="max-w-[340px] px-4 py-3 align-top text-slate-600"
                                      >
                                        <div className="whitespace-pre-wrap">{text}</div>
                                      </td>
                                    )
                                  })}
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
                    {/* The Add/Remove picker is nothing but a write surface --
                        there is no reading value in a list of items you cannot
                        attach. A reader drops straight to the phase editor,
                        which is worth seeing either way. */}
                    <div className={canEdit ? 'grid gap-6 xl:grid-cols-2' : 'hidden'}>
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
                                    disabled={addingItemKey === `${chunk.id}:${item.id}`}
                                    className="rounded-[1rem] bg-slate-950 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {addingItemKey === `${chunk.id}:${item.id}` ? 'Adding…' : 'Add'}
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
                                    disabled={removingItemKey === `${chunk.id}:${item.id}`}
                                    className="rounded-[1rem] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {removingItemKey === `${chunk.id}:${item.id}`
                                      ? 'Removing…'
                                      : 'Remove'}
                                  </button>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-6">
                      <PhaseEditor
                        phases={chunkPhases}
                        eccBase={chunkEccBase}
                        tpcFactor={costSettings?.tpcFactor ?? 1}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={isCreateDialogOpen}
        onClose={handleCloseCreateDialog}
        title="New package"
        size="lg"
        dismissable={!isCreatingChunk}
        footer={
          <>
            <span className="mr-auto rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">
              {selectedLineItemIds.length} selected
            </span>
            <button
              type="button"
              onClick={handleCloseCreateDialog}
              disabled={isCreatingChunk}
              className="rounded-[1rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreateChunk}
              disabled={!newChunkName.trim() || isCreatingChunk}
              className="rounded-[1rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_48%,#0f766e_100%)] px-5 py-2.5 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isCreatingChunk ? 'Creating…' : 'Create'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {actionError && isCreateDialogOpen ? (
            <div
              role="alert"
              className="rounded-[1.2rem] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {actionError}
            </div>
          ) : null}

          <input
            id="chunk-project-name"
            aria-label="Package name"
            value={newChunkName}
            onChange={(e) => setNewChunkName(e.target.value)}
            placeholder="Package name"
            autoFocus
            className="w-full rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-base outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />

          <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="chunk-line-item-search"
                  aria-label="Search line items"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search"
                  className="flex-1 rounded-[1.2rem] border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                />
                <button
                  type="button"
                  onClick={handleSelectAllFiltered}
                  disabled={filteredLineItems.length === 0}
                  className="rounded-[1.2rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  disabled={selectedLineItemIds.length === 0}
                  className="rounded-[1.2rem] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Clear
                </button>
              </div>

              <div className="grid gap-2">
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
                        className={`group flex cursor-pointer items-start gap-4 rounded-[1.2rem] border px-4 py-3 transition ${
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
                            className={`mt-2 text-sm font-semibold ${
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
            </>
        </div>
      </Modal>
    </div>
  )
}
