/**
 * The project's ONE phase template, turned into a package's phases.
 *
 * Every package gets its phases from the project template
 * (project_cost_settings.default_phase_template_id) -- per-package phase
 * structures are gone (owner's decision). Used when a package is created
 * (Packaging) and when the project template changes (Cost model popup), which
 * re-applies it to every package.
 *
 * Layout: the first phase starts at `startMonth`, each later phase starts
 * where the one before it ends. On a re-apply `startMonth` is the package's
 * earliest phase start, so the package keeps its place on the timeline.
 *
 * Type-only imports, like timeline/drag.ts, so Node's test runner loads it.
 */

import type { ChunkPhase, PhaseTemplate } from '@/lib/types'

/** A phase about to be written, minus the package it belongs to. */
export type PhaseSeed = Omit<ChunkPhase, 'id' | 'createdAt' | 'chunkProjectId'>

/** Fallback when the project has no template and DCAMM is missing too. */
export const FALLBACK_PHASE_DURATION_MONTHS = 12

export const DEFAULT_TEMPLATE_NAME = 'DCAMM Study + Design'

/** The project's template; else the built-in DCAMM; else null (fallback). */
export function resolveProjectTemplate(
  templates: readonly PhaseTemplate[],
  projectTemplateId: string | null
): PhaseTemplate | null {
  return (
    (projectTemplateId ? templates.find((t) => t.id === projectTemplateId) : undefined) ??
    templates.find((t) => t.isBuiltin && t.name === DEFAULT_TEMPLATE_NAME) ??
    null
  )
}

/** Where a package sits on the timeline: its earliest phase start, or 0. */
export function packageStartMonth(phases: ReadonlyArray<Pick<ChunkPhase, 'startMonth'>>): number {
  return phases.length === 0 ? 0 : Math.min(...phases.map((p) => p.startMonth))
}

export function layoutTemplatePhases(
  template: PhaseTemplate | null,
  startMonth: number
): PhaseSeed[] {
  const start = Math.max(0, startMonth)
  const steps = template ? [...template.steps].sort((a, b) => a.sortOrder - b.sortOrder) : []

  if (steps.length === 0) {
    return [
      {
        templateStepId: null,
        name: 'Construction',
        kind: 'construction',
        sortOrder: 0,
        pctOfTpc: 100,
        startMonth: start,
        durationMonths: FALLBACK_PHASE_DURATION_MONTHS,
        durationLocked: false,
      },
    ]
  }

  const seeds: PhaseSeed[] = []
  let cursor = start
  steps.forEach((step, index) => {
    const durationMonths = Math.max(1, step.defaultDurationMonths)
    seeds.push({
      templateStepId: step.id,
      name: step.name,
      kind: step.kind,
      sortOrder: index,
      pctOfTpc: step.defaultPctOfTpc,
      startMonth: cursor,
      durationMonths,
      durationLocked: false,
    })
    cursor += durationMonths
  })
  return seeds
}
