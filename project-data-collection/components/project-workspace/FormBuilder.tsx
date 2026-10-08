'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { isRemovedField } from '@/lib/form-defaults'
import {
  deleteFormField,
  removeBuiltinFormField,
  reorderFormFields,
  updateFormField,
} from '@/lib/store'
import type { FormField } from '@/lib/types'
import AddQuestionsModal from './form-builder/AddQuestionsModal'
import EditFieldModal from './form-builder/EditFieldModal'
import FieldRow from './form-builder/FieldRow'
import GroupNameModal from './form-builder/GroupNameModal'
import {
  CheckIcon,
  GripIcon,
  IconButton,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  groupDisplayName,
  groupKeyOf,
} from './form-builder/shared'

/**
 * Editor for a project's line-item FORM (migration 0012) -- the "Input form"
 * column of Settings.
 *
 * The client's own words: "instead of vocabulary like that, can we make it
 * such that they can create a form with the different input types and then
 * the different options? ... don't call it a vocabulary, just call it a
 * form creation." The questions themselves -- labels, types, order and
 * grouping -- are what is edited here; options are a property a question
 * has when its type calls for one.
 *
 * COMPACT UNTIL EDITED. The list shows each question's label, input type and
 * status pills, nothing else. A chevron opens a dropdown's options. The
 * header's edit button switches on edit mode: drag handles, clickable pills,
 * per-row edit (a popup) and remove. Adding is a popup that takes several
 * questions at once.
 *
 * THREE KINDS OF QUESTION (see lib/form-defaults.ts):
 *   - Default (`isDefaultField`): name, short description, category,
 *     timeline priority, annual energy saving. Renameable and movable;
 *     never hidden or removed.
 *   - Other column-backed (`isBuiltin`): pre-seeded, backed by a real
 *     `line_items` column other code reads by name, so `ship.guard_form_field`
 *     refuses to delete or retype one. "Remove" therefore hides it AND marks
 *     it removed (`removeBuiltinFormField`); removed ones leave this list.
 *   - Custom (`!isBuiltin`): lives in `LineItem.customFields`. Retypeable,
 *     and "Remove" deletes it for real.
 *
 * HIDE IS NOT REMOVE (owner's call): any non-default question can be hidden
 * in place with its Visible/Hidden pill and shown again whenever; Remove
 * (always behind a confirm) takes it out of the form for good.
 *
 * ORDER. `reorderFormFields` persists one project-wide order (it renumbers
 * whatever id list it is given 0..n-1), so every move resends every id --
 * removed questions included, kept in the slots they already occupy. Groups
 * are the wizard steps (`groupLabel`); dragging a question into another
 * group rewrites its groupLabel first, then the order.
 *
 * GROUPS ARE JUST LABELS. A group exists because some field carries its
 * `groupLabel`, so an empty one has nothing to persist in. "Add group" (and
 * a group whose last question was dragged out) is therefore held in this
 * component's state for the session -- shown at the bottom, ready for a
 * question to be dragged or added into it -- and becomes real the moment one
 * is. Renaming a group rewrites `groupLabel` on every field that carries it,
 * removed ones included, so nothing is left behind under the old name.
 */

type Props = {
  projectId: string
  fields: FormField[]
  onChanged: () => void
  readOnly?: boolean
}

type Group = { key: string; fields: FormField[] }

type DragItem = { kind: 'field'; id: string } | { kind: 'group'; key: string }
type DropTarget =
  | { kind: 'field'; id: string; after: boolean }
  | { kind: 'group'; key: string; after: boolean }

/**
 * A drag shows its result straight away rather than snapping back for the
 * length of two round trips. Tied to the `fields` array it was computed
 * from: as soon as the parent hands in a refetched list, that list wins.
 */
type Optimistic = {
  base: FormField[]
  order: string[]
  groupOverrides: Record<string, string>
}

type ModalSession = { n: number; open: boolean }
type GroupModal = ModalSession & ({ mode: 'add' } | { mode: 'rename'; key: string })

let sessionCounter = 0

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function isAfter(event: DragEvent<HTMLElement>): boolean {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY > rect.top + rect.height / 2
}

export default function FormBuilder({ projectId, fields, onChanged, readOnly = false }: Props) {
  const [editMode, setEditMode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [reordering, setReordering] = useState(false)
  const [optimistic, setOptimistic] = useState<Optimistic | null>(null)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragItem | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [editSession, setEditSession] = useState<(ModalSession & { field: FormField }) | null>(
    null
  )
  const [addSession, setAddSession] = useState<(ModalSession & { group: string }) | null>(null)
  const [groupModal, setGroupModal] = useState<GroupModal | null>(null)
  // Session-only empty groups (see GROUPS ARE JUST LABELS above).
  const [emptyGroups, setEmptyGroups] = useState<string[]>([])
  const refocusHandle = useRef<string | null>(null)

  const editing = editMode && !readOnly

  // ---- derived lists -------------------------------------------------------

  const effective = useMemo(() => {
    const sorted = [...fields].sort((a, b) => a.sortOrder - b.sortOrder)
    if (!optimistic || optimistic.base !== fields) return sorted
    const byId = new Map(sorted.map((f) => [f.id, f]))
    const ordered = optimistic.order
      .map((id) => byId.get(id))
      .filter((f): f is FormField => f !== undefined)
      .map((f) =>
        f.id in optimistic.groupOverrides ? { ...f, groupLabel: optimistic.groupOverrides[f.id] } : f
      )
    // Anything the optimistic order doesn't know about keeps its place at the end.
    const known = new Set(optimistic.order)
    return [...ordered, ...sorted.filter((f) => !known.has(f.id))]
  }, [fields, optimistic])

  const groups = useMemo<Group[]>(() => {
    const order: string[] = []
    const byKey = new Map<string, FormField[]>()
    for (const field of effective) {
      if (isRemovedField(field)) continue
      const key = groupKeyOf(field)
      if (!byKey.has(key)) {
        order.push(key)
        byKey.set(key, [])
      }
      byKey.get(key)!.push(field)
    }
    const persisted = order.map((key) => ({ key, fields: byKey.get(key)! }))
    const empties = emptyGroups
      .filter((key) => key !== '' && !byKey.has(key))
      .map((key) => ({ key, fields: [] as FormField[] }))
    return [...persisted, ...empties]
  }, [effective, emptyGroups])

  // Exactly the named groups on screen. A label carried only by REMOVED
  // fields is invisible, so it is neither suggested nor treated as taken;
  // reusing it just puts new questions alongside rows nobody can see.
  const groupSuggestions = useMemo(
    () => groups.map((g) => g.key).filter((key) => key !== ''),
    [groups]
  )

  // ---- single-field actions ------------------------------------------------

  async function runField(fieldId: string, action: () => Promise<unknown>) {
    setPendingIds((prev) => new Set(prev).add(fieldId))
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      // `ship.guard_form_field` names the field and says why -- that is more
      // useful than anything this component could invent, so it is shown
      // exactly as thrown rather than replaced.
      setError(errorMessage(err))
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(fieldId)
        return next
      })
    }
  }

  async function handleConfirmRemove(field: FormField) {
    // Column-backed: the database won't delete the row (other code reads the
    // column), so it is hidden and marked removed instead. Custom: deleted.
    await runField(field.id, () =>
      field.isBuiltin ? removeBuiltinFormField(field.id) : deleteFormField(field.id)
    )
    setConfirmingDeleteId(null)
  }

  // ---- reordering ----------------------------------------------------------

  /**
   * Persist a new arrangement of the LISTED questions. Removed ones keep the
   * slots they occupy in the project-wide order; the listed ones fill the
   * remaining slots in their new order.
   */
  function commitArrangement(
    next: Group[],
    groupChange?: { id: string; groupLabel: string }
  ): boolean {
    const listedOrder = next.flatMap((g) => g.fields.map((f) => f.id))
    const listedSet = new Set(listedOrder)
    let cursor = 0
    const fullOrder = effective.map((f) => (listedSet.has(f.id) ? listedOrder[cursor++] : f.id))

    const unchanged = fullOrder.every((id, i) => id === effective[i].id)
    if (unchanged && !groupChange) return false

    void persistArrangement(fullOrder, groupChange)
    return true
  }

  async function persistArrangement(
    fullOrder: string[],
    groupChange?: { id: string; groupLabel: string }
  ) {
    setOptimistic({
      base: fields,
      order: fullOrder,
      groupOverrides: groupChange ? { [groupChange.id]: groupChange.groupLabel } : {},
    })
    setReordering(true)
    setError(null)
    try {
      if (groupChange) {
        await updateFormField(groupChange.id, { groupLabel: groupChange.groupLabel })
      }
      await reorderFormFields(projectId, fullOrder)
      onChanged()
    } catch (err) {
      // Drop the optimistic view and re-fetch so the list shows what the
      // database really holds, then say why.
      setOptimistic(null)
      onChanged()
      setError(errorMessage(err))
    } finally {
      setReordering(false)
    }
  }

  /** Move a question into `targetKey`'s group at `index` (counted with the
   *  question already taken out of its old place). Returns whether anything
   *  actually moved. */
  function moveField(fieldId: string, targetKey: string, index: number): boolean {
    const field = groups.flatMap((g) => g.fields).find((f) => f.id === fieldId)
    if (!field) return false
    const next = groups.map((g) => ({ key: g.key, fields: g.fields.filter((f) => f.id !== fieldId) }))
    const target = next.find((g) => g.key === targetKey)
    if (!target) return false
    target.fields.splice(Math.max(0, Math.min(index, target.fields.length)), 0, field)

    const sourceKey = groupKeyOf(field)
    const changed = sourceKey !== targetKey
    // A named group whose last question just left stays on screen (empty),
    // so it can take another question or be deleted deliberately.
    if (changed && sourceKey !== '' && next.find((g) => g.key === sourceKey)?.fields.length === 0) {
      setEmptyGroups((prev) => (prev.includes(sourceKey) ? prev : [...prev, sourceKey]))
    }
    return commitArrangement(
      next.filter((g) => g.fields.length > 0),
      changed ? { id: field.id, groupLabel: targetKey } : undefined
    )
  }

  function moveGroup(key: string, targetKey: string, after: boolean): boolean {
    if (key === targetKey) return false
    const moving = groups.find((g) => g.key === key)
    if (!moving) return false
    const rest = groups.filter((g) => g.key !== key)
    const index = rest.findIndex((g) => g.key === targetKey)
    if (index < 0) return false
    rest.splice(index + (after ? 1 : 0), 0, moving)
    return commitArrangement(rest)
  }

  /** Arrow keys on a handle: one step, crossing into the neighbouring group
   *  at a boundary (which regroups the question, same as dragging it). */
  function nudgeField(field: FormField, direction: -1 | 1): boolean {
    const gi = groups.findIndex((g) => g.key === groupKeyOf(field))
    if (gi < 0) return false
    const group = groups[gi]
    const index = group.fields.findIndex((f) => f.id === field.id)
    const target = index + direction
    if (target >= 0 && target < group.fields.length) {
      return moveField(field.id, group.key, target)
    }
    const neighbour = groups[gi + direction]
    if (!neighbour) return false
    return moveField(field.id, neighbour.key, direction === -1 ? neighbour.fields.length : 0)
  }

  function nudgeGroup(key: string, direction: -1 | 1): boolean {
    // Empty groups always sit at the bottom (they have no place in the saved
    // order yet), so only groups with questions take part.
    const filled = groups.filter((g) => g.fields.length > 0)
    const gi = filled.findIndex((g) => g.key === key)
    const neighbour = filled[gi + direction]
    if (gi < 0 || !neighbour) return false
    return moveGroup(key, neighbour.key, direction === 1)
  }

  // ---- group create / rename / delete --------------------------------------

  async function renameGroup(oldKey: string, newName: string) {
    const carriers = fields.filter((f) => groupKeyOf(f) === oldKey)
    try {
      // One at a time: a partial failure leaves a clear split rather than
      // an unknown one, and the refetch below shows exactly where it stopped.
      for (const field of carriers) {
        await updateFormField(field.id, { groupLabel: newName })
      }
    } finally {
      if (carriers.length > 0) onChanged()
    }
    setEmptyGroups((prev) => prev.map((key) => (key === oldKey ? newName : key)))
  }

  function addGroup(name: string) {
    setEmptyGroups((prev) => (prev.includes(name) ? prev : [...prev, name]))
  }

  function deleteEmptyGroup(key: string) {
    setEmptyGroups((prev) => prev.filter((k) => k !== key))
  }

  // ---- drag and drop (native HTML5) ----------------------------------------

  function startDrag(event: DragEvent<HTMLElement>, item: DragItem, rowSelector: string) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox won't start a drag without some data on it.
    event.dataTransfer.setData('text/plain', item.kind === 'field' ? item.id : item.key)
    const row = event.currentTarget.closest(rowSelector)
    if (row instanceof HTMLElement) {
      const rect = row.getBoundingClientRect()
      event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top)
    }
    setDrag(item)
  }

  function endDrag() {
    setDrag(null)
    setDropTarget(null)
  }

  function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
    if (!a || a.kind !== b.kind || a.after !== b.after) return false
    return a.kind === 'field' ? a.id === (b as { id: string }).id : a.key === (b as { key: string }).key
  }

  function overTarget(event: DragEvent<HTMLElement>, target: DropTarget) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    if (!sameTarget(dropTarget, target)) setDropTarget(target)
  }

  function dropOnField(event: DragEvent<HTMLElement>, groupKey: string, fieldId: string) {
    if (drag?.kind !== 'field') return
    event.preventDefault()
    event.stopPropagation()
    const after = isAfter(event)
    const draggedId = drag.id
    endDrag()
    if (draggedId === fieldId) return
    const group = groups.find((g) => g.key === groupKey)
    if (!group) return
    const withoutDragged = group.fields.filter((f) => f.id !== draggedId)
    const index = withoutDragged.findIndex((f) => f.id === fieldId)
    moveField(draggedId, groupKey, index + (after ? 1 : 0))
  }

  function dropOnGroup(event: DragEvent<HTMLElement>, groupKey: string) {
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    const current = drag
    const after = isAfter(event)
    endDrag()
    if (current.kind === 'group') moveGroup(current.key, groupKey, after)
    // A question dropped on a group's header goes to the top of that group.
    else moveField(current.id, groupKey, 0)
  }

  function handleKeys(
    event: KeyboardEvent<HTMLElement>,
    handleId: string,
    onMove: (direction: -1 | 1) => boolean
  ) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      if (reordering) return
      // A nudge across a group boundary remounts the row under its new
      // group, which drops focus to <body>; put it back on the same handle.
      // Armed only when something actually moved -- a no-op (top of the
      // list, an empty group) leaves focus where it is and must not leave a
      // stale request that yanks focus out of the next popup opened.
      refocusHandle.current = onMove(event.key === 'ArrowUp' ? -1 : 1) ? handleId : null
    }
  }

  // Runs after every render: if a keyboard nudge asked for it, re-focus the
  // moved item's handle (found by its data attribute, since it may be a
  // brand-new element in a different group).
  useEffect(() => {
    const id = refocusHandle.current
    if (id === null) return
    const handle = document.querySelector<HTMLElement>(
      `[data-reorder-handle="${CSS.escape(id)}"]`
    )
    // Only reclaim focus that was LOST (dropped to <body> by a remount),
    // never focus the user has since moved somewhere else, such as a popup.
    const active = document.activeElement
    if (handle && handle !== active && (active === null || active === document.body)) {
      handle.focus()
    }
    // Keep trying until the save settles: the refetch can remount again.
    if (!reordering) refocusHandle.current = null
  })

  // ---- modals --------------------------------------------------------------

  // Stable identities: Modal re-runs its open effect (and re-focuses its
  // panel, stealing focus from whatever input has it) whenever onClose
  // changes, so these must not be recreated on every render.
  const closeEdit = useCallback(
    () => setEditSession((s) => (s ? { ...s, open: false } : s)),
    []
  )
  const closeAdd = useCallback(() => setAddSession((s) => (s ? { ...s, open: false } : s)), [])
  const closeGroupModal = useCallback(
    () => setGroupModal((s) => (s ? { ...s, open: false } : s)),
    []
  )

  const liveEditField = editSession
    ? (fields.find((f) => f.id === editSession.field.id) ?? editSession.field)
    : null

  // ---- render --------------------------------------------------------------

  const draggable = editing && !reordering

  return (
    // Not a disabled <fieldset> any more: read-only viewers still need the
    // chevrons. Every control that WRITES is edit-mode only, and edit mode is
    // unreachable without the header button, which read-only doesn't render.
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-slate-950">
          Consultant input form
        </h3>
        {readOnly ? (
          <span
            title="Only a project editor or admin can change the form."
            className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-800"
          >
            Read-only
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            <IconButton
              label={editMode ? 'Done editing' : 'Edit form'}
              onClick={() => {
                setEditMode((v) => !v)
                setConfirmingDeleteId(null)
              }}
              active={editMode}
            >
              {editMode ? <CheckIcon /> : <PencilIcon />}
            </IconButton>
            <IconButton
              label="Add questions"
              onClick={() => setAddSession({ n: ++sessionCounter, open: true, group: '' })}
            >
              <PlusIcon />
            </IconButton>
          </div>
        )}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 flex items-start justify-between gap-2 rounded-[0.9rem] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="shrink-0 font-medium text-rose-500 hover:text-rose-700"
          >
            ×
          </button>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="mt-3 rounded-[1rem] border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
          No questions yet.
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          {groups.map((group) => {
            const groupDrop =
              dropTarget?.kind === 'group' && dropTarget.key === group.key ? dropTarget : null
            const isGroupDrag = drag?.kind === 'group'
            const isFieldDrag = drag?.kind === 'field'
            const name = groupDisplayName(group.key)
            const empty = group.fields.length === 0
            const groupDraggable = draggable && !empty
            return (
              <section
                key={`g:${group.key}`}
                data-drag-group
                aria-label={`Group ${name}`}
                onDragOver={
                  isGroupDrag
                    ? (e) => overTarget(e, { kind: 'group', key: group.key, after: isAfter(e) })
                    : undefined
                }
                onDrop={isGroupDrag ? (e) => dropOnGroup(e, group.key) : undefined}
                className={`relative rounded-[1.1rem] border p-2 transition ${
                  drag?.kind === 'group' && drag.key === group.key ? 'opacity-50' : ''
                } ${
                  isFieldDrag && groupDrop
                    ? 'border-teal-300 bg-teal-50/60'
                    : 'border-slate-200 bg-slate-50/80'
                }`}
              >
                {isGroupDrag && groupDrop ? (
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-teal-500 ${
                      groupDrop.after ? '-bottom-1.5' : '-top-1.5'
                    }`}
                  />
                ) : null}

                <div
                  onDragOver={
                    isFieldDrag
                      ? (e) => overTarget(e, { kind: 'group', key: group.key, after: false })
                      : undefined
                  }
                  onDrop={isFieldDrag ? (e) => dropOnGroup(e, group.key) : undefined}
                  className="flex items-center gap-2 px-1 pb-1.5 pt-0.5"
                >
                  {editing ? (
                    // Rendered for the whole of edit mode (aria-disabled while
                    // a save is in flight) so the focused handle survives the
                    // `reordering` flip a keyboard nudge causes.
                    <div
                      role="button"
                      tabIndex={0}
                      draggable={groupDraggable}
                      data-reorder-handle={`group:${group.key}`}
                      onDragStart={(e) => startDrag(e, { kind: 'group', key: group.key }, '[data-drag-group]')}
                      onDragEnd={endDrag}
                      onKeyDown={(e) => handleKeys(e, `group:${group.key}`, (d) => nudgeGroup(group.key, d))}
                      aria-label={`Reorder group ${name} (arrow keys move it)`}
                      aria-disabled={!groupDraggable}
                      title={empty ? 'Add a question to place this group' : 'Drag to move this group'}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700 ${
                        groupDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default opacity-40'
                      }`}
                    >
                      <GripIcon />
                    </div>
                  ) : null}
                  <span className="min-w-0 truncate text-[13px] font-semibold text-slate-800">
                    {name}
                  </span>
                  <span className="shrink-0 rounded-full border border-slate-200 bg-white px-1.5 text-[10px] font-medium text-slate-500">
                    {group.fields.length}
                  </span>
                  <span className="flex-1" />
                  {editing ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setAddSession({ n: ++sessionCounter, open: true, group: group.key })
                        }
                        aria-label={`Add question to ${name}`}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-slate-500 transition hover:bg-white hover:text-slate-900"
                      >
                        <PlusIcon /> Question
                      </button>
                      <IconButton
                        label={`Rename group ${name}`}
                        onClick={() =>
                          setGroupModal({
                            n: ++sessionCounter,
                            open: true,
                            mode: 'rename',
                            key: group.key,
                          })
                        }
                        disabled={reordering}
                      >
                        <PencilIcon />
                      </IconButton>
                      {empty ? (
                        <IconButton
                          label={`Delete group ${name}`}
                          onClick={() => deleteEmptyGroup(group.key)}
                          tone="danger"
                        >
                          <TrashIcon />
                        </IconButton>
                      ) : null}
                    </>
                  ) : null}
                </div>

                <ul className="space-y-1 pl-3">
                  {empty ? (
                    <li
                      data-empty-group-drop
                      onDragOver={
                        isFieldDrag
                          ? (e) => overTarget(e, { kind: 'group', key: group.key, after: false })
                          : undefined
                      }
                      onDrop={isFieldDrag ? (e) => dropOnGroup(e, group.key) : undefined}
                      className="rounded-[0.8rem] border border-dashed border-slate-300 bg-white/60 px-3 py-3 text-center text-[12px] text-slate-400"
                    >
                      Empty group — drag a question here or add one
                    </li>
                  ) : null}
                  {group.fields.map((field) => {
                    const fieldDrop =
                      dropTarget?.kind === 'field' && dropTarget.id === field.id ? dropTarget : null
                    return (
                      <FieldRow
                        key={field.id}
                        field={field}
                        editMode={editing}
                        busy={pendingIds.has(field.id) || reordering}
                        expanded={expandedIds.has(field.id)}
                        confirmingDelete={confirmingDeleteId === field.id}
                        dropIndicator={
                          drag?.kind === 'field' && fieldDrop && drag.id !== field.id
                            ? fieldDrop.after
                              ? 'after'
                              : 'before'
                            : null
                        }
                        handle={
                          <div
                            role="button"
                            tabIndex={0}
                            draggable={draggable}
                            data-reorder-handle={`field:${field.id}`}
                            onDragStart={(e) => startDrag(e, { kind: 'field', id: field.id }, '[data-drag-row]')}
                            onDragEnd={endDrag}
                            onKeyDown={(e) => handleKeys(e, `field:${field.id}`, (d) => nudgeField(field, d))}
                            aria-label={`Reorder ${field.label} (arrow keys move it)`}
                            aria-disabled={!draggable}
                            title="Drag to reorder"
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-300 hover:text-slate-600 ${
                              draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-wait'
                            } ${drag?.kind === 'field' && drag.id === field.id ? 'text-teal-600' : ''}`}
                          >
                            <GripIcon />
                          </div>
                        }
                        onToggleExpand={() =>
                          setExpandedIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(field.id)) next.delete(field.id)
                            else next.add(field.id)
                            return next
                          })
                        }
                        onToggleRequired={() =>
                          void runField(field.id, () =>
                            updateFormField(field.id, { isRequired: !field.isRequired })
                          )
                        }
                        onToggleHidden={() =>
                          void runField(field.id, () =>
                            updateFormField(field.id, { isHidden: !field.isHidden })
                          )
                        }
                        onEdit={() =>
                          setEditSession({ n: ++sessionCounter, open: true, field })
                        }
                        onRemove={() => setConfirmingDeleteId(field.id)}
                        onConfirmDelete={() => void handleConfirmRemove(field)}
                        onCancelDelete={() => setConfirmingDeleteId(null)}
                        onDragOver={(e) => {
                          if (drag?.kind !== 'field') return
                          overTarget(e, { kind: 'field', id: field.id, after: isAfter(e) })
                        }}
                        onDrop={(e) => dropOnField(e, group.key, field.id)}
                      />
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}

      {editing ? (
        <button
          type="button"
          onClick={() => setGroupModal({ n: ++sessionCounter, open: true, mode: 'add' })}
          className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-[1.1rem] border border-dashed border-slate-300 px-3 py-2 text-[12px] font-medium text-slate-500 transition hover:border-slate-400 hover:text-slate-900"
        >
          <PlusIcon /> Add group
        </button>
      ) : null}

      {editSession && liveEditField ? (
        <EditFieldModal
          key={editSession.n}
          open={editSession.open}
          field={liveEditField}
          groupSuggestions={groupSuggestions}
          onClose={closeEdit}
          onChanged={onChanged}
        />
      ) : null}

      {addSession ? (
        <AddQuestionsModal
          key={addSession.n}
          open={addSession.open}
          projectId={projectId}
          groupSuggestions={groupSuggestions}
          initialGroup={addSession.group}
          onClose={closeAdd}
          onChanged={onChanged}
        />
      ) : null}

      {groupModal ? (
        <GroupNameModal
          key={groupModal.n}
          open={groupModal.open}
          title={groupModal.mode === 'add' ? 'Add group' : 'Rename group'}
          submitLabel={groupModal.mode === 'add' ? 'Add group' : 'Rename'}
          initialName={groupModal.mode === 'rename' ? groupModal.key : ''}
          existingNames={groupSuggestions.filter(
            (name) => groupModal.mode === 'add' || name !== groupModal.key
          )}
          onClose={closeGroupModal}
          onSubmit={async (name) => {
            if (groupModal.mode === 'add') addGroup(name)
            else await renameGroup(groupModal.key, name)
          }}
        />
      ) : null}
    </div>
  )
}
