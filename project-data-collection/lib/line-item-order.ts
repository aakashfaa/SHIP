/**
 * Pure helpers behind drag-to-reorder in Add Data (migration 0029).
 *
 * Owner: "Let people reorder stuff in the Add Data view so they can reorder
 * their own stuff ... by dragging and dropping, looking on the left side of a
 * line item, and moving up and down. Similarly there should be renumbering
 * after moving the things and if something is deleted there should be
 * renumbering for all."
 *
 * The database is the authority on numbers (ship.renumber_line_items); these
 * only make the list feel instant while the RPC runs, and are kept free of
 * React so tests/unit can exercise them.
 */

/** Ids in `ids` with `id` moved one place up (-1) or down (+1). Returns null
 *  when nothing moves (unknown id, already at that end). */
export function moveId(ids: readonly string[], id: string, direction: -1 | 1): string[] | null {
  const from = ids.indexOf(id)
  if (from < 0) return null
  const to = from + direction
  if (to < 0 || to >= ids.length) return null
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

const ITEM_NUMBER = /^([A-Za-z]*)(\d+)$/

/**
 * The numbers the list should show after a local reorder, before the server
 * answers: within each prefix, the numbers these items already hold are dealt
 * back out in the new order (A4..A7 stay A4..A7, just on different rows).
 *
 * That is exactly what the server does when nobody else has an item of the
 * same discipline in between; when someone does, the reload that follows the
 * RPC corrects it. Items whose number has no numeric tail keep it unchanged.
 *
 * Returns id -> number.
 */
export function previewItemNumbers(
  items: readonly { id: string; itemNumber: string }[]
): Map<string, string> {
  const byPrefix = new Map<string, { id: string; n: number }[]>()
  const result = new Map<string, string>()

  for (const item of items) {
    const match = ITEM_NUMBER.exec(item.itemNumber)
    if (!match) {
      result.set(item.id, item.itemNumber)
      continue
    }
    const prefix = match[1]
    const group = byPrefix.get(prefix) ?? []
    group.push({ id: item.id, n: Number(match[2]) })
    byPrefix.set(prefix, group)
  }

  for (const [prefix, group] of byPrefix) {
    const numbers = group.map((g) => g.n).sort((a, b) => a - b)
    group.forEach((g, i) => result.set(g.id, `${prefix}${numbers[i]}`))
  }

  return result
}
