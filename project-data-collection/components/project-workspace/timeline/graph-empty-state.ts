/**
 * What a timeline graph's empty state should tell the user is missing.
 *
 * Was energy-only (energy-empty-state.ts); since migration 0032 every graph
 * under the timeline has one, worded with the graph's own column.
 *
 * The chart draws nothing only when it has neither a usable baseline nor any
 * values, so in practice the baseline and values hints appear together; they
 * are computed independently so each one stays true on its own. A graph
 * whose column no longer exists (a custom field deleted or retyped since
 * the graph was set up) says that instead of asking for values nobody can
 * enter.
 */

export type GraphEmptyHint = {
  kind: 'baseline' | 'values' | 'source'
  /** Sentence used for the clickable link. */
  linkText: string
  /** Plain explanation for users who cannot act on it. */
  plainText: string
}

export function graphEmptyHints(
  series: { baseline: number | null; finalSavings: number },
  source: { label: string; missing: boolean } = { label: 'Annual energy saving', missing: false }
): GraphEmptyHint[] {
  const hints: GraphEmptyHint[] = []
  if (series.baseline === null || !(series.baseline > 0)) {
    hints.push({
      kind: 'baseline',
      linkText: 'Add a baseline in graph setup',
      plainText: 'No baseline is set for this graph.',
    })
  }
  if (source.missing) {
    hints.push({
      kind: 'source',
      linkText: 'Choose a column for this graph',
      plainText: 'The column this graph used no longer exists.',
    })
  } else if (!(series.finalSavings > 0)) {
    hints.push({
      kind: 'values',
      linkText: `Add ${source.label} to your line items`,
      plainText: `No line item has a value for ${source.label}.`,
    })
  }
  return hints
}
