/**
 * WS-3 unit tests: the strict cost parser (M-09 / D-16), the quantity parser
 * (M-10) and lib/form-values.ts (M-28).
 *
 * The SQL twin of parseCostAmount is checked against it by
 * `npm run check:parser` (needs the local DB); these pin the TS side's
 * behaviour, including the error REASONS the form shows, which SQL doesn't
 * have.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_COST_AMOUNT,
  costInputFeedback,
  formatCostAmount,
  formatCostPreview,
  isUnreadableCost,
  parseCostAmount,
  parseCostInput,
  parseQuantity,
  parseQuantityInput,
  quantityInputFeedback,
} from '../../lib/costs.ts'
import {
  fieldKeyToProperty,
  formatFieldValue,
  getFieldValue,
  isFieldValueEmpty,
  orderedVisibleFields,
} from '../../lib/form-values.ts'
import type { FormField, LineItem } from '../../lib/types.ts'

/* ----------------------------------------------------------------- cost -- */

describe('parseCostAmount — accepted grammar', () => {
  const cases: Array<[string, number]> = [
    ['$1.2m', 1_200_000],
    ['1.2M', 1_200_000],
    ['850k', 850_000],
    ['1.5K', 1_500],
    ['12.5b', 12_500_000_000],
    ['1,250', 1_250],
    ['1,200,000.50', 1_200_000.5],
    ['$1,000,000.00', 1_000_000],
    ['  $ 2,400,000  ', 2_400_000],
    ['.5m', 500_000],
    ['0', 0],
    ['$0', 0],
    // D-16 shorthand words, with or without a space
    ['1.2 million', 1_200_000],
    ['100 million', 100_000_000],
    ['5 mil', 5_000_000],
    ['$3MIL', 3_000_000],
    ['2 thousand', 2_000],
    ['1.5 billion', 1_500_000_000],
    ['1 b', 1_000_000_000],
    // whitespace classes the parity script also covers
    ['\t5 mil\n', 5_000_000],
    [' 1k ', 1_000],
  ]
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      const result = parseCostAmount(input)
      assert.equal(result.ok, true)
      assert.equal(result.empty, false)
      assert.equal(result.amount, expected)
      assert.equal(parseCostInput(input), expected)
    })
  }

  test('decimal shorthand is exact, not binary-float drift', () => {
    // 1.15 * 1e6 === 1149999.9999999998 in JS; the parser must not do that.
    assert.equal(parseCostAmount('1.15m').amount, 1_150_000)
    assert.equal(parseCostAmount('1.005k').amount, 1_005)
  })

  test('exactly the cap is allowed', () => {
    assert.equal(parseCostAmount('10000b').amount, MAX_COST_AMOUNT)
  })
})

describe('parseCostAmount — blank is unanswered, not $0', () => {
  for (const input of ['', '   ', ' ']) {
    test(JSON.stringify(input), () => {
      assert.deepEqual(parseCostAmount(input), { ok: true, empty: true, amount: null })
      assert.equal(isUnreadableCost(input), false)
    })
  }
  test('null / undefined', () => {
    assert.equal(parseCostAmount(null).amount, null)
    assert.equal(parseCostAmount(undefined).ok, true)
  })
})

describe('parseCostAmount — the audit’s misreads are now unreadable (M-09)', () => {
  // Each of these used to produce a plausible wrong number (or $0).
  const unreadable = [
    '$1.2M (incl. contingency)', // was $1.20
    '$2M+', // was $2
    '1.5M est', // was $1.50
    '$1.5 M USD', // was $1.50
    '~1m', // was $0
    'approx 1m', // was $0
    '€1000', // was $0
    '£2k', // was $0
    'TBD', // was $0
    'n/a',
    '(1,000)', // was $0
    '1.000.000', // was $1
    '1,5', // was 15
    '1,2345',
    '12,34,567',
    '1/2m', // was $1,000,000
    '3e3', // exponents are not part of the grammar
    '1e309', // was Infinity in SQL, 0 in TS
    '12abc',
    '1.2.3',
    '+250',
    '5.',
    '$',
    'k',
    'M',
    '.',
    '1'.repeat(101),
  ]
  for (const input of unreadable) {
    test(JSON.stringify(input.length > 30 ? input.slice(0, 27) + '...' : input), () => {
      const result = parseCostAmount(input)
      assert.equal(result.ok, false)
      assert.equal(result.amount, null)
      if (!result.ok) assert.equal(result.reason, 'unreadable')
      assert.equal(isUnreadableCost(input), true)
      // The compatibility wrapper contributes 0 -- flagged elsewhere.
      assert.equal(parseCostInput(input), 0)
    })
  }
})

describe('parseCostAmount — negatives and the cap', () => {
  for (const input of ['-250k', '-500', '-1.5m', '$-5', '- $5', '-$1,000']) {
    test(`${JSON.stringify(input)} is rejected as negative`, () => {
      const result = parseCostAmount(input)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'negative')
    })
  }
  test('"-abc" is unreadable, not negative', () => {
    const result = parseCostAmount('-abc')
    assert.equal(!result.ok && result.reason, 'unreadable')
  })
  for (const input of ['10001b', '10,000,000,000,001', '99999999999999999999999']) {
    test(`${input} is too large`, () => {
      const result = parseCostAmount(input)
      assert.equal(!result.ok && result.reason, 'too_large')
    })
  }
})

describe('cost input feedback (the live "= $1,200,000" preview)', () => {
  test('ok', () => {
    assert.deepEqual(costInputFeedback('1.2m'), { kind: 'ok', message: '= $1,200,000' })
    assert.equal(formatCostPreview('$1.2 million'), '= $1,200,000')
    assert.equal(formatCostPreview('1,200,000.5'), '= $1,200,000.5')
    assert.equal(formatCostPreview('0'), '= $0')
  })
  test('empty', () => {
    assert.deepEqual(costInputFeedback('  '), { kind: 'empty', message: '' })
  })
  test('errors carry a sentence the user can act on', () => {
    assert.equal(costInputFeedback('TBD').kind, 'error')
    assert.match(costInputFeedback('TBD').message, /Can't read this amount/)
    assert.match(costInputFeedback('-5k').message, /negative/)
    assert.match(costInputFeedback('20000b').message, /trillion/)
  })
  test('formatCostAmount keeps every digit', () => {
    assert.equal(formatCostAmount(1_234_567), '$1,234,567')
    assert.equal(formatCostAmount(99.99), '$99.99')
  })
})

/* ------------------------------------------------------------- quantity -- */

describe('parseQuantity (M-10)', () => {
  const ok: Array<[string, number]> = [
    ['1', 1],
    ['0', 0], // was 1
    ['0.5', 0.5],
    ['1,200', 1_200], // was 1
    ['12 ea', 12],
    ['2.5 units', 2.5],
    ['3 sq ft', 3],
    ['1,200 SF', 1_200],
    [' 4 ', 4],
  ]
  for (const [input, expected] of ok) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      const result = parseQuantity(input)
      assert.equal(result.ok, true)
      assert.equal(result.quantity, expected)
      assert.equal(parseQuantityInput(input), expected)
    })
  }

  test('blank is one unit (the column default), not invalid', () => {
    assert.deepEqual(parseQuantity(''), { ok: true, empty: true, quantity: null })
    assert.equal(parseQuantityInput(''), 1)
    assert.equal(parseQuantityInput('   '), 1)
  })

  for (const input of ['abc', '1/2', '1,2', 'ea 12', '1.2.3', '$5']) {
    test(`${JSON.stringify(input)} is unreadable and prices as 0, not 1`, () => {
      const result = parseQuantity(input)
      assert.equal(!result.ok && result.reason, 'unreadable')
      assert.equal(parseQuantityInput(input), 0)
    })
  }

  for (const input of ['-2', '- 3 ea']) {
    test(`${JSON.stringify(input)} is negative`, () => {
      const result = parseQuantity(input)
      assert.equal(!result.ok && result.reason, 'negative')
      assert.equal(parseQuantityInput(input), 0)
    })
  }

  test('feedback', () => {
    assert.deepEqual(quantityInputFeedback('1,200 sf'), { kind: 'ok', message: '= 1,200' })
    assert.equal(quantityInputFeedback('abc').kind, 'error')
    assert.equal(quantityInputFeedback('').kind, 'empty')
  })
})

/* ---------------------------------------------------------- form values -- */

function field(overrides: Partial<FormField>): FormField {
  return {
    id: overrides.key ?? 'f',
    projectId: 'p',
    key: 'name',
    label: 'Name',
    helpText: '',
    inputType: 'text',
    storage: 'column',
    groupLabel: '',
    sortOrder: 0,
    isRequired: false,
    isHidden: false,
    isBuiltin: true,
    config: {},
    options: [],
    createdAt: '',
    ...overrides,
  }
}

describe('lib/form-values.ts', () => {
  const item = {
    name: 'Fire pump',
    electrificationEO594: 'HIGH',
    annualEnergySavings: 0,
    annualCostSavings: null,
    potentialSynergies: ['Electrical', 'Mechanical'],
    addressingDeferredMaintenance: 'Yes',
    customFields: { warranty_years: 5, has_permit: false, phase_code: 'b2', tags: [] },
  } as unknown as LineItem

  test('fieldKeyToProperty handles the EO594 override', () => {
    assert.equal(fieldKeyToProperty('electrification_eo594'), 'electrificationEO594')
    assert.equal(fieldKeyToProperty('annual_energy_savings'), 'annualEnergySavings')
  })

  test('getFieldValue reads column and custom storage', () => {
    assert.equal(getFieldValue(item, field({ key: 'name' })), 'Fire pump')
    assert.equal(getFieldValue(item, field({ key: 'electrification_eo594' })), 'HIGH')
    assert.equal(getFieldValue(item, field({ key: 'warranty_years', storage: 'custom' })), 5)
    assert.equal(getFieldValue(item, field({ key: 'missing', storage: 'custom' })), undefined)
  })

  test('isFieldValueEmpty: D-9 — 0 is an answer, null/blank are not', () => {
    const num = field({ inputType: 'number' })
    assert.equal(isFieldValueEmpty(num, 0), false)
    assert.equal(isFieldValueEmpty(num, null), true)
    assert.equal(isFieldValueEmpty(num, ' '), true)
    assert.equal(isFieldValueEmpty(field({ inputType: 'boolean' }), false), false)
    assert.equal(isFieldValueEmpty(field({ inputType: 'multiselect' }), []), true)
    assert.equal(isFieldValueEmpty(field({ inputType: 'text' }), ''), true)
  })

  test('formatFieldValue', () => {
    const select = field({
      inputType: 'select',
      options: [
        { id: '1', fieldId: 'f', value: 'b2', label: 'Phase B2', sortOrder: 0, isArchived: false },
      ],
    })
    assert.equal(formatFieldValue(select, 'b2'), 'Phase B2')
    assert.equal(formatFieldValue(select, 'retired'), 'retired')
    assert.equal(formatFieldValue(field({ inputType: 'multiselect' }), ['A', 'B']), 'A, B')
    assert.equal(formatFieldValue(field({ inputType: 'boolean' }), false), 'No')
    assert.equal(formatFieldValue(field({ inputType: 'boolean' }), 'Yes'), 'Yes')
    assert.equal(formatFieldValue(field({ inputType: 'number' }), 1234567.5), '1,234,567.5')
    assert.equal(formatFieldValue(field({ inputType: 'number' }), 0), '0')
    assert.equal(formatFieldValue(field({ inputType: 'number' }), null, { empty: '-' }), '-')
    assert.equal(formatFieldValue(field({ inputType: 'currency' }), '$1.2M'), '$1.2M')
  })

  test('orderedVisibleFields drops hidden and sorts', () => {
    const fields = [
      field({ key: 'c', sortOrder: 30 }),
      field({ key: 'a', sortOrder: 10 }),
      field({ key: 'h', sortOrder: 5, isHidden: true }),
      field({ key: 'b', sortOrder: 20 }),
    ]
    assert.deepEqual(orderedVisibleFields(fields).map((f) => f.key), ['a', 'b', 'c'])
  })
})
