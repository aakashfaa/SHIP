import type { FormField } from './types'

/**
 * The questions every line item is asked, no matter how a project has
 * customised its form. The settings screen calls these "Default" (it used to
 * call every column-backed field "Built-in", which lumped the item's name in
 * with optional cost and impact questions nobody is obliged to answer).
 *
 * Everything else `ship.seed_default_form` creates is still column-backed --
 * the database still refuses to delete or retype it -- but the form builder
 * treats it like any other question: it can be hidden, reordered, relabelled
 * and removed. Hide and Remove are different: a hidden question stays in
 * the builder and can be shown again; a removed one leaves the builder. For a
 * custom field Remove deletes the row; for a column-backed one it hides the
 * row and marks it removed (see `isRemovedField`).
 */
export const DEFAULT_FIELD_KEYS = [
  'name',
  'short_description',
  'category',
  'timeline_priority',
  // Drives the Timeline energy-reduction chart. Default (always asked, never
  // hidden or removed) but still optional to answer.
  'annual_energy_savings',
] as const

export type DefaultFieldKey = (typeof DEFAULT_FIELD_KEYS)[number]

const DEFAULT_KEY_SET = new Set<string>(DEFAULT_FIELD_KEYS)

/**
 * Keys whose Required flag the builder will not let an admin turn off. A line
 * item with no name has nothing to list it by anywhere else in the app.
 */
export const ALWAYS_REQUIRED_KEYS = new Set<string>(['name'])

/** Default questions cannot be removed or hidden from the builder. Keyed on
 *  `isBuiltin` as well as `key` so a custom field that somehow shares a key
 *  (it cannot today -- createFormField de-duplicates) is never mistaken for
 *  one. */
export function isDefaultField(field: Pick<FormField, 'key' | 'isBuiltin'>): boolean {
  return field.isBuiltin && DEFAULT_KEY_SET.has(field.key)
}

/**
 * A column-backed field the admin REMOVED (see `removeBuiltinFormField` in
 * lib/store.ts). The database can't delete its row, so removal is
 * `isHidden: true` plus a `config.removed` marker; the marker is what tells
 * a removed field apart from one that is merely hidden. Removed fields are
 * left out of the form builder entirely -- a hidden one stays listed with a
 * Hidden pill and can be shown again; a removed one is gone. Custom fields
 * are deleted for real, so they never carry the marker.
 */
export function isRemovedField(
  field: Pick<FormField, 'key' | 'isBuiltin' | 'config'>
): boolean {
  return field.isBuiltin && !isDefaultField(field) && field.config?.removed === true
}
