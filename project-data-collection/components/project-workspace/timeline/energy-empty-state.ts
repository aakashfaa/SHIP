/**
 * What the energy chart's empty state should tell the user is missing.
 *
 * The chart draws nothing only when it has neither a usable baseline nor any
 * savings, so in practice both hints appear together; they are computed
 * independently so each one stays true on its own.
 */

export type EnergyEmptyHint = {
  kind: 'baseline' | 'savings'
  /** Sentence used for the clickable link. */
  linkText: string
  /** Plain explanation for users who cannot act on it. */
  plainText: string
}

export function energyEmptyHints(series: {
  baseline: number | null
  finalSavings: number
}): EnergyEmptyHint[] {
  const hints: EnergyEmptyHint[] = []
  if (series.baseline === null || !(series.baseline > 0)) {
    hints.push({
      kind: 'baseline',
      linkText: 'Add an energy baseline in the Cost model',
      plainText: 'No energy baseline is set in the Cost model.',
    })
  }
  if (!(series.finalSavings > 0)) {
    hints.push({
      kind: 'savings',
      linkText: 'Add Annual energy saving to your line items',
      plainText: 'No line item has an Annual energy saving.',
    })
  }
  return hints
}
