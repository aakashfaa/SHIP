'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  createLineItem,
  deleteLineItem,
  fieldOptions,
  getFormFieldsForProject,
  getLineItemsForProjectUser,
  updateLineItem,
  visibleFormFields,
} from '@/lib/store'
import { useAsyncData } from '@/lib/useAsyncData'
import type { ProjectPermissions } from '@/lib/project-role'
import {
  ConsultantType,
  FormField,
  LineItem,
  Project,
  SafeUser,
} from '@/lib/types'

type Props = {
  project: Project
  user: SafeUser
  /** Resolved once by the shell (ProjectDashboardShell) so this tab does not
   *  re-issue the role RPC just to pick a default discipline. */
  permissions: ProjectPermissions
}

/*
 * migration 0012 turned the line-item form into data: `form_fields` /
 * `form_field_options`, read here via `getFormFieldsForProject`. There is no
 * hardcoded field list left in this file on purpose -- a firm that wants an
 * eighth wizard step, or a third fewer, gets it by editing Settings, not by
 * someone editing this component. See lib/store.ts and the header of
 * supabase/migrations/0012_ship_form_builder.sql for the full model.
 */

/**
 * `key` on a `storage: 'column'` field IS the line_items column name
 * (snake_case); `lib/mappers.ts` already maps every one of those onto a
 * camelCase LineItem property, and this is the client-side mirror of that
 * same mapping. Every built-in follows the mechanical rule except one:
 * `electrification_eo594` -> `electrificationEO594` keeps its capital "EO"
 * (see the comment at the top of lib/mappers.ts), so it is special-cased
 * rather than making the mechanical rule guess acronyms.
 */
const CAMEL_CASE_OVERRIDES: Record<string, string> = {
  electrification_eo594: 'electrificationEO594',
}

function toCamelCase(key: string): string {
  return CAMEL_CASE_OVERRIDES[key] ?? key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/**
 * The one pair of helpers that hides `storage: 'column'` vs `'custom'` from
 * every place that renders or edits a field. A `'column'` field reads/writes
 * `draft[camelCase(field.key)]`; a `'custom'` field reads/writes
 * `draft.customFields[field.key]`. Nothing else in this file should reach
 * into either shape directly.
 */
function getFieldValue(draft: DraftLineItem, field: FormField): unknown {
  if (field.storage === 'custom') return draft.customFields?.[field.key]
  return (draft as unknown as Record<string, unknown>)[toCamelCase(field.key)]
}

function setFieldValue(draft: DraftLineItem, field: FormField, value: unknown): DraftLineItem {
  if (field.storage === 'custom') {
    return { ...draft, customFields: { ...(draft.customFields ?? {}), [field.key]: value } }
  }
  return { ...draft, [toCamelCase(field.key)]: value } as DraftLineItem
}

/**
 * `eccAmount` is omitted alongside the server-assigned fields because it is
 * derived, not entered: a trigger recomputes it from `estimatedFirstCost` on
 * every write (migration 0006). Putting it in an editable draft would offer the
 * user a field whose value is silently discarded.
 *
 * The dozen fields below are widened from LineItem's literal unions
 * (RelativeImpact, BooleanChoice, ...) to plain `string` / `string[]`.
 * Those unions describe the DEFAULT vocabulary that migration 0012 seeded
 * into `form_field_options` -- the database still enforces them via the
 * same CHECK constraints that seeded the options (see
 * default_form_field_options() in 0012) -- but the value flowing through
 * this component at runtime is just a string picked out of
 * `fieldOptions(field)`, and TypeScript has no way to know it happens to be
 * one of four or five literals. Widening here is what lets one get/set pair
 * serve every field without a switch on which property it touches; the
 * server-side constraint is still the thing actually guaranteeing validity.
 */
type DraftLineItem = Omit<
  LineItem,
  | 'id'
  | 'createdAt'
  | 'companyName'
  | 'discipline'
  | 'itemNumber'
  | 'eccAmount'
  | 'operationalImpact'
  | 'benefitToUsers'
  | 'benefitToPublic'
  | 'relativeFirstCost'
  | 'relativeOperationCostImpact'
  | 'relativeOperationalEnergyUsage'
  | 'electrificationEO594'
  | 'addressingResiliencySustainability'
  | 'addressingDeferredMaintenance'
  | 'codeLifeSafetyImprovement'
  | 'accessibilityImprovement'
  | 'historicImpact'
  | 'potentialSynergies'
> & {
  operationalImpact: string
  benefitToUsers: string
  benefitToPublic: string
  relativeFirstCost: string
  relativeOperationCostImpact: string
  relativeOperationalEnergyUsage: string
  electrificationEO594: string
  addressingResiliencySustainability: string
  addressingDeferredMaintenance: string
  codeLifeSafetyImprovement: string
  accessibilityImprovement: string
  historicImpact: string
  potentialSynergies: string[]
}

/** Narrows the widened draft back to LineItem's exact shape at the API
 *  boundary -- the DB's CHECK constraints and the 0012 validation trigger
 *  are what actually enforce these values are legal, same as they always
 *  were; this cast only tells TypeScript what the server already checks. */
function draftForCreate(
  draft: DraftLineItem
): Omit<LineItem, 'id' | 'createdAt' | 'companyName' | 'discipline' | 'itemNumber' | 'eccAmount'> {
  return draft as unknown as Omit<
    LineItem,
    'id' | 'createdAt' | 'companyName' | 'discipline' | 'itemNumber' | 'eccAmount'
  >
}

function draftForUpdate(draft: DraftLineItem): Partial<LineItem> {
  return draft as unknown as Partial<LineItem>
}

/** Every DraftLineItem property a FormField might set, defaulted to a value
 *  that is always legal even before the project's own field list has
 *  loaded -- see `makeInitialDraft`, which overlays the real per-field
 *  defaults on top of this the moment `fields` is available. */
const BASE_FIELD_DEFAULTS: Omit<DraftLineItem, 'projectId' | 'userEmail' | 'consultantType'> = {
  name: '',
  shortDescription: '',
  category: '',
  timelinePriority: '',
  buildingAreaImpacted: '',
  buildingLevelImpacted: '',
  operationalImpact: '',
  benefitToUsers: '',
  benefitToPublic: '',
  relativeFirstCost: '',
  estimatedFirstCost: '',
  relativeOperationCostImpact: '',
  relativeOperationalEnergyUsage: '',
  electrificationEO594: '',
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
  customFields: {},
}

/** The value a field starts a brand-new line item with. For a `select` this
 *  is its first live option (so a taxonomy-backed field like `category`
 *  defaults to whatever this project's own vocabulary puts first, not a
 *  literal this component would have to know) rather than a hardcoded
 *  literal. */
function defaultValueForField(field: FormField): unknown {
  switch (field.inputType) {
    case 'boolean':
      return field.storage === 'column' ? 'No' : false
    case 'multiselect':
      return []
    case 'number':
      return 0
    case 'select':
      return fieldOptions(field)[0] ?? ''
    default:
      return ''
  }
}

/**
 * Migration 0009 moved authority from the global `profiles.role` boolean to
 * a per-project role, and this default is exactly the case that migration
 * exists to fix: reading `user.role === 'admin'` gets it backwards for two
 * real people on this project -- a PLATFORM admin with no consultant
 * assignment here used to be forced into 'Architecture' regardless of what
 * they actually do on this job, while a PROJECT admin who happens not to be
 * a platform admin used to fall through to the email lookup and get
 * whatever discipline they were hired under, or 'Architecture' if none
 * matched. `permissions.isAdmin` is this project's own answer to "is this
 * person in charge here", which is the question a default on THIS project's
 * form should be asking.
 */
function getUserConsultantType(
  project: Project,
  user: SafeUser,
  permissions: ProjectPermissions
): ConsultantType {
  if (permissions.isAdmin) return 'Architecture'

  const matchedConsultant = project.consultants.find((consultant) =>
    consultant.emails.includes(user.email)
  )

  return matchedConsultant?.type ?? 'Architecture'
}

function makeInitialDraft(
  project: Project,
  user: SafeUser,
  permissions: ProjectPermissions,
  fields: FormField[]
): DraftLineItem {
  const base: DraftLineItem = {
    projectId: project.id,
    userEmail: user.email,
    consultantType: getUserConsultantType(project, user, permissions),
    ...BASE_FIELD_DEFAULTS,
  }

  // Every field, not just the visible ones: a hidden built-in (e.g. a firm
  // that hides `electrification_eo594`) still backs a real, NOT NULL /
  // CHECK-constrained column that this draft has to carry a legal value for.
  return fields.reduce(
    (draft, field) => setFieldValue(draft, field, defaultValueForField(field)),
    base
  )
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
    customFields: item.customFields ?? {},
  }
}

/** A wizard step / inline-edit section: one `groupLabel`'s fields, in
 *  sort order. Built by grouping `visibleFormFields(fields)` on first
 *  appearance, so the step order always matches field sort order and a firm
 *  gets exactly as many steps as it has distinct group labels. */
type FormStep = { label: string; fields: FormField[] }

function groupIntoSteps(fields: FormField[]): FormStep[] {
  const steps: FormStep[] = []
  const indexByLabel = new Map<string, number>()

  for (const field of fields) {
    const label = field.groupLabel.trim() || 'Other'
    let index = indexByLabel.get(label)
    if (index === undefined) {
      index = steps.length
      indexByLabel.set(label, index)
      steps.push({ label, fields: [] })
    }
    steps[index].fields.push(field)
  }

  return steps
}

function isFieldValueEmpty(field: FormField, value: unknown): boolean {
  if (field.inputType === 'multiselect') return !Array.isArray(value) || value.length === 0
  if (field.inputType === 'boolean') return value === undefined || value === null || value === ''
  if (field.inputType === 'number') return value === undefined || value === null || value === ''
  return typeof value !== 'string' || value.trim() === ''
}

function findMissingRequired(
  fields: FormField[],
  getValue: (field: FormField) => unknown
): FormField[] {
  return fields.filter((field) => field.isRequired && isFieldValueEmpty(field, getValue(field)))
}

function requiredMessage(missing: FormField[]): string {
  const names = missing.map((field) => field.label).join(', ')
  return missing.length === 1 ? `"${names}" is required.` : `${names} are required.`
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

/**
 * Renders one field by `inputType`, for either surface (`variant`). Handles
 * every input type except `boolean` and `multiselect` -- those two need a
 * set of choices rendered together (all the flags in one grid, all the
 * synergy checkboxes in one grid), which `LineItemFields` below does at the
 * group level instead of per-field.
 */
function FormFieldControl({
  field,
  value,
  onChange,
  variant,
}: {
  field: FormField
  value: unknown
  onChange: (value: unknown) => void
  variant: 'wizard' | 'inline'
}) {
  const stringValue = typeof value === 'string' ? value : value == null ? '' : String(value)

  switch (field.inputType) {
    case 'text':
      return (
        <InputField label={field.label} value={stringValue} onChange={onChange} helpText={field.helpText} />
      )

    case 'textarea':
      return (
        <TextAreaField
          label={field.label}
          value={stringValue}
          onChange={onChange}
          rows={variant === 'wizard' ? 6 : 4}
          helpText={field.helpText}
        />
      )

    case 'currency':
      // Free text on purpose: estimated_first_cost's "1.2m" / "850k"
      // shorthand is parsed downstream (lib/cost-model.ts), never here.
      return (
        <InputField
          label={field.label}
          value={stringValue}
          onChange={onChange}
          placeholder="1.2m, 850k, $2,400,000"
          helpText={field.helpText}
        />
      )

    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(value) || 0
      return (
        <InputField
          label={field.label}
          value={numeric === 0 ? '' : String(numeric)}
          onChange={(next) => onChange(Number(next) || 0)}
          helpText={field.helpText}
        />
      )
    }

    case 'date':
      return (
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{field.label}</label>
          <input
            type="date"
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-black"
          />
          {field.helpText ? <p className="mt-1 text-xs text-gray-500">{field.helpText}</p> : null}
        </div>
      )

    case 'select': {
      // `current` deliberately included: an already-archived value the
      // record holds must still show up as a choice. See fieldOptions.
      const options = fieldOptions(field, stringValue)

      if (variant === 'wizard') {
        return (
          <div>
            <p className="mb-3 text-sm font-medium text-gray-700">{field.label}</p>
            <ChoicePills options={options} value={stringValue} onChange={onChange} />
            {field.helpText ? <p className="mt-2 text-xs text-gray-500">{field.helpText}</p> : null}
          </div>
        )
      }

      return (
        <div>
          <SelectField label={field.label} value={stringValue} options={options} onChange={onChange} />
          {field.helpText ? <p className="mt-1 text-xs text-gray-500">{field.helpText}</p> : null}
        </div>
      )
    }

    default:
      return null
  }
}

/**
 * Renders one group's worth of fields for either surface: the non-choice
 * fields in a layout that differs by variant (stacked for the wizard,
 * a compact grid for inline edit), then every `boolean` field together in
 * one checkbox grid, then every `multiselect` field in its own checkbox
 * grid. `potential_synergies` is special-cased to the project's actual
 * consultants (minus the current user's own discipline) rather than
 * `fieldOptions`, matching the behaviour this replaces -- that set has never
 * come from the field's seeded option list, which is every consultant type
 * unconditionally; it comes from who is actually on this project.
 */
function LineItemFields({
  fields,
  getValue,
  onChange,
  variant,
  synergyOptions,
}: {
  fields: FormField[]
  getValue: (field: FormField) => unknown
  onChange: (field: FormField, value: unknown) => void
  variant: 'wizard' | 'inline'
  synergyOptions: string[]
}) {
  const gridFields = fields.filter((f) => f.inputType !== 'boolean' && f.inputType !== 'multiselect')
  const booleanFields = fields.filter((f) => f.inputType === 'boolean')
  const multiselectFields = fields.filter((f) => f.inputType === 'multiselect')

  return (
    <>
      {gridFields.length > 0 ? (
        <div className={variant === 'inline' ? 'grid gap-4 md:grid-cols-2 xl:grid-cols-3' : 'space-y-8'}>
          {gridFields.map((field) => (
            <FormFieldControl
              key={field.id}
              field={field}
              value={getValue(field)}
              onChange={(value) => onChange(field, value)}
              variant={variant}
            />
          ))}
        </div>
      ) : null}

      {booleanFields.length > 0 ? (
        <div className="rounded-[1.75rem] bg-gray-50 p-5">
          <p className="text-sm font-medium text-gray-700">{booleanFields[0].groupLabel || 'Flags'}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {booleanFields.map((field) => {
              const checked = getValue(field) === true || getValue(field) === 'Yes'
              return (
                <div key={field.id}>
                  <CheckboxCard
                    label={field.label}
                    checked={checked}
                    onChange={(next) =>
                      onChange(field, field.storage === 'column' ? (next ? 'Yes' : 'No') : next)
                    }
                  />
                  {field.helpText ? (
                    <p className="mt-1 px-1 text-xs text-gray-500">{field.helpText}</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {multiselectFields.map((field) => {
        const options = field.key === 'potential_synergies' ? synergyOptions : fieldOptions(field)
        const selected = Array.isArray(getValue(field)) ? (getValue(field) as string[]) : []

        return (
          <div key={field.id} className="rounded-[1.75rem] bg-gray-50 p-5">
            <p className="text-sm font-medium text-gray-700">{field.label}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {options.length > 0 ? (
                options.map((option) => (
                  <CheckboxCard
                    key={option}
                    label={option}
                    checked={selected.includes(option)}
                    onChange={() =>
                      onChange(
                        field,
                        selected.includes(option)
                          ? selected.filter((v) => v !== option)
                          : [...selected, option]
                      )
                    }
                  />
                ))
              ) : (
                <span className="text-sm text-gray-400">
                  No other disciplines available on this project.
                </span>
              )}
            </div>
            {field.helpText ? <p className="mt-2 text-xs text-gray-500">{field.helpText}</p> : null}
          </div>
        )
      })}
    </>
  )
}

export default function AddDataTab({ project, user, permissions }: Props) {
  /**
   * The project's own line-item form (migration 0012). Loaded here rather
   * than passed in because this is the only tab that writes line items, so
   * it is the only tab that needs it. Hidden fields ARE included -- see
   * `makeInitialDraft`, which needs them to seed a legal value into every
   * column-backed field regardless of whether it is shown.
   */
  const { data: fields, loading: fieldsLoading } = useAsyncData<FormField[]>(
    () => getFormFieldsForProject(project.id),
    [project.id],
    []
  )

  const visibleFields = useMemo(() => visibleFormFields(fields), [fields])
  const steps = useMemo(() => groupIntoSteps(visibleFields), [visibleFields])

  // Empty rather than crashing: an unseeded project (getFormFieldsForProject
  // returned nothing) has no questions to ask, and the right response is
  // pointing at Settings, not falling back to some other firm's vocabulary.
  const formNotSeeded = !fieldsLoading && visibleFields.length === 0

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
  const [draft, setDraft] = useState<DraftLineItem>(() =>
    makeInitialDraft(project, user, permissions, [])
  )
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

  const consultantType = getUserConsultantType(project, user, permissions)

  const synergyOptions = useMemo(() => {
    return project.consultants
      .map((consultant) => consultant.type)
      .filter((type) => type !== consultantType)
  }, [consultantType, project.consultants])

  const totalSteps = Math.max(steps.length, 1)
  const progress = ((step + 1) / totalSteps) * 100

  function openCreateFlow() {
    setDraft(makeInitialDraft(project, user, permissions, fields))
    setStep(0)
    setActionError(null)
    setIsCreating(true)
  }

  function closeCreateFlow() {
    setIsCreating(false)
  }

  function goNext() {
    const missing = findMissingRequired(steps[step]?.fields ?? [], (field) =>
      getFieldValue(draft, field)
    )
    if (missing.length > 0) {
      setActionError(requiredMessage(missing))
      return
    }
    setActionError(null)
    if (step < steps.length - 1) setStep((prev) => prev + 1)
  }

  function goBack() {
    if (step > 0) setStep((prev) => prev - 1)
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
    const missing = findMissingRequired(visibleFields, (field) => getFieldValue(draft, field))
    if (missing.length > 0) {
      setActionError(requiredMessage(missing))
      return
    }

    setActionError(null)
    setIsSavingNew(true)
    try {
      const created = await createLineItem(draftForCreate(draft))
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

  function updateEditingField(lineItemId: string, field: FormField, value: unknown) {
    setEditingDrafts((prev) => {
      const current = prev[lineItemId]
      if (!current) return prev

      return {
        ...prev,
        [lineItemId]: setFieldValue(current, field, value),
      }
    })
  }

  function resetEditingDraft(item: LineItem) {
    setEditingDrafts((prev) => ({
      ...prev,
      [item.id]: makeEditableDraft(item),
    }))
  }

  async function saveEditedLineItem(lineItemId: string) {
    const currentDraft = editingDrafts[lineItemId]
    if (!currentDraft) return

    const missing = findMissingRequired(visibleFields, (field) => getFieldValue(currentDraft, field))
    if (missing.length > 0) {
      setActionError(requiredMessage(missing))
      return
    }

    setActionError(null)
    setSavingEditId(lineItemId)
    try {
      const updated = await updateLineItem(lineItemId, draftForUpdate(currentDraft))
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

  const currentStep = steps[step]

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
            disabled={formNotSeeded}
            className="rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add Line Item
          </button>
        </div>

        {formNotSeeded ? (
          <div className="rounded-[1.5rem] border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
            This project has no line-item form yet. Add fields in Settings &rarr; Line item form
            before entering data.
          </div>
        ) : null}

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
                          {visibleFields.length > 0 ? (
                            <LineItemFields
                              fields={visibleFields}
                              getValue={(field) => getFieldValue(editDraft, field)}
                              onChange={(field, value) => updateEditingField(item.id, field, value)}
                              variant="inline"
                              synergyOptions={synergyOptions}
                            />
                          ) : (
                            <p className="text-sm text-gray-400">No form fields configured.</p>
                          )}

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
              {isCreating && currentStep ? (
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
                              <h4 className="text-4xl font-semibold text-gray-900">
                                {currentStep.label}
                              </h4>

                              <div className="mt-8 space-y-8">
                                <LineItemFields
                                  fields={currentStep.fields}
                                  getValue={(field) => getFieldValue(draft, field)}
                                  onChange={(field, value) =>
                                    setDraft((prev) => setFieldValue(prev, field, value))
                                  }
                                  variant="wizard"
                                  synergyOptions={synergyOptions}
                                />
                              </div>
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

                          {step < steps.length - 1 ? (
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
  helpText,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  id?: string
  placeholder?: string
  helpText?: string
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
      {helpText ? <p className="mt-1 text-xs text-gray-500">{helpText}</p> : null}
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
  helpText,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows: number
  id?: string
  placeholder?: string
  helpText?: string
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
      {helpText ? <p className="mt-1 text-xs text-gray-500">{helpText}</p> : null}
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
