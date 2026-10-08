/**
 * Unit tests for lib/mappers.ts -- the WS-5 Phase 2 changes:
 *
 *   D-9   blank numeric <-> null, both directions (null = unanswered, 0 = zero)
 *   M-11  the line-item write mapping never sends system / filing columns
 *   M-25  no "now" fallback for the cost base year or the timeline start year
 *
 * Run with `npm run test:unit` (Node's built-in runner with native type
 * stripping). lib/mappers.ts imports its siblings without a file extension,
 * the way the Next bundler expects, so a tiny synchronous resolve hook maps
 * `./constants` -> `./constants.ts` before the module is loaded dynamically.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'

// `registerHooks` (Node >= 22.15) is newer than the installed @types/node,
// hence the local type.
type ResolveResult = { url: string }
type Resolve = (specifier: string, context: unknown) => ResolveResult
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: unknown, nextResolve: Resolve) => ResolveResult
  }) => void
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

type Mappers = typeof import('../../lib/mappers.ts')
let m: Mappers

before(async () => {
  m = await import('../../lib/mappers.ts')
})

function lineItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'li-1',
    project_id: 'p1',
    user_email: 'a@b.com',
    consultant_type: 'Mechanical',
    company_name: 'Acme',
    discipline: 'Mechanical',
    item_number: 'M1',
    name: 'Chiller',
    short_description: null,
    category: 'END OF LIFE',
    timeline_priority: '1_HIGH <5 years',
    building_area_impacted: 'WHOLE BUILDING',
    building_level_impacted: 'ROOF',
    operational_impact: 'LOW',
    benefit_to_users: 'LOW',
    benefit_to_public: 'LOW',
    relative_first_cost: '$LOW',
    estimated_first_cost: '1.2m',
    relative_operation_cost_impact: 'N/A',
    relative_operational_energy_usage: 'N/A',
    electrification_eo594: 'NONE',
    addressing_resiliency_sustainability: 'No',
    addressing_deferred_maintenance: 'No',
    code_life_safety_improvement: 'No',
    accessibility_improvement: 'No',
    historic_impact: 'No',
    potential_synergies: [],
    supporting_notes: null,
    created_at: '2026-01-01T00:00:00Z',
    ecc_amount: '1200000',
    annual_energy_savings: null,
    annual_cost_savings: null,
    energy_notes: null,
    custom_fields: {},
    ...overrides,
  } as Parameters<Mappers['rowToLineItem']>[0]
}

describe('D-9: line item savings, read direction', () => {
  test('null column stays null (unanswered), not 0', () => {
    const item = m.rowToLineItem(lineItemRow())
    assert.equal(item.annualEnergySavings, null)
    assert.equal(item.annualCostSavings, null)
  })

  test('0 stays 0 (an answer: no saving)', () => {
    const item = m.rowToLineItem(lineItemRow({ annual_energy_savings: 0, annual_cost_savings: '0' }))
    assert.equal(item.annualEnergySavings, 0)
    assert.equal(item.annualCostSavings, 0)
  })

  test('numeric strings from PostgREST are parsed', () => {
    const item = m.rowToLineItem(lineItemRow({ annual_energy_savings: '1500.5' }))
    assert.equal(item.annualEnergySavings, 1500.5)
  })

  test('blank string reads as null', () => {
    const item = m.rowToLineItem(lineItemRow({ annual_cost_savings: '  ' }))
    assert.equal(item.annualCostSavings, null)
  })
})

describe('D-9: line item savings, write direction', () => {
  test('null is written as null, not 0 and not omitted', () => {
    const row = m.lineItemToUpdateRow({ annualEnergySavings: null, annualCostSavings: null })
    assert.ok('annual_energy_savings' in row)
    assert.equal(row.annual_energy_savings, null)
    assert.equal(row.annual_cost_savings, null)
  })

  test("a blank string from a form draft becomes null, never ''", () => {
    const row = m.lineItemToUpdateRow({
      annualEnergySavings: '' as unknown as number,
      annualCostSavings: Number.NaN,
    })
    assert.equal(row.annual_energy_savings, null)
    assert.equal(row.annual_cost_savings, null)
  })

  test('0 is written as 0', () => {
    const row = m.lineItemToInsertRow({ annualEnergySavings: 0, annualCostSavings: 0 })
    assert.equal(row.annual_energy_savings, 0)
    assert.equal(row.annual_cost_savings, 0)
  })

  test('undefined keys are not sent at all (partial update)', () => {
    const row = m.lineItemToUpdateRow({ name: 'x' })
    assert.deepEqual(Object.keys(row), ['name'])
  })
})

describe('M-11: line item write mapping never sends system columns', () => {
  const SYSTEM = ['id', 'item_number', 'company_name', 'discipline', 'created_at', 'ecc_amount']
  const FILING = ['project_id', 'user_email', 'consultant_type']

  test('update of a whole LineItem drops system AND filing columns', () => {
    const whole = m.rowToLineItem(lineItemRow({ annual_energy_savings: 5 }))
    const row = m.lineItemToUpdateRow(whole)
    for (const column of [...SYSTEM, ...FILING]) {
      assert.ok(!(column in row), `${column} must not be sent on update`)
    }
    assert.equal(row.name, 'Chiller')
    assert.equal(row.annual_energy_savings, 5)
    assert.deepEqual(row.custom_fields, {})
  })

  test('insert sends filing columns but never system columns', () => {
    const whole = m.rowToLineItem(lineItemRow())
    const row = m.lineItemToInsertRow(whole)
    for (const column of SYSTEM) {
      assert.ok(!(column in row), `${column} must not be sent on insert`)
    }
    assert.equal(row.project_id, 'p1')
    assert.equal(row.user_email, 'a@b.com')
    assert.equal(row.consultant_type, 'Mechanical')
  })

  test('deprecated lineItemToRow is the update-safe mapping', () => {
    const row = m.lineItemToRow({ projectId: 'other', itemNumber: 'A5', name: 'n' })
    assert.deepEqual(row, { name: 'n' })
  })
})

describe('M-25: no "now" fallback for money / calendar years', () => {
  test('missing cost settings row -> baseYear null, other defaults intact', () => {
    const settings = m.rowToCostSettings(null, [], 'p1')
    assert.equal(settings.baseYear, null)
    assert.equal(settings.tpcFactor, 1.33)
    assert.equal(settings.projectId, 'p1')
  })

  test('stored base year is used', () => {
    const settings = m.rowToCostSettings({ project_id: 'p1', base_year: '2025' }, [], 'p1')
    assert.equal(settings.baseYear, 2025)
  })

  test('missing timeline row -> startCalendarYear null', () => {
    const settings = m.rowToTimelineSettings(null, 'p1')
    assert.equal(settings.startCalendarYear, null)
    assert.equal(settings.fiscalYearStartMonth, 7)
  })

  test('stored start year is used', () => {
    const settings = m.rowToTimelineSettings({ start_calendar_year: 2027 }, 'p1')
    assert.equal(settings.startCalendarYear, 2027)
  })

  test('a null year is omitted on write, never written as null or "now"', () => {
    const timeline = m.timelineSettingsToRow(m.rowToTimelineSettings(null, 'p1'))
    assert.ok(!('start_calendar_year' in timeline))
    const cost = m.costSettingsToRow(m.rowToCostSettings(null, [], 'p1'))
    assert.ok(!('base_year' in cost))
  })

  test('a real year round-trips on write', () => {
    const timeline = m.timelineSettingsToRow(m.rowToTimelineSettings({ start_calendar_year: 2026 }, 'p1'))
    assert.equal(timeline.start_calendar_year, 2026)
    const cost = m.costSettingsToRow(m.rowToCostSettings({ base_year: 2026 }, [], 'p1'))
    assert.equal(cost.base_year, 2026)
  })
})

describe('scenario payload RPC arguments', () => {
  test('phases and dependencies map to the stored snake_case shape', () => {
    const phases = m.scenarioPhasesToRows([
      {
        id: 'ph1',
        chunkProjectId: 'c1',
        name: 'Design',
        kind: 'design',
        sortOrder: 0,
        pctOfTpc: 20,
        startSlot: 2,
        durationSlots: 3,
        durationLocked: false,
      },
    ])
    assert.deepEqual(phases[0], {
      id: 'ph1',
      chunk_project_id: 'c1',
      name: 'Design',
      kind: 'design',
      sort_order: 0,
      pct_of_tpc: 20,
      start_slot: 2,
      duration_slots: 3,
      duration_locked: false,
    })
    const deps = m.scenarioDependenciesToRows([
      { id: 'd1', predecessorPhaseId: 'a', successorPhaseId: 'b', depType: 'FS', lagSlots: -1 },
    ])
    assert.deepEqual(deps[0], {
      id: 'd1',
      predecessor_phase_id: 'a',
      successor_phase_id: 'b',
      dep_type: 'FS',
      lag_slots: -1,
    })
  })
})

describe('project + access notice mapping', () => {
  test('rowToProject carries updated_at for expectedUpdatedAt', () => {
    const project = m.rowToProject({ id: 'p1', name: 'P', created_at: '2026-01-01', updated_at: '2026-02-02T00:00:00Z' })
    assert.equal(project.updatedAt, '2026-02-02T00:00:00Z')
  })

  test('access notice falls back to project id when the name is unknown', () => {
    const row = { id: 'n1', email: 'a@b.com', project_id: 'p1', created_at: 't', seen_at: null }
    assert.equal(m.rowToAccessNotice(row).projectName, 'p1')
    assert.equal(m.rowToAccessNotice(row, 'Library').projectName, 'Library')
  })
})

describe('0019: ecc_amount null stays distinguishable from $0', () => {
  test('null ecc_amount reads as null', () => {
    assert.equal(m.rowToLineItem(lineItemRow({ ecc_amount: null })).eccAmount, null)
  })
  test('0 ecc_amount reads as 0', () => {
    assert.equal(m.rowToLineItem(lineItemRow({ ecc_amount: '0' })).eccAmount, 0)
  })
})
