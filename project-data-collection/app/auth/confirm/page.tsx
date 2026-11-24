import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { safeNextPath } from '@/lib/supabase/redirects'
import {
  confirmCopy,
  isDeadLinkError,
  isOtpType,
  isPasswordLinkType,
  isSetupFlag,
  readPasswordLinkError,
} from '@/lib/supabase/email-confirm'
import { ConfirmForm } from './confirm-form'
import { PasswordLinkForm } from './password-link-form'

// Where every link in every SHIP email lands (M-03):
//   /auth/confirm?token_hash=…&type=invite|signup|recovery|magiclink|email&next=/projects/…
//   (+ &setup=1 on a recovery link for someone who never chose a password:
//   the page then says "Finish setting up your account", not "Reset")
//
// Opening it NEVER uses the link: mail scanners open links before people do
// and used to burn the one-time token here (lib/supabase/email-confirm.ts).
//   * invite / recovery: a "Choose a password" form. Submitting it POSTs to
//     /auth/confirm/verify, which verifies the token and sets the password
//     in one request, so the token is used only when they finish.
//   * other types: a Continue button that POSTs to the same route.
// Links already sitting in inboxes keep working: they land here like new
// ones.
//
// After a failed POST the route sends the person back here with ?error=
// (a password typo keeps token_hash, so they simply try again; a dead link
// drops it and the page offers a new link instead).

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams
}): Promise<Metadata> {
  const type = first((await searchParams).type)
  return {
    title: isPasswordLinkType(type) ? 'Choose a password' : 'Continue',
    // The URL carries a live token: don't leak it to anything this page loads.
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  }
}

function first(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? null) : null
}

export default async function ConfirmPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const tokenHash = first(params.token_hash)
  const type = first(params.type)
  const next = safeNextPath(first(params.next))
  const setup = isSetupFlag(first(params.setup))
  const error = readPasswordLinkError(first(params.error))

  if (isPasswordLinkType(type) && (tokenHash || isDeadLinkError(error))) {
    const copy = confirmCopy(type, { setup })
    return (
      <PasswordLinkForm
        heading={copy.heading}
        body={copy.body}
        tokenHash={isDeadLinkError(error) ? null : tokenHash}
        type={type}
        next={next}
        setup={setup}
        error={error}
      />
    )
  }

  if (!tokenHash || !isOtpType(type)) {
    const query = new URLSearchParams({ auth_error: 'link_invalid' })
    if (next) query.set('next', next)
    redirect(`/?${query.toString()}`)
  }

  const copy = confirmCopy(type)
  return (
    <ConfirmForm
      heading={copy.heading}
      body={copy.body}
      tokenHash={tokenHash}
      type={type}
      next={next}
    />
  )
}
