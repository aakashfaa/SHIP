/**
 * Emailed links (lib/supabase/email-confirm.ts): GET /auth/confirm uses
 * nothing; invite/recovery links open a "Choose a password" form whose POST
 * verifies the token and sets the password together, other types open a
 * Continue page. The type allowlist, the per-type wording, and the password
 * check that runs before the token is touched.
 *
 * Run with `npm run test:unit`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  OTP_TYPES,
  PASSWORD_LINK_ERRORS,
  confirmCopy,
  isDeadLinkError,
  isOtpType,
  isPasswordLinkType,
  isSetupFlag,
  readPasswordLinkError,
  validateNewPassword,
} from '../../lib/supabase/email-confirm.ts'

describe('isOtpType', () => {
  test('accepts exactly the email link types', () => {
    for (const t of ['invite', 'signup', 'recovery', 'magiclink', 'email', 'email_change']) {
      assert.equal(isOtpType(t), true, t)
    }
  })

  test('rejects anything else', () => {
    for (const bad of ['', 'sms', 'phone_change', 'INVITE', ' invite', null, undefined, 1, ['invite']]) {
      assert.equal(isOtpType(bad), false, String(bad))
    }
  })
})

describe('isPasswordLinkType', () => {
  test('only invite and recovery links ask for a password', () => {
    assert.equal(isPasswordLinkType('invite'), true)
    assert.equal(isPasswordLinkType('recovery'), true)
    for (const t of ['signup', 'email', 'magiclink', 'email_change', '', null]) {
      assert.equal(isPasswordLinkType(t), false, String(t))
    }
  })
})

describe('confirmCopy', () => {
  test('wording fits the link type', () => {
    assert.equal(confirmCopy('invite').heading, 'Finish setting up your account')
    assert.equal(confirmCopy('signup').heading, 'Confirm your email')
    assert.equal(confirmCopy('email').heading, 'Confirm your email')
    assert.equal(confirmCopy('recovery').heading, 'Reset your password')
  })

  test('a set-up recovery link says "Finish setting up", not "Reset"', () => {
    assert.equal(confirmCopy('recovery', { setup: true }).heading, 'Finish setting up your account')
    assert.doesNotMatch(confirmCopy('recovery', { setup: true }).body, /reset/i)
    // The flag only changes password links.
    assert.equal(confirmCopy('signup', { setup: true }).heading, 'Confirm your email')
  })

  test('Continue pages mention Continue; password pages ask for a password', () => {
    for (const t of OTP_TYPES) {
      const copy = confirmCopy(t)
      assert.ok(copy.heading.length > 0, t)
      if (isPasswordLinkType(t)) assert.match(copy.body, /password/i, t)
      else assert.ok(copy.body.includes('Continue'), t)
    }
  })
})

describe('isSetupFlag', () => {
  test('only "1" turns it on', () => {
    assert.equal(isSetupFlag('1'), true)
    for (const v of ['0', 'true', '', null, undefined, 1]) assert.equal(isSetupFlag(v), false, String(v))
  })
})

describe('validateNewPassword (runs before the token is used)', () => {
  test('accepts a matching password of 8 to 72 characters', () => {
    assert.equal(validateNewPassword('abcdefgh', 'abcdefgh'), null)
    assert.equal(validateNewPassword('x'.repeat(72), 'x'.repeat(72)), null)
  })

  test('too short, too long, mismatched, or missing', () => {
    assert.equal(validateNewPassword('short', 'short'), 'password_short')
    assert.equal(validateNewPassword('x'.repeat(73), 'x'.repeat(73)), 'password_long')
    assert.equal(validateNewPassword('abcdefgh', 'abcdefgi'), 'password_mismatch')
    assert.equal(validateNewPassword(null, null), 'password_short')
    assert.equal(validateNewPassword('abcdefgh', null), 'password_mismatch')
  })
})

describe('readPasswordLinkError', () => {
  test('known codes round-trip; anything else is null', () => {
    for (const code of Object.keys(PASSWORD_LINK_ERRORS)) {
      assert.equal(readPasswordLinkError(code), code)
    }
    for (const bad of ['', 'toString', '__proto__', 'nope', null, undefined]) {
      assert.equal(readPasswordLinkError(bad), null, String(bad))
    }
  })

  test('the expired message is the one the owner asked for', () => {
    assert.equal(PASSWORD_LINK_ERRORS.link_expired, 'This link has expired or was already used.')
  })

  test('only link errors mean the link is dead', () => {
    assert.equal(isDeadLinkError('link_expired'), true)
    assert.equal(isDeadLinkError('link_invalid'), true)
    assert.equal(isDeadLinkError('password_short'), false)
    assert.equal(isDeadLinkError(null), false)
  })
})
