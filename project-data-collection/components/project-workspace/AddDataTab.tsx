'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useMemo, useState } from 'react'
import { createLineItem, deleteLineItem, getLineItemsForProjectUser } from '@/lib/store'
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

type DraftLineItem = Omit<
  LineItem,
  'id' | 'createdAt' | 'companyName' | 'discipline' | 'itemNumber'
>

function getUserConsultantType(project: Project, user: SafeUser): ConsultantType | 'Admin' {
  if (user.role === 'admin') return 'Admin'

  const matchedConsultant = project.consultants.find((consultant) =>
    consultant.emails.includes(user.email)
  )

  return matchedConsultant?.type ?? 'Admin'
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

function YesNoPills({
  value,
  onChange,
}: {
  value: 'Yes' | 'No'
  onChange: (value: 'Yes' | 'No') => void
}) {
  return <ChoicePills options={['Yes', 'No']} value={value} onChange={onChange} />
}

export default function AddDataTab({ project, user }: Props) {
  const [lineItems, setLineItems] = useState<LineItem[]>(() =>
    getLineItemsForProjectUser(project.id, user.email)
  )
  const [isCreating, setIsCreating] = useState(false)
  const [step, setStep] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftLineItem>(() => makeInitialDraft(project, user))

  const consultantType = getUserConsultantType(project, user)

  const synergyOptions = useMemo(() => {
    if (consultantType === 'Admin') {
      return project.consultants.map((consultant) => consultant.type)
    }

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

  function handleDelete(id: string) {
    deleteLineItem(id)
    setLineItems(getLineItemsForProjectUser(project.id, user.email))
    if (expandedId === id) setExpandedId(null)
  }

  function saveLineItem() {
    const created = createLineItem(draft, project)
    setLineItems(getLineItemsForProjectUser(project.id, user.email))
    setExpandedId(created.id)
    setIsCreating(false)
  }

  return (
    <>
      <div className="space-y-6">
        <div className="rounded-[2rem] bg-gradient-to-br from-gray-50 to-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-gray-500">Add Data</p>
              <h3 className="mt-1 text-2xl font-semibold text-gray-900">
                Line Items
              </h3>
              <p className="mt-2 max-w-2xl text-sm text-gray-600">
                Build your scoped list one item at a time through a guided intake flow.
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
        </div>

        {lineItems.length === 0 ? (
          <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white p-12 text-center">
            <h4 className="text-lg font-semibold text-gray-900">No line items yet</h4>
            <p className="mt-2 text-sm text-gray-500">
              Start your list with a guided entry.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {lineItems.map((item) => {
              const expanded = expandedId === item.id

              return (
                <motion.div
                  key={item.id}
                  layout
                  className="overflow-hidden rounded-[2rem] border border-gray-200 bg-white shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : item.id)}
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
                        <div className="space-y-5 px-6 py-6">
                          <div className="grid gap-3 md:grid-cols-3">
                            <InfoCard label="Timeline" value={item.timelinePriority} />
                            <InfoCard label="Area" value={item.buildingAreaImpacted} />
                            <InfoCard label="Level" value={item.buildingLevelImpacted} />
                            <InfoCard label="Operational Impact" value={item.operationalImpact} />
                            <InfoCard label="Benefit to Users" value={item.benefitToUsers} />
                            <InfoCard label="Benefit to Public" value={item.benefitToPublic} />
                            <InfoCard label="First Cost" value={item.relativeFirstCost} />
                            <InfoCard
                              label="Op Cost Impact"
                              value={item.relativeOperationCostImpact}
                            />
                            <InfoCard
                              label="Energy / Emissions"
                              value={item.relativeOperationalEnergyUsage}
                            />
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <FlagCard
                              label="Resiliency / Sustainability"
                              value={item.addressingResiliencySustainability}
                            />
                            <FlagCard
                              label="Deferred Maintenance"
                              value={item.addressingDeferredMaintenance}
                            />
                            <FlagCard
                              label="Code / Life Safety"
                              value={item.codeLifeSafetyImprovement}
                            />
                            <FlagCard
                              label="Accessibility"
                              value={item.accessibilityImprovement}
                            />
                            <FlagCard label="Historic Impact" value={item.historicImpact} />
                            <FlagCard
                              label="Electrification / EO 594"
                              value={item.electrificationEO594}
                            />
                          </div>

                          <div className="rounded-3xl bg-gray-50 p-5">
                            <p className="text-sm font-medium text-gray-700">
                              Potential Synergies
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {item.potentialSynergies.length > 0 ? (
                                item.potentialSynergies.map((synergy) => (
                                  <span
                                    key={synergy}
                                    className="rounded-full bg-white px-3 py-2 text-xs text-gray-700"
                                  >
                                    {synergy}
                                  </span>
                                ))
                              ) : (
                                <span className="text-sm text-gray-400">None selected</span>
                              )}
                            </div>
                          </div>

                          <div className="rounded-3xl bg-gray-50 p-5">
                            <p className="text-sm font-medium text-gray-700">
                              Supporting Notes
                            </p>
                            <p className="mt-3 whitespace-pre-wrap text-sm text-gray-600">
                              {item.supportingNotes || 'No additional notes'}
                            </p>
                          </div>

                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={() => handleDelete(item.id)}
                              className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 transition hover:bg-red-100"
                            >
                              Delete Line Item
                            </button>
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

      <AnimatePresence>
        {isCreating ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-md"
          >
            <div className="flex h-full items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.98 }}
                transition={{ duration: 0.25 }}
                className="relative h-[90vh] w-full max-w-5xl overflow-hidden rounded-[2.5rem] bg-white shadow-2xl"
              >
                <div className="h-2 w-full bg-gray-100">
                  <motion.div
                    className="h-full rounded-r-full bg-black"
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.28 }}
                  />
                </div>

                <div className="flex h-[calc(90vh-8px)] flex-col">
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
                            <div className="mt-8 grid gap-8">
                              <FlagQuestion
                                label="Addressing Resiliency / Sustainability"
                                value={draft.addressingResiliencySustainability}
                                onChange={(value) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    addressingResiliencySustainability: value,
                                  }))
                                }
                              />
                              <FlagQuestion
                                label="Addressing Deferred Maintenance"
                                value={draft.addressingDeferredMaintenance}
                                onChange={(value) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    addressingDeferredMaintenance: value,
                                  }))
                                }
                              />
                              <FlagQuestion
                                label="Code / Life Safety Improvement"
                                value={draft.codeLifeSafetyImprovement}
                                onChange={(value) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    codeLifeSafetyImprovement: value,
                                  }))
                                }
                              />
                              <FlagQuestion
                                label="Accessibility Improvement"
                                value={draft.accessibilityImprovement}
                                onChange={(value) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    accessibilityImprovement: value,
                                  }))
                                }
                              />
                              <FlagQuestion
                                label="Historic Impact"
                                value={draft.historicImpact}
                                onChange={(value) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    historicImpact: value,
                                  }))
                                }
                              />
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
                                <div className="flex flex-wrap gap-3">
                                  {synergyOptions.map((type) => {
                                    const active = draft.potentialSynergies.includes(type)

                                    return (
                                      <button
                                        key={type}
                                        type="button"
                                        onClick={() => toggleSynergy(type)}
                                        className={`rounded-full px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                                          active
                                            ? 'bg-black text-white shadow-md'
                                            : 'border border-gray-300 bg-white text-gray-700 hover:border-black'
                                        }`}
                                      >
                                        {type}
                                      </button>
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
                        className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg"
                      >
                        Save Line Item
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-gray-50 px-4 py-4">
      <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-2 text-sm font-medium text-gray-800">{value}</p>
    </div>
  )
}

function FlagCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-gray-50 px-4 py-4">
      <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-2 text-sm font-medium text-gray-800">{value}</p>
    </div>
  )
}

function FlagQuestion({
  label,
  value,
  onChange,
}: {
  label: string
  value: 'Yes' | 'No'
  onChange: (value: 'Yes' | 'No') => void
}) {
  return (
    <div>
      <p className="mb-3 text-sm font-medium text-gray-700">{label}</p>
      <YesNoPills value={value} onChange={onChange} />
    </div>
  )
}