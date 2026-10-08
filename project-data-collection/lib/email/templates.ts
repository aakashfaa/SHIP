/**
 * The four emails SHIP sends, as plain functions returning
 * `{ subject, html, text }`.
 *
 * WHY WE WRITE OUR OWN. Since D-6 every auth email comes from our server via
 * Resend, never from Supabase's mailer (which is rate-limited to a few emails
 * an hour for the whole Supabase project, shared with an unrelated production
 * app, and sends generic "Confirm your signup" copy from a Supabase address).
 * So these templates are the first thing an outside consultant ever sees from
 * the product. They are written for that reader: plain language, one clear
 * button, the plain URL underneath for mail clients that strip buttons, and a
 * line saying what to do if the email was not expected.
 *
 * HTML NOTES. Email clients (Outlook especially) ignore most modern CSS, so
 * this is table layout with inline styles and no web fonts or images. Every
 * interpolated value goes through `escapeHtml` — project names and inviter
 * names are user-entered, and an unescaped `<a>` in a project name would let
 * one admin put an arbitrary link into an email signed by us.
 *
 * Pure module (no Next, no fetch) so it can be unit tested with `node --test`.
 */

export type RenderedEmail = { subject: string; html: string; text: string }

const PRODUCT = 'Master Plan Dashboard'
const COMPANY = 'Finegold Alexander Architects'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Subject lines are a header: strip anything that could break out of it.
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

type LayoutInput = {
  preheader: string
  heading: string
  paragraphs: string[] // already-escaped HTML fragments
  buttonLabel: string
  buttonUrl: string
  footnote: string // already-escaped HTML fragment
}

function layout(input: LayoutInput): string {
  const url = escapeHtml(input.buttonUrl)
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#334155;">${p}</p>`
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
<tr><td style="background:#0f172a;background-image:linear-gradient(135deg,#0f172a 0%,#1e293b 55%,#0f766e 100%);padding:24px 32px;">
<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#fcd34d;font-weight:600;">${escapeHtml(COMPANY)}</div>
<div style="margin-top:6px;font-size:20px;font-weight:600;color:#ffffff;">${escapeHtml(PRODUCT)}</div>
</td></tr>
<tr><td style="padding:32px;">
<h1 style="margin:0 0 20px;font-size:22px;line-height:30px;font-weight:600;color:#0f172a;">${escapeHtml(input.heading)}</h1>
${paragraphs}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:12px;background:#0f766e;">
<a href="${url}" style="display:inline-block;padding:14px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">${escapeHtml(input.buttonLabel)}</a>
</td></tr></table>
<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#64748b;">If the button doesn't work, copy this address into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all;"><a href="${url}" style="color:#0f766e;">${url}</a></p>
<p style="margin:0;font-size:13px;line-height:20px;color:#64748b;">${input.footnote}</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">${escapeHtml(PRODUCT)} &middot; ${escapeHtml(COMPANY)}</p>
</td></tr>
</table>
</body>
</html>`
}

function textBody(lines: string[]): string {
  return [...lines, '', `-- ${PRODUCT} · ${COMPANY}`].join('\n')
}

function projectPhrase(projectName: string | null | undefined): { html: string; text: string } {
  const name = projectName?.trim()
  return name
    ? { html: `the <strong>${escapeHtml(name)}</strong> project`, text: `the "${oneLine(name)}" project` }
    : { html: `the ${escapeHtml(PRODUCT)}`, text: `the ${PRODUCT}` }
}

function inviterPhrase(inviterName: string | null | undefined): { html: string; text: string } {
  const name = inviterName?.trim()
  return name
    ? { html: escapeHtml(name), text: oneLine(name) }
    : { html: 'Your project admin', text: 'Your project admin' }
}

// ---------------------------------------------------------------------------
// 1. Invite — a brand-new account. The link signs them in once and takes them
//    to "choose a password".
// ---------------------------------------------------------------------------
export function renderInviteEmail(input: {
  link: string
  projectName?: string | null
  inviterName?: string | null
  expiresInHours?: number
}): RenderedEmail {
  const project = projectPhrase(input.projectName)
  const inviter = inviterPhrase(input.inviterName)
  const hours = input.expiresInHours ?? 24
  const subject = input.projectName?.trim()
    ? `You're invited to ${oneLine(input.projectName)} on the ${PRODUCT}`
    : `You're invited to the ${PRODUCT}`

  return {
    subject,
    html: layout({
      preheader: 'Set a password to start adding your project data.',
      heading: "You've been invited",
      paragraphs: [
        `${inviter.html} has invited you to ${project.html}. You'll use it to add your team's line items and see how the project is being phased.`,
        `Click the button below and choose a password. That's all the setup there is.`,
      ],
      buttonLabel: 'Set up my account',
      buttonUrl: input.link,
      footnote: `This link works once and expires in ${hours} hours. If it has expired, ask ${inviter.html === 'Your project admin' ? 'your project admin' : inviter.html} to send a new one. If you weren't expecting this email, you can ignore it.`,
    }),
    text: textBody([
      "You've been invited",
      '',
      `${inviter.text} has invited you to ${project.text}. You'll use it to add your team's line items and see how the project is being phased.`,
      '',
      'Open this link and choose a password:',
      input.link,
      '',
      `This link works once and expires in ${hours} hours. If you weren't expecting this email, you can ignore it.`,
    ]),
  }
}

// ---------------------------------------------------------------------------
// 2. Added to a project — the person ALREADY has an account. Per D-7 this link
//    carries no token: it is just the sign-in page with ?next= pointing at
//    the project. They sign in with the password they already have.
// ---------------------------------------------------------------------------
export function renderAddedToProjectEmail(input: {
  link: string
  forgotLink: string
  projectName?: string | null
  inviterName?: string | null
}): RenderedEmail {
  const project = projectPhrase(input.projectName)
  const inviter = inviterPhrase(input.inviterName)
  const subject = input.projectName?.trim()
    ? `You've been added to ${oneLine(input.projectName)}`
    : `You've been given access to the ${PRODUCT}`

  return {
    subject,
    html: layout({
      preheader: 'Sign in with your existing password to open it.',
      heading: input.projectName?.trim() ? "You've been added to a project" : "You've been given access",
      paragraphs: [
        `${inviter.html} has added you to ${project.html}.`,
        `You already have an account, so there's nothing to set up. Sign in with the password you already use for this email address.`,
      ],
      buttonLabel: input.projectName?.trim() ? 'Open the project' : 'Sign in',
      buttonUrl: input.link,
      footnote: `Don't remember your password? <a href="${escapeHtml(input.forgotLink)}" style="color:#0f766e;">Reset it here</a>. If you weren't expecting this email, you can ignore it.`,
    }),
    text: textBody([
      `${inviter.text} has added you to ${project.text}.`,
      '',
      "You already have an account, so there's nothing to set up. Sign in with the password you already use for this email address:",
      input.link,
      '',
      `Don't remember your password? Reset it here: ${input.forgotLink}`,
    ]),
  }
}

// ---------------------------------------------------------------------------
// 3. Confirm sign-up — someone on the invite list chose a password on the
//    sign-up page; this proves they own the mailbox before claim_invite runs.
// ---------------------------------------------------------------------------
export function renderConfirmSignupEmail(input: {
  link: string
  expiresInHours?: number
}): RenderedEmail {
  const hours = input.expiresInHours ?? 24
  return {
    subject: `Confirm your email for the ${PRODUCT}`,
    html: layout({
      preheader: 'One click and your account is ready.',
      heading: 'Confirm your email',
      paragraphs: [
        `You've just set up an account on the ${escapeHtml(PRODUCT)}. Click the button below to confirm this is your email address, and you'll go straight in.`,
      ],
      buttonLabel: 'Confirm my email',
      buttonUrl: input.link,
      footnote: `This link works once and expires in ${hours} hours. If you didn't set up an account, you can ignore this email and nothing will happen.`,
    }),
    text: textBody([
      'Confirm your email',
      '',
      `You've just set up an account on the ${PRODUCT}. Open this link to confirm this is your email address:`,
      input.link,
      '',
      `This link works once and expires in ${hours} hours. If you didn't set up an account, ignore this email.`,
    ]),
  }
}

// ---------------------------------------------------------------------------
// 4. Reset password — from "Forgot password?", and also what someone who
//    already has an account gets if they try the sign-up page again (so the
//    sign-up page itself never reveals whether an account exists).
// ---------------------------------------------------------------------------
export function renderResetPasswordEmail(input: {
  link: string
  existingAccountOnSignUp?: boolean
  expiresInHours?: number
}): RenderedEmail {
  const hours = input.expiresInHours ?? 24
  const intro = input.existingAccountOnSignUp
    ? `Someone (hopefully you) tried to set up a new account with this email address, but you already have one. You can sign in with your existing password, or choose a new one with the button below.`
    : `We got a request to reset the password for this email address. Click the button below to choose a new one.`

  return {
    subject: input.existingAccountOnSignUp
      ? `You already have a ${PRODUCT} account`
      : `Reset your ${PRODUCT} password`,
    html: layout({
      preheader: input.existingAccountOnSignUp
        ? 'Sign in with your existing password, or choose a new one.'
        : 'Choose a new password.',
      heading: input.existingAccountOnSignUp ? 'You already have an account' : 'Reset your password',
      paragraphs: [escapeHtml(intro)],
      buttonLabel: 'Choose a new password',
      buttonUrl: input.link,
      footnote: `This link works once and expires in ${hours} hours. If you didn't ask for this, you can ignore this email; your password won't change.`,
    }),
    text: textBody([
      input.existingAccountOnSignUp ? 'You already have an account' : 'Reset your password',
      '',
      intro,
      '',
      input.link,
      '',
      `This link works once and expires in ${hours} hours. If you didn't ask for this, ignore this email; your password won't change.`,
    ]),
  }
}
