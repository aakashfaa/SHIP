/**
 * Tri-state Yes/No (0023) in the shared inline cell editor (Master View, Phasing).
 *
 * Same extensionless-import resolve hook as ws3-export.test.ts.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'

type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown
) => unknown
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: { resolve: ResolveHook }) => void
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

type CellEditModule = typeof import('../../components/project-workspace/master-view/cell-edit.ts')
let cellEdit: CellEditModule
before(async () => {
  cellEdit = await import('../../components/project-workspace/master-view/cell-edit.ts')
})

import type { FormField, LineItem } from '../../lib/types.ts'

function boolField(key: string, extra: Partial<FormField> = {}): FormField {
  return {
    id: `f-${key}`, projectId: 'p', key, label: key, helpText: '', inputType: 'boolean',
    storage: 'column', groupLabel: '', sortOrder: 0, isRequired: false, isHidden: false,
    isBuiltin: true, config: {}, options: [], createdAt: '', ...extra,
  }
}
const COL = boolField('historic_impact')
const CUSTOM = boolField('has_permit', { storage: 'custom', isBuiltin: false })
const REQUIRED = boolField('accessibility_improvement', { isRequired: true })

function item(extra: Partial<LineItem>): LineItem {
  return { id: '1', projectId: 'p', customFields: {}, ...extra } as LineItem
}

describe('cell-edit: Yes/No is tri-state (0023)', () => {
  test('initial value: Yes -> true, No -> false, unanswered -> ""', () => {
    assert.equal(cellEdit.initialCellValue(COL, item({ historicImpact: 'Yes' })), true)
    assert.equal(cellEdit.initialCellValue(COL, item({ historicImpact: 'No' })), false)
    assert.equal(cellEdit.initialCellValue(COL, item({ historicImpact: null as never })), '')
    assert.equal(cellEdit.initialCellValue(CUSTOM, item({ customFields: { has_permit: false } })), false)
    assert.equal(cellEdit.initialCellValue(CUSTOM, item({})), '')
  })

  test('patch: cleared column Yes/No is NULL, answers are Yes/No', () => {
    const row = item({ historicImpact: 'Yes' })
    assert.deepEqual(cellEdit.buildRowPatch(row, [COL], { historic_impact: '' }), { historicImpact: null })
    assert.deepEqual(cellEdit.buildRowPatch(row, [COL], { historic_impact: false }), { historicImpact: 'No' })
  })

  test('patch: cleared custom Yes/No drops the key, others kept', () => {
    const row = item({ customFields: { has_permit: true, other: 'keep' } })
    assert.deepEqual(cellEdit.buildRowPatch(row, [CUSTOM], { has_permit: '' }), {
      customFields: { other: 'keep' },
    })
    assert.deepEqual(cellEdit.buildRowPatch(row, [CUSTOM], { has_permit: false }), {
      customFields: { has_permit: false, other: 'keep' },
    })
  })

  test('a required Yes/No cannot be cleared; No is an answer', () => {
    assert.deepEqual(Object.keys(cellEdit.validateRowDraft([REQUIRED], { accessibility_improvement: '' })), [
      'accessibility_improvement',
    ])
    assert.deepEqual(cellEdit.validateRowDraft([REQUIRED], { accessibility_improvement: false }), {})
  })
})
