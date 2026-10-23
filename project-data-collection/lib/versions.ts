/**
 * Versions of the plan (migration 0031): the one pure rule for turning the
 * live rows plus a version's payload into the schedule and cost model that
 * version prices.
 *
 *   "Each version can have a different cost model but they will have the
 *    same packages and line items so they can be saved and changed."
 *                                                                -- owner
 *
 * One version lives in the ordinary tables (chunk_phases, phase_dependencies,
 * project_cost_settings, escalation_rate_overrides); every other version is
 * a ship.scenarios row whose payload is laid over them here. The Timeline
 * (TimelineTab) and the Excel export (lib/export/report-data.ts) BOTH call
 * `applyVersionOverlay`, so the screen, the printed PDF and the workbook can
 * never price a version differently.
 *
 * Phases are overlaid PER PACKAGE, not per phase: a version that holds any
 * phase of a package holds all of them (its phase template may differ from
 * the live one, so its phases need not even share ids with the live rows).
 * A package with no phases in the payload -- one created after the version
 * was -- shows its live phases until it is edited in that version
 * (`packagePhasesForSave`). Phases of packages that no longer exist are
 * ignored.
 *
 * Type-only imports, like timeline/drag.ts, so Node's test runner loads it.
 */

import type {
  ChunkPhase,
  PhaseDependency,
  PlanVersion,
  ProjectCostSettings,
  Scenario,
  ScenarioPayload,
  ScenarioPhase,
} from './types'

/** The key of the version held in the ordinary tables. Every other version
 *  is keyed by its scenario id. */
export const LIVE_VERSION_KEY = 'live'

export type VersionInputs = {
  phases: readonly ChunkPhase[]
  dependencies: readonly PhaseDependency[]
  costSettings: ProjectCostSettings | null
}

export type VersionView = {
  phases: ChunkPhase[]
  dependencies: PhaseDependency[]
  costSettings: ProjectCostSettings | null
}

function scenarioPhaseToChunkPhase(phase: ScenarioPhase): ChunkPhase {
  return {
    id: phase.id,
    chunkProjectId: phase.chunkProjectId,
    templateStepId: phase.templateStepId ?? null,
    name: phase.name,
    kind: phase.kind,
    sortOrder: phase.sortOrder,
    pctOfTpc: phase.pctOfTpc,
    startMonth: phase.startMonth,
    durationMonths: phase.durationMonths,
    durationLocked: phase.durationLocked,
    createdAt: '',
  }
}

export function chunkPhaseToScenarioPhase(phase: ChunkPhase): ScenarioPhase {
  return {
    id: phase.id,
    chunkProjectId: phase.chunkProjectId,
    templateStepId: phase.templateStepId,
    name: phase.name,
    kind: phase.kind,
    sortOrder: phase.sortOrder,
    pctOfTpc: phase.pctOfTpc,
    startMonth: phase.startMonth,
    durationMonths: phase.durationMonths,
    durationLocked: phase.durationLocked,
  }
}

/**
 * The schedule and cost model of one version.
 *
 * `payload` null = the version in the live tables: returned as is.
 * `packageIds` = the packages that exist now; payload phases of any other
 * package are dropped (it was deleted).
 */
export function applyVersionOverlay(
  live: VersionInputs,
  payload: ScenarioPayload | null,
  packageIds: Iterable<string>
): VersionView {
  if (!payload) {
    return {
      phases: live.phases.slice(),
      dependencies: live.dependencies.slice(),
      costSettings: live.costSettings,
    }
  }

  const packages = new Set(packageIds)
  const own = payload.phases.filter((phase) => packages.has(phase.chunkProjectId))
  const covered = new Set(own.map((phase) => phase.chunkProjectId))
  const fallback = live.phases.filter((phase) => !covered.has(phase.chunkProjectId))

  const phases = [...own.map(scenarioPhaseToChunkPhase), ...fallback]
  const ids = new Set(phases.map((phase) => phase.id))
  const fallbackIds = new Set(fallback.map((phase) => phase.id))

  const projectId = live.costSettings?.projectId ?? live.dependencies[0]?.projectId ?? ''
  const ownLinks: PhaseDependency[] = payload.dependencies
    .filter((dep) => ids.has(dep.predecessorPhaseId) && ids.has(dep.successorPhaseId))
    .map((dep) => ({ ...dep, projectId }))
  const ownLinkIds = new Set(ownLinks.map((dep) => dep.id))
  // Live links between two fallback phases still describe this version.
  const liveLinks = live.dependencies.filter(
    (dep) =>
      !ownLinkIds.has(dep.id) &&
      fallbackIds.has(dep.predecessorPhaseId) &&
      fallbackIds.has(dep.successorPhaseId)
  )

  const costSettings =
    payload.costSettings && live.costSettings
      ? { ...payload.costSettings, projectId: live.costSettings.projectId }
      : payload.costSettings
        ? { ...payload.costSettings, projectId }
        : live.costSettings

  return { phases, dependencies: [...ownLinks, ...liveLinks], costSettings }
}

/**
 * What to send to ship.save_version_phases after an edit in a version: the
 * COMPLETE phase list of every package the edit touched, taken from the
 * schedule on screen (`effective`, the overlay) with `changed` applied. A
 * package that was falling back to its live phases is copied into the
 * version this way, which is what "becomes part of the version once edited"
 * means.
 */
export function packagePhasesForSave(
  effective: readonly ChunkPhase[],
  changed: ReadonlyArray<Pick<ChunkPhase, 'id' | 'startMonth' | 'durationMonths'>>
): ScenarioPhase[] {
  const byId = new Map(changed.map((row) => [row.id, row]))
  const touched = new Set(
    effective.filter((phase) => byId.has(phase.id)).map((phase) => phase.chunkProjectId)
  )
  return effective
    .filter((phase) => touched.has(phase.chunkProjectId))
    .map((phase) => {
      const moved = byId.get(phase.id)
      return chunkPhaseToScenarioPhase(
        moved
          ? {
              ...phase,
              startMonth: Math.max(0, Math.round(moved.startMonth)),
              durationMonths: Math.max(1, Math.round(moved.durationMonths)),
            }
          : phase
      )
    })
}

/** A payload with these packages' phases replaced -- the client-side twin
 *  of save_version_phases, for the optimistic update. */
export function replacePackagePhases(
  payload: ScenarioPayload,
  phases: readonly ScenarioPhase[]
): ScenarioPayload {
  const listed = new Set(phases.map((phase) => phase.chunkProjectId))
  const ids = new Set([
    ...payload.phases.filter((p) => !listed.has(p.chunkProjectId)).map((p) => p.id),
    ...phases.map((p) => p.id),
  ])
  return {
    ...payload,
    phases: [...payload.phases.filter((p) => !listed.has(p.chunkProjectId)), ...phases],
    dependencies: payload.dependencies.filter(
      (dep) => ids.has(dep.predecessorPhaseId) && ids.has(dep.successorPhaseId)
    ),
  }
}

/** Every version, as peers: the live one first (it is usually the oldest),
 *  then the others by creation. */
export function listVersions(liveName: string, scenarios: readonly Scenario[]): PlanVersion[] {
  return [
    { key: LIVE_VERSION_KEY, scenarioId: null, name: liveName },
    ...scenarios
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((scenario) => ({ key: scenario.id, scenarioId: scenario.id, name: scenario.name })),
  ]
}

/** "Version N" one past the highest "Version k" already used. */
export function nextVersionName(versions: readonly Pick<PlanVersion, 'name'>[]): string {
  let highest = versions.length
  for (const version of versions) {
    const match = /^version\s+(\d+)$/i.exec(version.name.trim())
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `Version ${highest + 1}`
}
