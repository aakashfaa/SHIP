// One row of /api/admin/invite's response (see that route for the rules).
// `actionLink` is only ever present for a brand-new, never-activated account
// a SHIP invite created -- never for someone who already had an account
// (M-02 / D-7) -- so "Copy set-up link" only appears for those.
export type InviteResult = {
  email: string
  status?: 'invited' | 'added' | 'failed'
  invited: boolean
  alreadyExisted: boolean
  emailSent?: boolean
  actionLink: string | null
  error: string | null
}

export function describeInvite(result: InviteResult): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (result.status === 'failed' || (!result.status && result.error && !result.invited)) {
    return { text: result.error ?? 'Invite failed', tone: 'bad' }
  }
  if (result.error) return { text: result.error, tone: 'warn' }
  return result.alreadyExisted
    ? { text: 'Already has an account. We emailed them a sign-in link.', tone: 'ok' }
    : { text: 'Invite emailed. They choose a password from the link.', tone: 'ok' }
}

export function summarizeInvites(results: InviteResult[]): string {
  const failed = results.filter((r) => describeInvite(r).tone === 'bad').length
  const warned = results.filter((r) => describeInvite(r).tone === 'warn').length
  const ok = results.length - failed - warned
  if (failed === 0 && warned === 0) {
    return ok === 1 ? 'Invite sent.' : `${ok} invites sent.`
  }
  const parts: string[] = []
  if (ok > 0) parts.push(`${ok} sent`)
  if (warned > 0) parts.push(`${warned} need a follow-up`)
  if (failed > 0) parts.push(`${failed} failed`)
  return `Invites: ${parts.join(', ')}. See the details below.`
}
