/**
 * Timeline graphs (migration 0032): which line-item values a graph can be
 * built from, how a package's total for one is summed, and the colours.
 *
 * Megan: "similar to the energy reduction graph that shows up on the
 * timeline, would it be possible to add a parameter for carbon reduction
 * that can be tracked on a separate graph right below energy? It could be a
 * different color (blue maybe?)."
 *
 * The owner: "Similarly allow them to create graphs from any column they
 * want. [...] The parameter for that will also be there so let them set
 * that up manually."
 *
 * So a graph names a SOURCE: a numeric built-in line-item column, or a
 * custom form-builder field of type number or currency (the "parameter"
 * they add themselves, e.g. "Annual carbon reduction (MTCO2e)"). Pure --
 * the Timeline and the Excel export both sum through `packageGraphValues`,
 * so the screen and the workbook cannot disagree on a graph's numbers.
 */

import { parseCostInput, parseQuantityInput } from './costs'
import type { ChunkProject, FormField, LineItem, ProjectGraph } from './types'

/* ------------------------------------------------------------- sources -- */

type BuiltinSource = {
  key: string
  /** Shown when the project's form has no row for the column. */
  fallbackLabel: string
  read: (item: LineItem) => number
}

/**
 * The built-in columns a graph may sum. Keyed by the form field key (which
 * for a built-in IS the line_items column, migration 0012). Blank is "not
 * answered" (D-9) and contributes nothing to a sum, as on the energy chart.
 *
 * estimated_first_cost reads the trigger-maintained ecc_amount, with a parse
 * of the text as a fallback -- the same rule every cost total uses.
 */
const BUILTIN_SOURCES: readonly BuiltinSource[] = [
  {
    key: 'annual_energy_savings',
    fallbackLabel: 'Annual energy saving',
    read: (item) => item.annualEnergySavings ?? 0,
  },
  {
    key: 'annual_cost_savings',
    fallbackLabel: 'Annual utility cost saving',
    read: (item) => item.annualCostSavings ?? 0,
  },
  {
    key: 'estimated_first_cost',
    fallbackLabel: 'Estimated first cost',
    read: (item) => item.eccAmount || parseCostInput(item.estimatedFirstCost),
  },
]

const BUILTIN_BY_KEY = new Map(BUILTIN_SOURCES.map((s) => [s.key, s]))

/** The source the seeded Energy graph uses. */
export const ENERGY_SOURCE_KEY = 'annual_energy_savings'

export type GraphSourceOption = {
  key: string
  label: string
  kind: 'builtin' | 'custom'
  /** Hidden from (or removed from) the line-item form: still graphable --
   *  values already entered are kept -- but nobody can type new ones. */
  hiddenFromForm: boolean
}

function isGraphableCustomField(field: FormField): boolean {
  return field.storage === 'custom' && (field.inputType === 'number' || field.inputType === 'currency')
}

/**
 * Everything a graph can be built from, for the setup dropdown: the
 * built-in numeric columns first (labelled as the project's form labels
 * them), then the project's custom number and currency fields in form order.
 */
export function graphSourceOptions(formFields: readonly FormField[]): GraphSourceOption[] {
  const byKey = new Map(formFields.map((f) => [f.key, f]))
  const builtins: GraphSourceOption[] = BUILTIN_SOURCES.map((source) => {
    const field = byKey.get(source.key)
    return {
      key: source.key,
      label: field?.label || source.fallbackLabel,
      kind: 'builtin',
      hiddenFromForm: field ? field.isHidden : false,
    }
  })
  const custom: GraphSourceOption[] = [...formFields]
    .filter(isGraphableCustomField)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((field) => ({
      key: field.key,
      label: field.label,
      kind: 'custom',
      hiddenFromForm: field.isHidden,
    }))
  return [...builtins, ...custom]
}

/** True when the project's custom fields include no number/currency field
 *  -- the setup UI then explains how to add one. */
export function hasCustomNumericField(formFields: readonly FormField[]): boolean {
  return formFields.some(isGraphableCustomField)
}

/** Whether `sourceKey` still names something a graph can sum (a custom
 *  field may have been deleted or retyped since the graph was set up). */
export function isKnownGraphSource(sourceKey: string, formFields: readonly FormField[]): boolean {
  if (BUILTIN_BY_KEY.has(sourceKey)) return true
  return formFields.some((f) => f.key === sourceKey && isGraphableCustomField(f))
}

/**
 * One line item's value for a graph source. Custom number fields are stored
 * as JSON numbers; a legacy string, or a currency field's text, is parsed.
 * Anything unreadable, blank or missing contributes 0.
 */
export function lineItemGraphValue(item: LineItem, sourceKey: string): number {
  const builtin = BUILTIN_BY_KEY.get(sourceKey)
  if (builtin) {
    const value = builtin.read(item)
    return Number.isFinite(value) ? value : 0
  }
  const raw = item.customFields?.[sourceKey]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  if (typeof raw === 'string' && raw.trim() !== '') {
    const plain = Number(raw.replace(/,/g, '').trim())
    return Number.isFinite(plain) ? plain : parseCostInput(raw)
  }
  return 0
}

/**
 * Per package: the sum of the source over its line items, each times its
 * quantity in that package -- exactly how the energy total has always been
 * summed (TimelineTab packageInputs). Before the interaction factor, which
 * the engine applies (lib/cost-model.ts computeMetricSeries).
 */
export function packageGraphValues(
  chunkProjects: readonly Pick<ChunkProject, 'id' | 'itemLinks'>[],
  lineItemsById: ReadonlyMap<string, LineItem>,
  sourceKey: string
): Map<string, number> {
  const values = new Map<string, number>()
  for (const chunk of chunkProjects) {
    let total = 0
    for (const link of chunk.itemLinks) {
      const item = lineItemsById.get(link.lineItemId)
      if (!item) continue
      total += lineItemGraphValue(item, sourceKey) * parseQuantityInput(link.quantity)
    }
    values.set(chunk.id, total)
  }
  return values
}

/* -------------------------------------------------------------- colours -- */

/** The energy chart's green since it shipped, and the seeded Energy graph's. */
export const DEFAULT_GRAPH_COLOR = '#059669'

/** Swatches offered in setup. Green first (energy), blue second (Megan's
 *  "blue maybe?" for carbon); the rest are distinct at chart line weight. */
export const GRAPH_PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'Green', hex: '#059669' },
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Teal', hex: '#0d9488' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Amber', hex: '#d97706' },
  { name: 'Rose', hex: '#e11d48' },
  { name: 'Slate', hex: '#475569' },
]

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim())
}

/** '#rrggbb' -> 'rgba(r,g,b,alpha)', for the fill under a graph's line.
 *  Falls back to the default green for anything that is not a hex colour. */
export function colorWithAlpha(hex: string, alpha: number): string {
  const value = isHexColor(hex) ? hex.trim() : DEFAULT_GRAPH_COLOR
  const r = Number.parseInt(value.slice(1, 3), 16)
  const g = Number.parseInt(value.slice(3, 5), 16)
  const b = Number.parseInt(value.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** The first palette colour no existing graph uses -- a new graph should not
 *  default to the same green as Energy. */
export function nextGraphColor(graphs: readonly Pick<ProjectGraph, 'color'>[]): string {
  const used = new Set(graphs.map((g) => g.color.toLowerCase()))
  return GRAPH_PALETTE.find((c) => !used.has(c.hex))?.hex ?? GRAPH_PALETTE[0].hex
}

/** The engine's view of a graph's settings. */
export function graphMetricSettings(graph: Pick<ProjectGraph, 'unitLabel' | 'baselineAnnual' | 'interactionFactor'>) {
  return {
    unitLabel: graph.unitLabel,
    baselineAnnual: graph.baselineAnnual,
    interactionFactor: graph.interactionFactor,
  }
}
