/**
 * The timeline's pixel geometry — the single source of truth for where a slot
 * lands on screen.
 *
 * This module exists because three things have to agree to the pixel: the
 * column grid, the phase bars drawn absolutely on top of it, and the energy
 * chart underneath. Megan's sketch has the savings curve stepping down directly
 * beneath the bar that causes the step, and that only reads correctly if the
 * chart's x-axis and the grid's columns are literally the same arithmetic.
 *
 * The obvious alternative — letting a charting library compute its own scale —
 * introduces a second translation from "slot N" to "pixel X" that has to be
 * kept in sync with this one by hand. Two sources of truth for the same number
 * is how charts end up half a column out of register.
 */

export const CELL_WIDTH = 92
export const LABEL_COLUMN_WIDTH = 300

/** Height of a package row. Rendered as a FIXED height, not a minimum: the
 *  dependency arrows are positioned from this number, so a row that grows to
 *  fit its label (e.g. the "Phases total" warning) pushes every bar below it
 *  out from under its arrows. Sized to fit the tallest label. */
export const PACKAGE_ROW_HEIGHT = 132
/** Height of one expanded phase sub-row. */
export const PHASE_ROW_HEIGHT = 52

export const BAR_HEIGHT = 34
export const BAR_INSET = 4

/** Vertical space the energy chart occupies below the grid. */
export const ENERGY_CHART_HEIGHT = 168
export const ENERGY_CHART_PADDING_TOP = 20
export const ENERGY_CHART_PADDING_BOTTOM = 28

export function timelineWidth(slotCount: number): number {
  return Math.max(slotCount * CELL_WIDTH, CELL_WIDTH)
}

/** Left edge of a slot, in pixels from the start of the timeline area (i.e.
 *  NOT including the label column). Fractional slots are supported because
 *  phases can sit off integer boundaries. */
export function xForSlot(slot: number): number {
  return slot * CELL_WIDTH
}

/** Pixel rect for a phase bar within its row. */
export function barRect(startSlot: number, durationSlots: number, rowHeight: number) {
  const left = xForSlot(startSlot) + BAR_INSET
  const width = Math.max(xForSlot(durationSlots) - BAR_INSET * 2, CELL_WIDTH - BAR_INSET * 2)
  return {
    left,
    width,
    top: (rowHeight - BAR_HEIGHT) / 2,
    height: BAR_HEIGHT,
  }
}

/**
 * Colour per phase kind.
 *
 * Design-side work is deliberately lighter and construction keeps v1's
 * navy→teal gradient. That is not decoration: on a plan where design sits years
 * ahead of the construction it belongs to, the two have to be distinguishable
 * at a glance across the width of the screen, and the client's whole
 * conversation is "when does the money land" — which is the dark bars.
 */
export const PHASE_STYLES: Record<
  'study' | 'design' | 'construction' | 'closeout',
  { bar: string; border: string; text: string; swatch: string; label: string }
> = {
  study: {
    bar: 'bg-[linear-gradient(135deg,rgba(148,163,184,0.92)_0%,rgba(100,116,139,0.9)_100%)]',
    border: 'border-slate-300',
    text: 'text-white',
    swatch: 'bg-slate-400',
    label: 'Study',
  },
  design: {
    bar: 'bg-[linear-gradient(135deg,rgba(56,189,248,0.9)_0%,rgba(14,116,144,0.92)_100%)]',
    border: 'border-sky-300',
    text: 'text-white',
    swatch: 'bg-sky-500',
    label: 'Design',
  },
  construction: {
    bar: 'bg-[linear-gradient(135deg,rgba(15,23,42,0.94)_0%,rgba(30,41,59,0.92)_50%,rgba(14,116,144,0.9)_100%)]',
    border: 'border-slate-700',
    text: 'text-white',
    swatch: 'bg-slate-900',
    label: 'Construction',
  },
  closeout: {
    bar: 'bg-[repeating-linear-gradient(135deg,rgba(20,83,45,0.9)_0px,rgba(20,83,45,0.9)_6px,rgba(22,101,52,0.9)_6px,rgba(22,101,52,0.9)_12px)]',
    border: 'border-emerald-700',
    text: 'text-white',
    swatch: 'bg-emerald-800',
    label: 'Closeout',
  },
}
