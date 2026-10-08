/**
 * Unit tests for the pure auth/email helpers added in the pre-launch fix wave
 * (WS-2): `?next=` sanitising, the sign-in error banner codes, email-link
 * building, the email-format check, the in-memory rate limiter and the email
 * templates' escaping.
 *
 * Run with `npm run test:unit`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  authErrorFromHash,
  readAuthErrorCode,
  safeNextPath,
} from '../../lib/supabase/redirects.ts'
import {
  appBaseUrl,
  buildConfirmLink,
  buildSignInLink,
  isEmailExistsError,
  isPlausibleEmail,
  linkExpiryHours,
} from '../../lib/email/links.ts'
import { checkRateLimit, clientIpFromHeaders, resetRateLimits } from '../../lib/email/rate-limit.ts'
import {
  escapeHtml,
  renderAddedToProjectEmail,
  renderInviteEmail,
  renderResetPasswordEmail,
} from '../../lib/email/templates.ts'

describe('safeNextPath', () => {
  test('keeps same-origin relative paths, with query and hash', () => {
    assert.equal(safeNextPath('/projects'), '/projects')
    assert.equal(safeNextPath('/projects/abc?tab=timeline#x'), '/projects/abc?tab=timeline#x')
  })

  test('rejects anything that could leave the site', () => {
    for (const bad of [
      'https://evil.example/login',
      '//evil.example',
      '/\\evil.example',
      '\\/evil.example',
      '/\t/evil.example',
      'javascript:alert(1)',
      'projects',
      '',
      '   ',
      null,
      undefined,
      42,
      '/' + 'a'.repeat(3000),
    ]) {
      assert.equal(safeNextPath(bad), null, String(bad))
    }
  })
})

describe('auth error banner codes', () => {
  test('only known codes are accepted', () => {
    assert.equal(readAuthErrorCode('link_expired'), 'link_expired')
    assert.equal(readAuthErrorCode('link_invalid'), 'link_invalid')
    assert.equal(readAuthErrorCode('<script>'), null)
    assert.equal(readAuthErrorCode(null), null)
  })

  test("Supabase's #error fragment maps onto a banner", () => {
    assert.equal(
      authErrorFromHash('#error=access_denied&error_code=otp_expired&error_description=x'),
      'link_expired'
    )
    assert.equal(authErrorFromHash('#error=access_denied'), 'link_invalid')
    assert.equal(authErrorFromHash('#access_token=abc'), null)
    assert.equal(authErrorFromHash(''), null)
  })
})

describe('email links', () => {
  test('APP_URL wins over the request origin (no Host-header poisoning)', () => {
    assert.equal(
      appBaseUrl('http://evil.example/api/auth/forgot', { APP_URL: 'https://ship.example.com/' } as NodeJS.ProcessEnv),
      'https://ship.example.com'
    )
  })

  test('without APP_URL: request origin locally, refusal in production', () => {
    assert.equal(
      appBaseUrl('http://127.0.0.1:3410/api/x', { NODE_ENV: 'development' } as NodeJS.ProcessEnv),
      'http://127.0.0.1:3410'
    )
    assert.throws(() =>
      appBaseUrl('http://evil.example/api/x', { NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    )
  })

  test('confirm link carries token_hash, type and next on our own origin', () => {
    const link = new URL(buildConfirmLink('https://ship.example.com', 'abc123', 'invite', '/projects/p1'))
    assert.equal(link.origin, 'https://ship.example.com')
    assert.equal(link.pathname, '/auth/confirm')
    assert.equal(link.searchParams.get('token_hash'), 'abc123')
    assert.equal(link.searchParams.get('type'), 'invite')
    assert.equal(link.searchParams.get('next'), '/projects/p1')
  })

  test('the "added to project" link has no token at all (D-7)', () => {
    const link = new URL(buildSignInLink('https://ship.example.com', '/projects/p1'))
    assert.equal(link.pathname, '/')
    assert.deepEqual([...link.searchParams.keys()], ['next'])
  })

  test('link expiry defaults to 24h and honours the env override', () => {
    assert.equal(linkExpiryHours({} as NodeJS.ProcessEnv), 24)
    assert.equal(linkExpiryHours({ AUTH_LINK_EXPIRY_HOURS: '1' } as NodeJS.ProcessEnv), 1)
    assert.equal(linkExpiryHours({ AUTH_LINK_EXPIRY_HOURS: 'nope' } as NodeJS.ProcessEnv), 24)
  })
})

describe('isPlausibleEmail', () => {
  test('accepts ordinary addresses', () => {
    for (const ok of ['a@b.co', 'first.last+tag@sub.example.com', 'x_y@d-o.org']) {
      assert.equal(isPlausibleEmail(ok), true, ok)
    }
  })
  test('rejects obvious typos', () => {
    for (const bad of ['not-an-email', 'a@b', '@b.com', 'a@.com', 'a b@c.com', 'a@b.c', '<a@b.com>', 'a@b,c.com']) {
      assert.equal(isPlausibleEmail(bad), false, bad)
    }
  })
})

describe('isEmailExistsError', () => {
  test('recognises GoTrue "already registered" shapes', () => {
    assert.equal(isEmailExistsError({ code: 'email_exists', message: 'x' }), true)
    assert.equal(
      isEmailExistsError({ status: 422, message: 'A user with this email address has already been registered' }),
      true
    )
    assert.equal(isEmailExistsError({ status: 422, code: 'weak_password', message: 'weak' }), false)
    assert.equal(isEmailExistsError(null), false)
  })
})

describe('checkRateLimit', () => {
  test('allows `limit` hits per window, then refuses until the window slides', () => {
    resetRateLimits()
    const t0 = 1_000_000
    assert.equal(checkRateLimit('k', 2, 1000, t0).ok, true)
    assert.equal(checkRateLimit('k', 2, 1000, t0 + 10).ok, true)
    const third = checkRateLimit('k', 2, 1000, t0 + 20)
    assert.equal(third.ok, false)
    if (!third.ok) assert.ok(third.retryAfterSeconds >= 1)
    assert.equal(checkRateLimit('other', 2, 1000, t0 + 20).ok, true)
    assert.equal(checkRateLimit('k', 2, 1000, t0 + 1001).ok, true)
  })

  test('client IP comes from the first x-forwarded-for entry', () => {
    assert.equal(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' })), '1.2.3.4')
    assert.equal(clientIpFromHeaders(new Headers()), 'unknown')
  })
})

describe('email templates', () => {
  test('user-entered names are escaped in HTML and kept to one line in subjects', () => {
    const email = renderInviteEmail({
      link: 'https://ship.example.com/auth/confirm?token_hash=t&type=invite',
      projectName: 'Lab <a href="https://evil.example">click</a>\nBcc: x@y.z',
      inviterName: '<b>Admin</b>',
    })
    assert.ok(!email.html.includes('<a href="https://evil.example">'))
    assert.ok(email.html.includes('&lt;a href=&quot;https://evil.example&quot;&gt;'))
    assert.ok(email.html.includes('&lt;b&gt;Admin&lt;/b&gt;'))
    assert.ok(!/[\r\n]/.test(email.subject))
    assert.ok(email.text.includes('https://ship.example.com/auth/confirm?token_hash=t&type=invite'))
  })

  test('the link is HTML-escaped inside href (no attribute break-out)', () => {
    const email = renderResetPasswordEmail({ link: 'https://x.example/a?b=1&c="2"' })
    assert.ok(email.html.includes('href="https://x.example/a?b=1&amp;c=&quot;2&quot;"'))
  })

  test('the "added to project" email names the project and has no token', () => {
    const email = renderAddedToProjectEmail({
      link: 'https://ship.example.com/?next=%2Fprojects%2Fp1',
      forgotLink: 'https://ship.example.com/auth/forgot',
      projectName: 'Library Renovation',
    })
    assert.match(email.subject, /Library Renovation/)
    assert.ok(!email.html.includes('token_hash'))
    assert.ok(!email.text.includes('token_hash'))
  })

  test('escapeHtml covers the five specials', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;')
  })
})
