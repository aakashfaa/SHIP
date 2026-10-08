'use client'

import { useState } from 'react'
import Modal from '@/components/ui/Modal'
import {
  CONSULTANT_TYPES,
  MAX_DISCIPLINE_LENGTH,
  customDisciplineError,
  isKnownConsultantType,
  normalizeDisciplineName,
} from '@/lib/constants'
import { isPlausibleEmail } from '@/lib/email/links'
import { ConsultantType, ProjectConsultant } from '@/lib/types'

type Props = {
  /** Current roster. */
  consultants: ProjectConsultant[]
  /** Set when editing one existing organization; unset for "Add consultants". */
  editType: ConsultantType | null
  /** Saves the full next roster. Resolves to an error message, or null on success. */
  onSubmit: (next: ProjectConsultant[]) => Promise<string | null>
  onClose: () => void
}

/** Select value that reveals the custom discipline name input. */
const OTHER = '__other__'

type Block = {
  id: number
  type: ConsultantType | typeof OTHER | ''
  /** The typed name when `type` is OTHER. */
  customType: string
  orgName: string
  emails: string[] // one entry per input row; blanks are ignored on save
}

const INPUT =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-black'

let nextId = 1
const newBlock = (): Block => ({ id: nextId++, type: '', customType: '', orgName: '', emails: [''] })

/**
 * Adds consultants (any number of organizations, each with its people) or edits
 * one existing organization. The roster is keyed by discipline, so each block
 * picks one; blocks that land on an existing organization merge into it.
 */
export default function ConsultantsModal({ consultants, editType, onSubmit, onClose }: Props) {
  const [blocks, setBlocks] = useState<Block[]>(() => {
    const existing = editType ? consultants.find((c) => c.type === editType) : null
    return existing
      ? [
          {
            id: nextId++,
            type: existing.type,
            customType: '',
            orgName: existing.orgName,
            emails: [...existing.emails, ''],
          },
        ]
      : [newBlock()]
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  function patch(id: number, change: Partial<Block>) {
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...change } : b)))
  }

  function setEmail(block: Block, index: number, value: string) {
    patch(block.id, { emails: block.emails.map((e, i) => (i === index ? value : e)) })
  }

  async function submit() {
    const nextErrors: Record<string, string> = {}
    // Resolve each block's discipline. A typed ("Other…") name that matches a
    // built-in or a roster discipline case-insensitively becomes that one, so
    // the roster never holds "Acoustics" and "acoustics" side by side.
    const chosen = new Set<string>()
    const resolved = new Map<number, ConsultantType>()
    for (const block of blocks) {
      let type: ConsultantType | '' = block.type === OTHER ? '' : block.type
      if (block.type === OTHER) {
        const name = normalizeDisciplineName(block.customType)
        const shapeError = customDisciplineError(name, [])
        if (shapeError) {
          nextErrors[`${block.id}:type`] = shapeError
          continue
        }
        type = consultants.find((c) => c.type.toLowerCase() === name.toLowerCase())?.type ?? name
      }
      if (!type) continue
      if (chosen.has(type.toLowerCase())) {
        nextErrors[`${block.id}:type`] = `${type} is already chosen above.`
        continue
      }
      chosen.add(type.toLowerCase())
      resolved.set(block.id, type)
    }

    const cleaned = blocks.map((block) => {
      const seen = new Set<string>()
      const emails: string[] = []
      block.emails.forEach((raw, i) => {
        const email = raw.trim().toLowerCase()
        if (!email) return
        // Validate here (M-22): "not-an-email" must never reach the roster,
        // the allowlist or the mailer.
        if (!isPlausibleEmail(email)) {
          nextErrors[`${block.id}:${i}`] = `"${email}" doesn't look like an email address.`
          return
        }
        if (seen.has(email)) return
        seen.add(email)
        emails.push(email)
      })
      if (!block.type) nextErrors[`${block.id}:type`] = 'Choose a discipline.'
      return { block, emails, type: resolved.get(block.id) }
    })
    setErrors(nextErrors)
    setFormError('')
    if (Object.keys(nextErrors).length > 0) return

    const picked = cleaned.filter((c): c is typeof c & { type: ConsultantType } => Boolean(c.type))
    if (!editType && picked.every((c) => c.emails.length === 0 && !c.block.orgName.trim())) {
      setFormError('Add at least one person or organization.')
      return
    }

    let next: ProjectConsultant[] = consultants.map((c) => ({ ...c, emails: [...c.emails] }))
    for (const { block, emails, type } of picked) {
      const orgName = block.orgName.trim()
      if (editType) {
        // Editing replaces the organization wholesale, so people can be removed too.
        next = next.map((c) => (c.type === editType ? { type: c.type, orgName, emails } : c))
        continue
      }
      // The roster holds one organization per discipline, so a discipline that
      // already has one merges into it. A different organization name there is
      // refused rather than silently renaming the existing organization.
      const index = next.findIndex((c) => c.type === type)
      if (index >= 0) {
        const target = next[index]
        const existingName = target.orgName.trim()
        if (orgName && existingName && orgName.toLowerCase() !== existingName.toLowerCase()) {
          nextErrors[`${block.id}:type`] =
            `${type} is already ${existingName}. Edit that organization instead.`
          continue
        }
        next[index] = {
          ...target,
          orgName: existingName || orgName,
          emails: Array.from(new Set([...target.emails, ...emails])),
        }
      } else {
        next.push({ type, orgName, emails })
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }

    setSaving(true)
    const failure = await onSubmit(next)
    setSaving(false)
    if (failure) setFormError(failure)
    else onClose()
  }

  const usedTypes = new Set<string>(blocks.map((b) => b.type))
  // Built-ins first, then any custom disciplines already on the roster.
  const typeOptions: ConsultantType[] = [
    ...CONSULTANT_TYPES,
    ...consultants.map((c) => c.type).filter((t) => !isKnownConsultantType(t)),
  ]

  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!saving}
      size="md"
      title={editType ? 'Edit consultants' : 'Add consultants'}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="rounded-xl bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? 'Saving...' : editType ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {blocks.map((block, blockIndex) => (
          <div key={block.id} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
              <div>
                <label htmlFor={`org-${block.id}`} className="mb-1 block text-xs font-medium text-slate-600">
                  Organization
                </label>
                <input
                  id={`org-${block.id}`}
                  value={block.orgName}
                  onChange={(e) => patch(block.id, { orgName: e.target.value })}
                  placeholder="Organization name"
                  className={INPUT}
                />
              </div>
              <div>
                <label htmlFor={`type-${block.id}`} className="mb-1 block text-xs font-medium text-slate-600">
                  Discipline
                </label>
                <select
                  id={`type-${block.id}`}
                  value={block.type}
                  disabled={Boolean(editType)}
                  onChange={(e) => patch(block.id, { type: e.target.value })}
                  aria-invalid={Boolean(errors[`${block.id}:type`])}
                  className={INPUT}
                >
                  <option value="">Select…</option>
                  {typeOptions.filter((t) => t === block.type || !usedTypes.has(t)).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  {!editType ? <option value={OTHER}>Other…</option> : null}
                </select>
                {block.type === OTHER ? (
                  <input
                    id={`type-other-${block.id}`}
                    value={block.customType}
                    onChange={(e) => patch(block.id, { customType: e.target.value })}
                    maxLength={MAX_DISCIPLINE_LENGTH}
                    aria-label="Discipline name"
                    aria-invalid={Boolean(errors[`${block.id}:type`])}
                    placeholder="Discipline name"
                    autoFocus
                    className={`${INPUT} mt-2`}
                  />
                ) : null}
                {errors[`${block.id}:type`] ? (
                  <p role="alert" className="mt-1 text-xs text-rose-600">
                    {errors[`${block.id}:type`]}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {block.emails.map((email, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(block, i, e.target.value)}
                      aria-label={`Email ${i + 1}`}
                      aria-invalid={Boolean(errors[`${block.id}:${i}`])}
                      placeholder="name@company.com"
                      className={INPUT}
                    />
                    {block.emails.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          patch(block.id, { emails: block.emails.filter((_, j) => j !== i) })
                        }
                        aria-label={`Remove email ${i + 1}`}
                        className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-800"
                      >
                        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                  {errors[`${block.id}:${i}`] ? (
                    <p role="alert" className="mt-1 text-xs text-rose-600">
                      {errors[`${block.id}:${i}`]}
                    </p>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                onClick={() => patch(block.id, { emails: [...block.emails, ''] })}
                aria-label="Add another person"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-600 hover:border-black hover:text-black"
              >
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M10 4v12M4 10h12" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {!editType && blocks.length > 1 ? (
              <button
                type="button"
                onClick={() => setBlocks((prev) => prev.filter((b) => b.id !== block.id))}
                className="mt-3 text-xs font-medium text-slate-500 hover:text-rose-600"
              >
                Remove organization {blockIndex + 1}
              </button>
            ) : null}
          </div>
        ))}

        {!editType ? (
          <button
            type="button"
            onClick={() => setBlocks((prev) => [...prev, newBlock()])}
            className="text-sm font-medium text-slate-700 hover:text-black"
          >
            + Add another organization
          </button>
        ) : null}

        {formError ? (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {formError}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
