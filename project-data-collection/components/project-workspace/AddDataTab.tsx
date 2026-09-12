'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  createLineItem,
  deleteLineItem,
  getLineItemsForProjectUser,
  updateLineItem,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import {
  BuildingAreaImpacted,
  BuildingLevelImpacted,
  ConsultantType,
  LineItem,
  LineItemCategory,
  Project,
  RelativeFirstCost,
  RelativeImpact,
  RelativeOperationCostImpact,
  RelativeOperationalEnergyUsage,
  SafeUser,
  TimelinePriority,
} from '@/lib/types'

type Props = {
  project: Project
  user: SafeUser
}

const CATEGORY_OPTIONS: LineItemCategory[] = [
  'END OF LIFE',
  'DEFERRED MAINTENANCE',
  'UPGRADES / IMPROVEMENTS',
  'RESTORATION *',
  'STUDY / DOCUMENTATION',
]

const PRIORITY_OPTIONS: TimelinePriority[] = [
  '0_PRIORITY *',
  '1_HIGH <5 years',
  '2_MID 5-10 years',
  '3_LOW 10-20 years',
  '4_FUTURE >20 years',
  '5_250th ANNIVERSARY',
]

const BUILDING_AREA_OPTIONS: BuildingAreaImpacted[] = [
  'WHOLE BUILDING',
  'ANNEX',
  'WEST WING',
  'EAST WING',
  'BULFINCH',
  'SITE',
  'OTHER *',
]

const BUILDING_LEVEL_OPTIONS: BuildingLevelImpacted[] = [
  'WHOLE BUILDING',
  'ROOF',
  'ENVELOPE (EXT. WALLS)',
  'LEVELS ABOVE GRADE',
  'LEVELS BELOW GRADE',
  'L5',
  'L4',
  'L3',
  'L2',
  'L1',
  'BASEMENT',
  'SUB BASEMENT',
  'OTHER *',
]

const RELATIVE_IMPACT_OPTIONS: RelativeImpact[] = [
  'NONE',
  'LOW',
  'MODERATE',
  'HIGH',
]

const FIRST_COST_OPTIONS: RelativeFirstCost[] = [
  '$LOW',
  '$$Moderate',
  '$$$High',
]

const OPERATION_COST_OPTIONS: RelativeOperationCostImpact[] = [
  'MINIMAL IMPACT',
  'MODERATE REDUCTION',
  'HIGH REDUCTION',
  'INCREASE',
  'N/A',
]

const ENERGY_USAGE_OPTIONS: RelativeOperationalEnergyUsage[] = [
  'MINIMAL IMPACT',
  'MODERATE REDUCTION',
  'HIGH REDUCTION',
  'N/A',
]

// `eccAmount` is omitted alongside the server-assigned fields because it is
// derived, not entered: a trigger recomputes it from `estimatedFirstCost` on
// every write (migration 0006). Putting it in an editable draft would offer the
// user a field whose value is silently discarded.
type DraftLineItem = Omit<
  LineItem,
  'id' | 'createdAt' | 'companyName' | 'discipline' | 'itemNumber' | 'eccAmount'
>

type EditableFlagField =
  | 'addressingResiliencySustainability'
  | 'addressingDeferredMaintenance'
  | 'codeLifeSafetyImprovement'
  | 'accessibilityImprovement'
  | 'historicImpact'

const FLAG_FIELDS: Array<{ key: EditableFlagField; label: string }> = [
  { key: 'addressingResiliencySustainability', label: 'Resiliency / Sustainability' },
  { key: 'addressingDeferredMaintenance', label: 'Deferred Maintenance' },
  { key: 'codeLifeSafetyImprovement', label: 'Code / Life Safety' },
  { key: 'accessibilityImprovement', label: 'Accessibility' },
  { key: 'historicImpact', label: 'Historic Impact' },
]

function getUserConsultantType(project: Project, user: SafeUser): ConsultantType {
  if (user.role === 'admin') return 'Architecture'

  const matchedConsultant = project.consultants.find((consultant) =>
    consultant.emails.includes(user.email)
  )

  return matchedConsultant?.type ?? 'Architecture'
}

function makeInitialDraft(project: Project, user: SafeUser): DraftLineItem {
  return {
    projectId: project.id,
    userEmail: user.email,
    consultantType: getUserConsultantType(project, user),
    name: '',
    shortDescription: '',
    category: 'END OF LIFE',
    timelinePriority: '0_PRIORITY *',
    buildingAreaImpacted: 'WHOLE BUILDING',
    buildingLevelImpacted: 'WHOLE BUILDING',
    operationalImpact: 'NONE',
    benefitToUsers: 'NONE',
    benefitToPublic: 'NONE',
    relativeFirstCost: '$LOW',
    estimatedFirstCost: '',
    relativeOperationCostImpact: 'MINIMAL IMPACT',
    relativeOperationalEnergyUsage: 'MINIMAL IMPACT',
    electrificationEO594: 'NONE',
    addressingResiliencySustainability: 'No',
    addressingDeferredMaintenance: 'No',
    codeLifeSafetyImprovement: 'No',
    accessibilityImprovement: 'No',
    historicImpact: 'No',
    potentialSynergies: [],
    supportingNotes: '',
    annualEnergySavings: 0,
    annualCostSavings: 0,
    energyNotes: '',
  }
}

function makeEditableDraft(item: LineItem): DraftLineItem {
  return {
    projectId: item.projectId,
    userEmail: item.userEmail,
    consultantType: item.consultantType === 'Admin' ? 'Architecture' : item.consultantType,
    name: item.name,
    shortDescription: item.shortDescription,
    category: item.category,
    timelinePriority: item.timelinePriority,
    buildingAreaImpacted: item.buildingAreaImpacted,
    buildingLevelImpacted: item.buildingLevelImpacted,
    operationalImpact: item.operationalImpact,
    benefitToUsers: item.benefitToUsers,
    benefitToPublic: item.benefitToPublic,
    relativeFirstCost: item.relativeFirstCost,
    estimatedFirstCost: item.estimatedFirstCost || '',
    relativeOperationCostImpact: item.relativeOperationCostImpact,
    relativeOperationalEnergyUsage: item.relativeOperationalEnergyUsage,
    electrificationEO594: item.electrificationEO594,
    addressingResiliencySustainability: item.addressingResiliencySustainability,
    addressingDeferredMaintenance: item.addressingDeferredMaintenance,
    codeLifeSafetyImprovement: item.codeLifeSafetyImprovement,
    accessibilityImprovement: item.accessibilityImprovement,
    historicImpact: item.historicImpact,
    potentialSynergies: item.potentialSynergies,
    supportingNotes: item.supportingNotes,
    annualEnergySavings: item.annualEnergySavings,
    annualCostSavings: item.annualCostSavings,
    energyNotes: item.energyNotes,
  }
}

function ChoicePills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: T[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {options.map((option) => {
        const active = option === value

        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`rounded-full px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
              active
                ? 'bg-black text-white shadow-md'
                : 'border border-gray-300 bg-white text-gray-700 hover:-translate-y-[1px] hover:border-black'
            }`}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

export default function AddDataTab({ project, user }: Props) {
  const {
    data: lineItems,
    loading: lineItemsLoading,
    error: lineItemsError,
    reload: reloadLineItems,
  } = useAsyncData<LineItem[]>(
    () => getLineItemsForProjectUser(project.id, user.email),
    [project.id, user.email],
    []
  )
  const [isCreating, setIsCreating] = useState(false)
  const [step, setStep] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftLineItem>(() => makeInitialDraft(project, user))
  const [editingDrafts, setEditingDrafts] = useState<Record<string, DraftLineItem>>({})
  const [isSavingNew, setIsSavingNew] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [savingEditId, setSavingEditId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const consultantType = getUserConsultantType(project, user)

  const synergyOptions = useMemo(() => {
    return project.consultants
      .map((consultant) => consultant.type)
      .filter((type) => type !== consultantType)
  }, [consultantType, project.consultants])

  const totalSteps = 7
  const progress = ((step + 1) / totalSteps) * 100

  function openCreateFlow() {
    setDraft(makeInitialDraft(project, user))
    setStep(0)
    setIsCreating(true)
  }

  function closeCreateFlow() {
    setIsCreating(false)
  }

  function goNext() {
    if (step < totalSteps - 1) setStep((prev) => prev + 1)
  }

  function goBack() {
    if (step > 0) setStep((prev) => prev - 1)
  }

  function toggleSynergy(type: ConsultantType) {
    setDraft((prev) => ({
      ...prev,
      potentialSynergies: prev.potentialSynergies.includes(type)
        ? prev.potentialSynergies.filter((item) => item !== type)
        : [...prev.potentialSynergies, type],
    }))
  }

  async function handleDelete(id: string) {
    setActionError(null)
    setPendingDeleteId(id)
    try {
      await deleteLineItem(id)
      if (!isMountedRef.current) return
      reloadLineItems()
      setEditingDrafts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      if (expandedId === id) setExpandedId(null)
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err instanceof Error ? err.message : 'Failed to delete line item.')
    } finally {
      if (isMountedRef.current) setPendingDeleteId(null)
    }
  }

  async function saveLineItem() {
    setActionError(null)
    setIsSavingNew(true)
    try {
      const created = await createLineItem(draft)
      if (!isMountedRef.current) return
      reloadLineItems()
      setExpandedId(created.id)
      setEditingDrafts((prev) => ({
        ...prev,
        [created.id]: makeEditableDraft(created),
      }))
      setIsCreating(false)
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err instanceof Error ? err.message : 'Failed to create line item.')
    } finally {
      if (isMountedRef.current) setIsSavingNew(false)
    }
  }

  function ensureEditDraft(item: LineItem) {
    setEditingDrafts((prev) => {
      if (prev[item.id]) return prev

      return {
        ...prev,
        [item.id]: makeEditableDraft(item),
      }
    })
  }

  function toggleExpanded(item: LineItem) {
    if (expandedId === item.id) {
      setExpandedId(null)
      return
    }

    ensureEditDraft(item)
    setExpandedId(item.id)
  }

  function updateEditingDraft<K extends keyof DraftLineItem>(
    lineItemId: string,
    field: K,
    value: DraftLineItem[K]
  ) {
    setEditingDrafts((prev) => ({
      ...prev,
      [lineItemId]: {
        ...prev[lineItemId],
        [field]: value,
      },
    }))
  }

  function updateEditingFlag(lineItemId: string, field: EditableFlagField, checked: boolean) {
    updateEditingDraft(lineItemId, field, checked ? 'Yes' : 'No')
  }

  function resetEditingDraft(item: LineItem) {
    setEditingDrafts((prev) => ({
      ...prev,
      [item.id]: makeEditableDraft(item),
    }))
  }

  function toggleEditSynergy(lineItemId: string, type: ConsultantType) {
    const current = editingDrafts[lineItemId]
    if (!current) return

    updateEditingDraft(
      lineItemId,
      'potentialSynergies',
      current.potentialSynergies.includes(type)
        ? current.potentialSynergies.filter((item) => item !== type)
        : [...current.potentialSynergies, type]
    )
  }

  async function saveEditedLineItem(lineItemId: string) {
    const currentDraft = editingDrafts[lineItemId]
    if (!currentDraft) return

    setActionError(null)
    setSavingEditId(lineItemId)
    try {
      const updated = await updateLineItem(lineItemId, currentDraft)
      if (!updated) return
      if (!isMountedRef.current) return

      reloadLineItems()
      setEditingDrafts((prev) => ({
        ...prev,
        [lineItemId]: makeEditableDraft(updated),
      }))
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err instanceof Error ? err.message : 'Failed to save changes.')
    } finally {
      if (isMountedRef.current) setSavingEditId(null)
    }
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 rounded-[1.75rem] border border-slate-200 bg-white/86 p-5 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-950">Line Items</h2>
            <p className="mt-1 text-sm text-slate-500">
              Add new scope items, then expand any row to edit details directly.
            </p>
          </div>

          <button
            type="button"
            onClick={openCreateFlow}
            className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
          >
            Add Line Item
          </button>
        </div>

        {lineItemsError || actionError ? (
          <div className="rounded-[1.5rem] border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            {actionError || lineItemsError?.message || 'Something went wrong.'}
          </div>
        ) : null}

        {lineItems.length === 0 ? (
          <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white p-12 text-center">
            <h4 className="text-lg font-semibold text-gray-900">
              {lineItemsLoading ? 'Loading line items…' : 'No line items yet'}
            </h4>
            <p className="mt-2 text-sm text-gray-500">
              {lineItemsLoading
                ? 'Fetching your line items.'
                : 'Start your list with a guided entry.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {lineItems.map((item) => {
              const expanded = expandedId === item.id
              const editDraft = editingDrafts[item.id] ?? makeEditableDraft(item)

              return (
                <motion.div
                  key={item.id}
                  layout
                  className="overflow-hidden rounded-[2rem] border border-gray-200 bg-white shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => toggleExpanded(item)}
                    className="w-full px-6 py-5 text-left"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                            {item.itemNumber}
                          </span>
                          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                            {item.discipline}
                          </span>
                          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                            {item.companyName}
                          </span>
                        </div>

                        <h4 className="mt-3 text-lg font-semibold text-gray-900">
                          {item.name}
                        </h4>
                        <p className="mt-1 text-sm text-gray-500">
                          {item.shortDescription || 'No short description'}
                        </p>
                      </div>

                      <div className="text-right">
                        <div className="text-xs text-gray-400">{item.category}</div>
                        <div className="mt-2 text-sm text-gray-500">
                          {expanded ? 'Hide details' : 'View details'}
                        </div>
                      </div>
                    </div>
                  </button>

                  <AnimatePresence>
                    {expanded ? (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.22 }}
                        className="border-t border-gray-100"
                      >
                        <div className="space-y-6 px-6 py-6">
                          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                            <InputField
                              label="Line Item Name"
                              value={editDraft.name}
                              onChange={(value) => updateEditingDraft(item.id, 'name', value)}
                            />
                            <InputField
                              label="Pricing Input"
                              value={editDraft.estimatedFirstCost}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'estimatedFirstCost', value)
                              }
                              placeholder="$250,000"
                            />
                          </div>

                          <TextAreaField
                            label="Short Description"
                            value={editDraft.shortDescription}
                            onChange={(value) =>
                              updateEditingDraft(item.id, 'shortDescription', value)
                            }
                            rows={4}
                          />

                          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                            <SelectField
                              label="Category"
                              value={editDraft.category}
                              options={CATEGORY_OPTIONS}
                              onChange={(value) => updateEditingDraft(item.id, 'category', value)}
                            />
                            <SelectField
                              label="Timeline"
                              value={editDraft.timelinePriority}
                              options={PRIORITY_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'timelinePriority', value)
                              }
                            />
                            <SelectField
                              label="Area"
                              value={editDraft.buildingAreaImpacted}
                              options={BUILDING_AREA_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'buildingAreaImpacted', value)
                              }
                            />
                            <SelectField
                              label="Level"
                              value={editDraft.buildingLevelImpacted}
                              options={BUILDING_LEVEL_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'buildingLevelImpacted', value)
                              }
                            />
                            <SelectField
                              label="Operational Impact"
                              value={editDraft.operationalImpact}
                              options={RELATIVE_IMPACT_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'operationalImpact', value)
                              }
                            />
                            <SelectField
                              label="Benefit to Users"
                              value={editDraft.benefitToUsers}
                              options={RELATIVE_IMPACT_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'benefitToUsers', value)
                              }
                            />
                            <SelectField
                              label="Benefit to Public"
                              value={editDraft.benefitToPublic}
                              options={RELATIVE_IMPACT_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'benefitToPublic', value)
                              }
                            />
                            <SelectField
                              label="Relative First Cost"
                              value={editDraft.relativeFirstCost}
                              options={FIRST_COST_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'relativeFirstCost', value)
                              }
                            />
                            <SelectField
                              label="Op Cost Impact"
                              value={editDraft.relativeOperationCostImpact}
                              options={OPERATION_COST_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'relativeOperationCostImpact', value)
                              }
                            />
                            <SelectField
                              label="Energy / Emissions"
                              value={editDraft.relativeOperationalEnergyUsage}
                              options={ENERGY_USAGE_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'relativeOperationalEnergyUsage', value)
                              }
                            />
                            <InputField
                              label="Energy saved / year"
                              value={
                                editDraft.annualEnergySavings === 0
                                  ? ''
                                  : String(editDraft.annualEnergySavings)
                              }
                              onChange={(value) =>
                                updateEditingDraft(
                                  item.id,
                                  'annualEnergySavings',
                                  Number(value) || 0
                                )
                              }
                            />
                            <InputField
                              label="Utility $ saved / year"
                              value={
                                editDraft.annualCostSavings === 0
                                  ? ''
                                  : String(editDraft.annualCostSavings)
                              }
                              onChange={(value) =>
                                updateEditingDraft(
                                  item.id,
                                  'annualCostSavings',
                                  Number(value) || 0
                                )
                              }
                            />
                            <SelectField
                              label="Electrification / EO 594"
                              value={editDraft.electrificationEO594}
                              options={RELATIVE_IMPACT_OPTIONS}
                              onChange={(value) =>
                                updateEditingDraft(item.id, 'electrificationEO594', value)
                              }
                            />
                          </div>

                          <div className="rounded-[1.75rem] bg-gray-50 p-5">
                            <p className="text-sm font-medium text-gray-700">Strategic Flags</p>
                            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                              {FLAG_FIELDS.map((field) => (
                                <CheckboxCard
                                  key={field.key}
                                  label={field.label}
                                  checked={editDraft[field.key] === 'Yes'}
                                  onChange={(checked) =>
                                    updateEditingFlag(item.id, field.key, checked)
                                  }
                                />
                              ))}
                            </div>
                          </div>

                          <div className="rounded-[1.75rem] bg-gray-50 p-5">
                            <p className="text-sm font-medium text-gray-700">
                              Potential Synergies
                            </p>
                            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                              {synergyOptions.length > 0 ? (
                                synergyOptions.map((type) => (
                                  <CheckboxCard
                                    key={type}
                                    label={type}
                                    checked={editDraft.potentialSynergies.includes(type)}
                                    onChange={() => toggleEditSynergy(item.id, type)}
                                  />
                                ))
                              ) : (
                                <span className="text-sm text-gray-400">
                                  No other disciplines available on this project.
                                </span>
                              )}
                            </div>
                          </div>

                          <TextAreaField
                            label="Supporting Notes"
                            value={editDraft.supportingNotes}
                            onChange={(value) =>
                              updateEditingDraft(item.id, 'supportingNotes', value)
                            }
                            rows={6}
                          />

                          <div className="flex flex-wrap justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => handleDelete(item.id)}
                              disabled={pendingDeleteId === item.id}
                              className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {pendingDeleteId === item.id ? 'Deleting…' : 'Delete Line Item'}
                            </button>

                            <div className="flex flex-wrap gap-3">
                              <button
                                type="button"
                                onClick={() => resetEditingDraft(item)}
                                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700"
                              >
                                Reset
                              </button>
                              <button
                                type="button"
                                onClick={() => saveEditedLineItem(item.id)}
                                disabled={savingEditId === item.id}
                                className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {savingEditId === item.id ? 'Saving…' : 'Save Changes'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.div>
              )
            })}
          </div>
        )}
      </div>

      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {isCreating ? (
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
                      transition={{ duration: 0.25 }}
                      className="relative max-h-[88vh] w-full max-w-4xl overflow-hidden rounded-[2.25rem] bg-white shadow-2xl"
                    >
                      <div className="h-2 w-full bg-gray-100">
                        <motion.div
                          className="h-full rounded-r-full bg-black"
                          animate={{ width: `${progress}%` }}
                          transition={{ duration: 0.28 }}
                        />
                      </div>

                      <div className="flex max-h-[calc(88vh-8px)] flex-col">
                  <div className="flex items-center justify-between px-8 py-6">
                    <div>
                      <p className="text-sm text-gray-500">New Line Item</p>
                      <h3 className="text-xl font-semibold text-gray-900">
                        Step {step + 1} of {totalSteps}
                      </h3>
                    </div>

                    <button
                      type="button"
                      onClick={closeCreateFlow}
                      className="rounded-full border border-gray-300 px-4 py-2 text-sm text-gray-700 transition hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto px-8 py-4">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={step}
                        initial={{ opacity: 0, x: 18 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -18 }}
                        transition={{ duration: 0.22 }}
                        className="mx-auto flex h-full max-w-3xl flex-col justify-center"
                      >
                        {step === 0 && (
                          <>
                            <h4 className="text-4xl font-semibold text-gray-900">
                              What is this item?
                            </h4>
                            <p className="mt-3 text-base text-gray-500">
                              Start with a clear title and short description.
                            </p>

                            <div className="mt-8 space-y-5">
                              <div>
                                <label
                                  htmlFor="line-item-name"
                                  className="mb-2 block text-sm font-medium text-gray-700"
                                >
                                  Name
                                </label>
                                <input
                                  id="line-item-name"
                                  value={draft.name}
                                  onChange={(e) =>
                                    setDraft((prev) => ({ ...prev, name: e.target.value }))
                                  }
                                  placeholder="Enter line item name"
                                  className="w-full rounded-3xl border border-gray-200 px-5 py-5 text-lg outline-none transition focus:border-black"
                                />
                              </div>

                              <div>
                                <label
                                  htmlFor="line-item-description"
                                  className="mb-2 block text-sm font-medium text-gray-700"
                                >
                                  Short Description
                                </label>
                                <textarea
                                  id="line-item-description"
                                  value={draft.shortDescription}
                                  onChange={(e) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      shortDescription: e.target.value,
                                    }))
                                  }
                                  placeholder="Briefly describe the item"
                                  rows={5}
                                  className="w-full rounded-3xl border border-gray-200 px-5 py-5 text-base outline-none transition focus:border-black"
                                />
                              </div>
                            </div>
                          </>
                        )}

                        {step === 1 && (
                          <>
                            <h4 className="text-4xl font-semibold text-gray-900">
                              Category and timeline
                            </h4>
                            <div className="mt-8 space-y-8">
                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">Category</p>
                                <ChoicePills
                                  options={CATEGORY_OPTIONS}
                                  value={draft.category}
                                  onChange={(value) =>
                                    setDraft((prev) => ({ ...prev, category: value }))
                                  }
                                />
                              </div>

                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Timeline Priority
                                </p>
                                <ChoicePills
                                  options={PRIORITY_OPTIONS}
                                  value={draft.timelinePriority}
                                  onChange={(value) =>
                                    setDraft((prev) => ({ ...prev, timelinePriority: value }))
                                  }
                                />
                              </div>
                            </div>
                          </>
                        )}

                        {step === 2 && (
                          <>
                            <h4 className="text-4xl font-semibold text-gray-900">
                              Where is it impacted?
                            </h4>
                            <div className="mt-8 space-y-8">
                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Building Area Impacted
                                </p>
                                <ChoicePills
                                  options={BUILDING_AREA_OPTIONS}
                                  value={draft.buildingAreaImpacted}
                                  onChange={(value) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      buildingAreaImpacted: value,
                                    }))
                                  }
                                />
                              </div>

                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Building Level Impacted
                                </p>
                                <ChoicePills
                                  options={BUILDING_LEVEL_OPTIONS}
                                  value={draft.buildingLevelImpacted}
                                  onChange={(value) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      buildingLevelImpacted: value,
                                    }))
                                  }
                                />
                              </div>
                            </div>
                          </>
                        )}

                        {step === 3 && (
                          <>
                            <h4 className="text-4xl font-semibold text-gray-900">
                              Operational and user impact
                            </h4>
                            <div className="mt-8 space-y-8">
                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Relative Operational Impact on Building
                                </p>
                                <ChoicePills
                                  options={RELATIVE_IMPACT_OPTIONS}
                                  value={draft.operationalImpact}
                                  onChange={(value) =>
                                    setDraft((prev) => ({ ...prev, operationalImpact: value }))
                                  }
                                />
                              </div>

                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Relative Benefit to Users
                                </p>
                                <ChoicePills
                                  options={RELATIVE_IMPACT_OPTIONS}
                                  value={draft.benefitToUsers}
                                  onChange={(value) =>
                                    setDraft((prev) => ({ ...prev, benefitToUsers: value }))
                                  }
                                />
                              </div>

                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Relative Benefit to Public
                                </p>
                                <ChoicePills
                                  options={RELATIVE_IMPACT_OPTIONS}
                                  value={draft.benefitToPublic}
                                  onChange={(value) =>
                                    setDraft((prev) => ({ ...prev, benefitToPublic: value }))
                                  }
                                />
                              </div>
                            </div>
                          </>
                        )}

                        {step === 4 && (
                          <>
                            <h4 className="text-4xl font-semibold text-gray-900">
                              Cost and energy
                            </h4>
                            <div className="mt-8 space-y-8">
                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Relative First Cost
                                </p>
                                <ChoicePills
                                  options={FIRST_COST_OPTIONS}
                                  value={draft.relativeFirstCost}
                                  onChange={(value) =>
                                    setDraft((prev) => ({ ...prev, relativeFirstCost: value }))
                                  }
                                />
                              </div>

                              <InputField
                                label="Pricing Input"
                                value={draft.estimatedFirstCost}
                                onChange={(value) =>
                                  setDraft((prev) => ({ ...prev, estimatedFirstCost: value }))
                                }
                                placeholder="$250,000"
                              />

                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Relative Operation Cost Impact
                                </p>
                                <ChoicePills
                                  options={OPERATION_COST_OPTIONS}
                                  value={draft.relativeOperationCostImpact}
                                  onChange={(value) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      relativeOperationCostImpact: value,
                                    }))
                                  }
                                />
                              </div>

                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Relative Operational Energy Usage / Emissions
                                </p>
                                <ChoicePills
                                  options={ENERGY_USAGE_OPTIONS}
                                  value={draft.relativeOperationalEnergyUsage}
                                  onChange={(value) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      relativeOperationalEnergyUsage: value,
                                    }))
                                  }
                                />
                              </div>

                              {/* The qualitative pills above stay — they are
                                  what a consultant can answer on day one. These
                                  are what the energy engineers deliver later,
                                  and what the Timeline's reduction chart is
                                  actually built from. Blank is a legitimate
                                  answer and means "not quantified yet", which
                                  is why nothing here is required. */}
                              <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
                                <p className="text-sm font-medium text-gray-700">
                                  Quantified annual savings
                                </p>
                                <p className="mt-1 text-xs text-gray-500">
                                  Leave blank until an engineer supplies a figure. Units are
                                  set per project on the Cost Model tab.
                                </p>

                                <div className="mt-3 grid gap-4 md:grid-cols-2">
                                  <InputField
                                    label="Energy saved / year"
                                    value={
                                      draft.annualEnergySavings === 0
                                        ? ''
                                        : String(draft.annualEnergySavings)
                                    }
                                    onChange={(value) =>
                                      setDraft((prev) => ({
                                        ...prev,
                                        annualEnergySavings: Number(value) || 0,
                                      }))
                                    }
                                    placeholder="e.g. 430000"
                                  />
                                  <InputField
                                    label="Utility cost saved / year ($)"
                                    value={
                                      draft.annualCostSavings === 0
                                        ? ''
                                        : String(draft.annualCostSavings)
                                    }
                                    onChange={(value) =>
                                      setDraft((prev) => ({
                                        ...prev,
                                        annualCostSavings: Number(value) || 0,
                                      }))
                                    }
                                    placeholder="e.g. 61000"
                                  />
                                </div>

                                <div className="mt-4">
                                  <TextAreaField
                                    label="Where did this number come from?"
                                    rows={3}
                                    value={draft.energyNotes}
                                    onChange={(value) =>
                                      setDraft((prev) => ({ ...prev, energyNotes: value }))
                                    }
                                    placeholder="Model, audit level, assumptions — an energy figure with no provenance is not usable in a deliverable six months later."
                                  />
                                </div>
                              </div>

                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Electrification / EO 594
                                </p>
                                <ChoicePills
                                  options={RELATIVE_IMPACT_OPTIONS}
                                  value={draft.electrificationEO594}
                                  onChange={(value) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      electrificationEO594: value,
                                    }))
                                  }
                                />
                              </div>
                            </div>
                          </>
                        )}

                        {step === 5 && (
                          <>
                            <h4 className="text-4xl font-semibold text-gray-900">
                              Strategic flags
                            </h4>
                            <div className="mt-8 grid gap-4 md:grid-cols-2">
                              {FLAG_FIELDS.map((field) => (
                                <CheckboxCard
                                  key={field.key}
                                  label={field.label}
                                  checked={draft[field.key] === 'Yes'}
                                  onChange={(checked) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      [field.key]: checked ? 'Yes' : 'No',
                                    }))
                                  }
                                />
                              ))}
                            </div>
                          </>
                        )}

                        {step === 6 && (
                          <>
                            <h4 className="text-4xl font-semibold text-gray-900">
                              Synergies and notes
                            </h4>

                            <div className="mt-8 space-y-8">
                              <div>
                                <p className="mb-3 text-sm font-medium text-gray-700">
                                  Potential Synergies
                                </p>
                                <div className="grid gap-3 md:grid-cols-2">
                                  {synergyOptions.map((type) => {
                                    return (
                                      <CheckboxCard
                                        key={type}
                                        label={type}
                                        checked={draft.potentialSynergies.includes(type)}
                                        onChange={() => toggleSynergy(type)}
                                      />
                                    )
                                  })}
                                </div>
                              </div>

                              <div>
                                <label
                                  htmlFor="supporting-notes"
                                  className="mb-3 block text-sm font-medium text-gray-700"
                                >
                                  Supporting Notes / Additional Info
                                </label>
                                <textarea
                                  id="supporting-notes"
                                  value={draft.supportingNotes}
                                  onChange={(e) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      supportingNotes: e.target.value,
                                    }))
                                  }
                                  placeholder="Add assumptions, scope notes, dependencies, or any extra context"
                                  rows={8}
                                  className="w-full rounded-3xl border border-gray-200 px-5 py-5 text-base outline-none transition focus:border-black"
                                />
                              </div>
                            </div>
                          </>
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>

                  {actionError && isCreating ? (
                    <div className="mx-8 mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {actionError}
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between border-t border-gray-100 px-8 py-6">
                    <button
                      type="button"
                      onClick={goBack}
                      disabled={step === 0}
                      className="rounded-2xl border border-gray-300 bg-white px-5 py-3 text-sm font-medium text-gray-700 disabled:opacity-40"
                    >
                      Back
                    </button>

                    {step < totalSteps - 1 ? (
                      <button
                        type="button"
                        onClick={goNext}
                        className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg"
                      >
                        Next
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={saveLineItem}
                        disabled={isSavingNew}
                        className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSavingNew ? 'Saving…' : 'Save Line Item'}
                      </button>
                    )}
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
    </>
  )
}

function InputField({
  label,
  value,
  onChange,
  id,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  id?: string
  placeholder?: string
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
      />
    </div>
  )
}

function TextAreaField({
  label,
  value,
  onChange,
  rows,
  id,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows: number
  id?: string
  placeholder?: string
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-gray-700">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
      />
    </div>
  )
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: T[]
  onChange: (value: T) => void
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  )
}

function CheckboxCard({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-black focus:ring-black"
      />
    </label>
  )
}
