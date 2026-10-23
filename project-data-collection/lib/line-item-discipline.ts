import type { ProjectPermissions } from './project-role'
import type { ConsultantType, Project, SafeUser } from './types'

/**
 * Who may file a new line item under a discipline other than their own.
 *
 *   "let the admins, basically all people with the faainc.com email, also
 *    add data on their end from other disciplines so have them pick a
 *    discipline in the form they fill for line items"            -- owner
 *
 * So: this project's admins, plus anyone signed in with an @faainc.com
 * address -- as long as they may add line items here at all (a viewer may
 * not, whatever their email).
 */
export const FAA_EMAIL_DOMAIN = 'faainc.com'

export function isFaaEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${FAA_EMAIL_DOMAIN}`)
}

export function canPickDiscipline(user: SafeUser, permissions: ProjectPermissions): boolean {
  if (!permissions.canContribute) return false
  return permissions.isAdmin || isFaaEmail(user.email)
}

/**
 * The disciplines offered in the picker: the one the form would have used
 * anyway first, then the project's roster, then every built-in discipline
 * -- "they should get all options even if people aren't added in there
 * from that discipline" (owner) -- each once (case-insensitively, keeping
 * the first spelling seen). The form adds an "Other…" box after these.
 */
export function disciplineChoices(
  project: Project,
  fallback: ConsultantType,
  builtins: readonly string[]
): ConsultantType[] {
  const seen = new Set<string>()
  const out: ConsultantType[] = []
  for (const type of [fallback, ...project.consultants.map((c) => c.type), ...builtins]) {
    const key = type.trim().toLowerCase()
    if (!key || key === 'admin' || seen.has(key)) continue
    seen.add(key)
    out.push(type)
  }
  return out
}
