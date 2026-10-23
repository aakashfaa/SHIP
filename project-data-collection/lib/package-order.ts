/**
 * Package (chunk_projects) order and number rules, as pure functions so the
 * Packaging tab, the Timeline and the exports all agree and the rules are
 * unit-testable without a database.
 *
 * Since migration 0030 both the number and the order are user-owned:
 *  - the number is free text ("PP3", "12", "A-2"), trimmed, non-blank, at
 *    most PACKAGE_NUMBER_MAX_LENGTH characters and unique within the project
 *    (the database's unique (project_id, chunk_number) constraint is exact,
 *    so the check here is exact too);
 *  - the order is `sort_order`, independent of the number. Ties (which the
 *    reorder RPC never leaves, but a stale client could see) fall back to
 *    created_at then id, matching the SQL ORDER BY.
 *
 * Nothing keys a package by its number -- line item links, phases,
 * dependencies and scenarios all use the package id -- so renumbering and
 * reordering never move data.
 */

export const PACKAGE_NUMBER_MAX_LENGTH = 40

type Orderable = { id: string; sortOrder: number; createdAt: string }

/** Comparator for packages in display order. */
export function comparePackages(a: Orderable, b: Orderable): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** A sorted copy; never mutates the input. */
export function sortPackages<T extends Orderable>(packages: readonly T[]): T[] {
  return packages.slice().sort(comparePackages)
}

/** Map of package id -> display position, for sorting things that only
 *  carry a package id (e.g. Timeline summaries). */
export function packagePositions(packages: readonly Orderable[]): Map<string, number> {
  return new Map(sortPackages(packages).map((p, index) => [p.id, index]))
}

/**
 * Moves the item at `from` to `to` (both clamped into range) and returns a
 * new array. Used by keyboard reordering (Arrow Up / Arrow Down on the drag
 * handle). Returns the same array when nothing moves.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): readonly T[] {
  if (list.length === 0) return list
  const source = Math.max(0, Math.min(list.length - 1, from))
  const target = Math.max(0, Math.min(list.length - 1, to))
  if (source === target) return list
  const next = list.slice()
  const [moved] = next.splice(source, 1)
  next.splice(target, 0, moved)
  return next
}

/** True when two id lists are the same order. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * Validates a package number typed into the Rename dialog. Returns the
 * message to show inline, or null when `raw` (after trimming) can be saved.
 * `others` are the project's packages; the one being renamed (`selfId`) is
 * skipped so keeping its own number is fine.
 */
export function validatePackageNumber(
  raw: string,
  others: readonly { id: string; chunkNumber: string }[],
  selfId: string | null
): string | null {
  const value = raw.trim()
  if (value === '') return 'Enter a package number.'
  if (value.length > PACKAGE_NUMBER_MAX_LENGTH) {
    return `Package numbers can be at most ${PACKAGE_NUMBER_MAX_LENGTH} characters.`
  }
  const clash = others.find((p) => p.id !== selfId && p.chunkNumber.trim() === value)
  if (clash) return `${value} is already used by another package in this project.`
  return null
}
