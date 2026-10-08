/**
 * lib/form-values.ts: skipped answers stay skipped. A select that was never
 * answered starts blank (never its first option), is written as NULL for a
 * column / omitted for a custom field, and displays as EMPTY_FIELD_TEXT.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  blankValueForField,
  EMPTY_FIELD_TEXT,
  formatFieldValue,
  isFieldValueEmpty,
  readYesNo,
  storedFieldValue,
  writeYesNo,
} from '../../lib/form-values.ts'
import type { FormField } from '../../lib/types.ts'

function field(overrides: Partial<FormField>): FormField {
  return {
    id: overrides.key ?? 'f',
    projectId: 'p',
    key: 'category',
    label: 'Category',
    helpText: '',
    inputType: 'select',
    storage: 'column',
    groupLabel: '',
    sortOrder: 0,
    isRequired: false,
    isHidden: false,
    isBuiltin: true,
    config: {},
    options: [
      { id: 'o1', fieldId: 'f', value: 'END OF LIFE', label: 'End of life', sortOrder: 0, isArchived: false },
      { id: 'o2', fieldId: 'f', value: 'UPGRADES', label: 'Upgrades', sortOrder: 1, isArchived: false },
    ],
    createdAt: '',
    ...overrides,
  }
}

describe('blankValueForField: a new item starts unanswered', () => {
  test('a select never starts on its first option', () => {
    const select = field({})
    assert.equal(blankValueForField(select), '')
    assert.notEqual(blankValueForField(select), 'END OF LIFE')
    assert.equal(blankValueForField({ ...select, storage: 'custom' }), '')
    assert.equal(isFieldValueEmpty(select, blankValueForField(select)), true)
  })

  test('required selects start blank too (the form asks, it does not guess)', () => {
    assert.equal(blankValueForField(field({ isRequired: true })), '')
  })

  test('other input types start blank', () => {
    assert.equal(blankValueForField(field({ inputType: 'text' })), '')
    assert.equal(blankValueForField(field({ inputType: 'number' })), '')
    assert.equal(blankValueForField(field({ inputType: 'date' })), '')
    assert.equal(blankValueForField(field({ inputType: 'currency' })), '')
    assert.deepEqual(blankValueForField(field({ inputType: 'multiselect' })), [])
  })

  test('Yes/No questions start unanswered, not No (0023)', () => {
    assert.equal(blankValueForField(field({ inputType: 'boolean', storage: 'column' })), '')
    assert.equal(blankValueForField(field({ inputType: 'boolean', storage: 'custom' })), '')
  })
})

describe('storedFieldValue: what a skipped answer is written as', () => {
  test('a skipped column select is NULL (not "" and not the first option)', () => {
    const select = field({})
    assert.equal(storedFieldValue(select, ''), null)
    assert.equal(storedFieldValue(select, '   '), null)
    assert.equal(storedFieldValue(select, null), null)
    assert.equal(storedFieldValue(select, undefined), null)
  })

  test('a skipped Yes/No is NULL (column) or omitted (custom)', () => {
    assert.equal(storedFieldValue(field({ inputType: 'boolean' }), ''), null)
    assert.equal(storedFieldValue(field({ inputType: 'boolean' }), null), null)
    assert.equal(storedFieldValue(field({ inputType: 'boolean', storage: 'custom' }), ''), undefined)
  })

  test('a skipped custom field is omitted', () => {
    assert.equal(storedFieldValue(field({ storage: 'custom' }), ''), undefined)
    assert.equal(storedFieldValue(field({ storage: 'custom', inputType: 'text' }), ''), undefined)
    assert.equal(storedFieldValue(field({ storage: 'custom', inputType: 'number' }), null), undefined)
  })

  test('column text stays "" (NOT NULL DEFAULT \'\' columns)', () => {
    assert.equal(storedFieldValue(field({ inputType: 'text', key: 'name' }), ''), '')
    assert.equal(storedFieldValue(field({ inputType: 'textarea' }), undefined), '')
  })

  test('real answers pass through unchanged', () => {
    assert.equal(storedFieldValue(field({}), 'UPGRADES'), 'UPGRADES')
    assert.equal(storedFieldValue(field({ storage: 'custom' }), 'UPGRADES'), 'UPGRADES')
    assert.equal(storedFieldValue(field({ inputType: 'number' }), 0), 0)
    assert.equal(storedFieldValue(field({ inputType: 'boolean', storage: 'custom' }), false), false)
    assert.equal(storedFieldValue(field({ inputType: 'boolean' }), 'No'), 'No')
  })
})

describe('formatFieldValue: a skipped answer shows as EMPTY_FIELD_TEXT', () => {
  test('the display placeholder is the app-wide "-"', () => {
    assert.equal(EMPTY_FIELD_TEXT, '-')
  })

  test('blank / null select shows the placeholder, never an option', () => {
    const select = field({})
    for (const value of [null, undefined, '', '  ']) {
      assert.equal(formatFieldValue(select, value, { empty: EMPTY_FIELD_TEXT }), '-')
    }
    assert.equal(formatFieldValue(select, null), '')
  })

  test('an answered select still shows its label', () => {
    assert.equal(formatFieldValue(field({}), 'UPGRADES', { empty: EMPTY_FIELD_TEXT }), 'Upgrades')
  })

  test('0 and No are answers, not blanks (D-9)', () => {
    assert.equal(formatFieldValue(field({ inputType: 'number' }), 0, { empty: '-' }), '0')
    assert.equal(formatFieldValue(field({ inputType: 'boolean' }), 'No', { empty: '-' }), 'No')
    assert.equal(formatFieldValue(field({ inputType: 'multiselect' }), [], { empty: '-' }), '-')
  })
})

describe('readYesNo / writeYesNo: tri-state Yes/No (0023)', () => {
  test('reads both storages, unanswered is null', () => {
    assert.equal(readYesNo('Yes'), true)
    assert.equal(readYesNo(true), true)
    assert.equal(readYesNo('No'), false)
    assert.equal(readYesNo(false), false)
    for (const v of [null, undefined, '']) assert.equal(readYesNo(v), null)
  })

  test('writes the storage shape, null as blank', () => {
    const col = field({ inputType: 'boolean' })
    const custom = field({ inputType: 'boolean', storage: 'custom' })
    assert.equal(writeYesNo(col, true), 'Yes')
    assert.equal(writeYesNo(col, false), 'No')
    assert.equal(writeYesNo(custom, false), false)
    assert.equal(writeYesNo(col, null), '')
    assert.equal(storedFieldValue(col, writeYesNo(col, null)), null)
  })

  test('unanswered Yes/No displays as the placeholder; No is still No', () => {
    const col = field({ inputType: 'boolean' })
    assert.equal(formatFieldValue(col, null, { empty: EMPTY_FIELD_TEXT }), '-')
    assert.equal(formatFieldValue(col, null), '')
    assert.equal(formatFieldValue(col, 'No', { empty: EMPTY_FIELD_TEXT }), 'No')
    assert.equal(formatFieldValue(field({ inputType: 'boolean', storage: 'custom' }), false), 'No')
  })
})
