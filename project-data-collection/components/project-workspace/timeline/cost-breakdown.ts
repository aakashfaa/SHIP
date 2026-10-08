/**
 * The cost strip under the timeline, by fiscal year or by fiscal quarter
 * (per-project view setting `timeline.costBreakdown`, lib/view-settings.ts).
 *
 * Both views read the SAME `computeFiscalYearTotals` output -- the monthly
 * resolution split the Excel Annual Cost Summary uses (M-26, D-11). The
 * quarter view only lays those quarters out flat; it adds nothing up again,
 * so the two can never disagree about a dollar.
 *
 * Type-only imports, like drag.ts, so Node's test runner loads it directly.
 */

import type { FiscalYearTotal } from '@/lib/cost-model'

export type FiscalQuarterCell = {
  fiscalYear: number
  /** 1-4, Q1 = the fiscal year's first three months. */
  quarter: number
  baseTotal: number
  escalatedTotal: number
}

/** Every fiscal quarter, in order, across the fiscal years given. */
export function flattenFiscalQuarters(years: FiscalYearTotal[]): FiscalQuarterCell[] {
  return years.flatMap((year) =>
    year.quarters.map((q) => ({
      fiscalYear: year.fiscalYear,
      quarter: q.quarter,
      baseTotal: q.baseTotal,
      escalatedTotal: q.escalatedTotal,
    }))
  )
}
