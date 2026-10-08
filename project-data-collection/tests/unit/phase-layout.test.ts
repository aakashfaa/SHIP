/**
 * The project-level phase template, laid out as a package's phases
 * (components/project-workspace/cost-model/phase-layout.ts).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  layoutTemplatePhases,
  packageStartMonth,
  resolveProjectTemplate,
} from '../../components/project-workspace/cost-model/phase-layout.ts'

type Template = Parameters<typeof layoutTemplatePhases>[0] & object

function template(id: string, name: string, isBuiltin: boolean, steps: Array<[string, number, number]>): Template {
  return {
    id,
    projectId: isBuiltin ? null : 'p',
    name,
    description: '',
    isBuiltin,
    steps: steps.map(([stepName, pct, months], i) => ({
      id: `${id}-s${i}`,
      templateId: id,
      name: stepName,
      kind: i === steps.length - 1 ? 'construction' : 'design',
      sortOrder: i,
      defaultPctOfTpc: pct,
      defaultDurationMonths: months,
    })),
  }
}

const DCAMM = template('dcamm', 'DCAMM Study + Design', true, [
  ['Study', 1, 12],
  ['Design', 9, 24],
  ['Construction', 90, 36],
])
const DC = template('dc', 'Design + Construction', true, [
  ['Design', 10, 12],
  ['Construction', 90, 36],
])

describe('resolveProjectTemplate', () => {
  test('the project template when it exists', () => {
    assert.equal(resolveProjectTemplate([DCAMM, DC], 'dc')?.id, 'dc')
  })
  test('DCAMM when the project has none, or it was deleted', () => {
    assert.equal(resolveProjectTemplate([DCAMM, DC], null)?.id, 'dcamm')
    assert.equal(resolveProjectTemplate([DCAMM, DC], 'gone')?.id, 'dcamm')
  })
  test('null when neither exists', () => {
    assert.equal(resolveProjectTemplate([DC], null), null)
  })
})

describe('layoutTemplatePhases', () => {
  test('phases run back to back from the start month, percentages as the template', () => {
    const seeds = layoutTemplatePhases(DCAMM, 24)
    assert.deepEqual(
      seeds.map((s) => [s.name, s.sortOrder, s.pctOfTpc, s.startMonth, s.durationMonths, s.templateStepId]),
      [
        ['Study', 0, 1, 24, 12, 'dcamm-s0'],
        ['Design', 1, 9, 36, 24, 'dcamm-s1'],
        ['Construction', 2, 90, 60, 36, 'dcamm-s2'],
      ]
    )
  })
  test('no template: one Construction phase at 100%', () => {
    const seeds = layoutTemplatePhases(null, 6)
    assert.equal(seeds.length, 1)
    assert.equal(seeds[0].pctOfTpc, 100)
    assert.equal(seeds[0].startMonth, 6)
    assert.equal(seeds[0].templateStepId, null)
  })
  test('a negative start is clamped to the first month', () => {
    assert.equal(layoutTemplatePhases(DC, -3)[0].startMonth, 0)
  })
})

describe('packageStartMonth', () => {
  test('earliest phase start, 0 with no phases', () => {
    assert.equal(packageStartMonth([{ startMonth: 30 }, { startMonth: 18 }]), 18)
    assert.equal(packageStartMonth([]), 0)
  })
})
