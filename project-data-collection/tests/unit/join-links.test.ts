/**
 * Unit tests for lib/join-links.ts (migration 0035): token shape and
 * hashing, the join URL, the "may a join link set this account's password"
 * rule, and the link-state machine.
 *
 * Run with `npm run test:unit`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  JOIN_LINK_DAYS,
  buildJoinUrl,
  hashJoinToken,
  isUnactivatedShipInvite,
  isWellFormedJoinToken,
  joinLinkState,
  needsPassword,
  newJoinToken,
  recoveryRecentlySent,
  type JoinLinkRow,
} from '../../lib/join-links.ts'

describe('newJoinToken / isWellFormedJoinToken', () => {
  test('makes 43-character URL-safe tokens that pass the shape check', () => {
    for (let i = 0; i < 50; i++) {
      const token = newJoinToken()
      assert.equal(token.length, 43)
      assert.match(token, /^[A-Za-z0-9_-]+$/)
      assert.equal(isWellFormedJoinToken(token), true)
    }
  })

  test('tokens are unique', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newJoinToken()))
    assert.equal(seen.size, 200)
  })

  test('rejects anything else before it reaches the database', () => {
    const good = newJoinToken()
    assert.equal(isWellFormedJoinToken(good.slice(1)), false)
    assert.equal(isWellFormedJoinToken(good + 'A'), false)
    assert.equal(isWellFormedJoinToken(good.slice(1) + '='), false)
    assert.equal(isWellFormedJoinToken(good.slice(1) + '/'), false)
    assert.equal(isWellFormedJoinToken(good.slice(1) + '+'), false)
    assert.equal(isWellFormedJoinToken(''), false)
    assert.equal(isWellFormedJoinToken(null), false)
    assert.equal(isWellFormedJoinToken(undefined), false)
    assert.equal(isWellFormedJoinToken(42), false)
    assert.equal(isWellFormedJoinToken({ token: good }), false)
    assert.equal(isWellFormedJoinToken([good]), false)
  })
})

describe('hashJoinToken', () => {
  test('is the hex SHA-256 of the token', () => {
    const token = newJoinToken()
    assert.equal(hashJoinToken(token), createHash('sha256').update(token).digest('hex'))
    assert.match(hashJoinToken(token), /^[0-9a-f]{64}$/)
  })

  test('is deterministic and never the token itself', () => {
    const token = newJoinToken()
    assert.equal(hashJoinToken(token), hashJoinToken(token))
    assert.notEqual(hashJoinToken(token), token)
    assert.notEqual(hashJoinToken(token), hashJoinToken(newJoinToken()))
  })
})

describe('buildJoinUrl', () => {
  test('puts the token under /join on the configured base', () => {
    assert.equal(buildJoinUrl('https://ship.example.com', 'abc_-1'), 'https://ship.example.com/join/abc_-1')
  })

  test('ignores any path on the base (always site-rooted)', () => {
    assert.equal(buildJoinUrl('https://ship.example.com/some/path', 'tok'), 'https://ship.example.com/join/tok')
  })

  test('keeps a local port', () => {
    assert.equal(buildJoinUrl('http://127.0.0.1:3410', 'tok'), 'http://127.0.0.1:3410/join/tok')
  })
})

describe('isUnactivatedShipInvite', () => {
  const fresh = { user_metadata: { ship_invite: true }, email_confirmed_at: null, last_sign_in_at: null }

  test('true only for a SHIP-tagged, unconfirmed, never-signed-in account', () => {
    assert.equal(isUnactivatedShipInvite(fresh), true)
    assert.equal(isUnactivatedShipInvite({ user_metadata: { ship_invite: true } }), true)
  })

  test('a confirmed account has an owner', () => {
    assert.equal(isUnactivatedShipInvite({ ...fresh, email_confirmed_at: '2026-11-01T00:00:00Z' }), false)
  })

  test('an account someone has signed in to has an owner', () => {
    assert.equal(isUnactivatedShipInvite({ ...fresh, last_sign_in_at: '2026-11-01T00:00:00Z' }), false)
  })

  test("an untagged account (the other app's, or a SHIP self sign-up) is never touched", () => {
    assert.equal(isUnactivatedShipInvite({ ...fresh, user_metadata: {} }), false)
    assert.equal(isUnactivatedShipInvite({ ...fresh, user_metadata: null }), false)
    assert.equal(isUnactivatedShipInvite({ email_confirmed_at: null, last_sign_in_at: null }), false)
  })

  test('the tag must be literally true', () => {
    assert.equal(isUnactivatedShipInvite({ ...fresh, user_metadata: { ship_invite: 'true' } }), false)
    assert.equal(isUnactivatedShipInvite({ ...fresh, user_metadata: { ship_invite: 1 } }), false)
  })

  test('no user is not an invite', () => {
    assert.equal(isUnactivatedShipInvite(null), false)
    assert.equal(isUnactivatedShipInvite(undefined), false)
  })
})

describe('joinLinkState', () => {
  const now = new Date('2026-11-24T12:00:00Z')
  const row = (over: Partial<JoinLinkRow> = {}): JoinLinkRow => ({
    id: 'l1',
    project_id: 'p1',
    email: 'a@example.com',
    created_by: 'u1',
    expires_at: new Date(now.getTime() + JOIN_LINK_DAYS * 86_400_000).toISOString(),
    used_at: null,
    revoked_at: null,
    ...over,
  })

  test('a live link is ok', () => {
    assert.equal(joinLinkState(row(), now), 'ok')
  })

  test('no row is invalid', () => {
    assert.equal(joinLinkState(null, now), 'invalid')
  })

  test('revoked wins over everything (a replaced link just stops working)', () => {
    assert.equal(joinLinkState(row({ revoked_at: now.toISOString() }), now), 'invalid')
    assert.equal(
      joinLinkState(row({ revoked_at: now.toISOString(), used_at: now.toISOString() }), now),
      'invalid'
    )
  })

  test('used beats expired', () => {
    assert.equal(
      joinLinkState(row({ used_at: now.toISOString(), expires_at: '2020-01-01T00:00:00Z' }), now),
      'used'
    )
  })

  test('expires at the boundary, not after it', () => {
    assert.equal(joinLinkState(row({ expires_at: now.toISOString() }), now), 'expired')
    assert.equal(joinLinkState(row({ expires_at: new Date(now.getTime() + 1).toISOString() }), now), 'ok')
  })

  test('links last 14 days', () => {
    assert.equal(JOIN_LINK_DAYS, 14)
  })
})

describe('needsPassword', () => {
  const tagged = { user_metadata: { ship_invite: true } }
  const consultant = { role: 'consultant', password_set_at: null }

  test('a SHIP-invite account whose owner never chose a password', () => {
    assert.equal(needsPassword(consultant, tagged), true)
  })

  test('not once a password was set or used', () => {
    assert.equal(needsPassword({ ...consultant, password_set_at: '2026-11-01T00:00:00Z' }, tagged), false)
  })

  test('never a platform admin for a join link; yes for an emailed link', () => {
    assert.equal(needsPassword({ role: 'admin', password_set_at: null }, tagged), false)
    assert.equal(
      needsPassword({ role: 'admin', password_set_at: null }, tagged, { includeAdmins: true }),
      true
    )
    assert.equal(
      needsPassword({ role: 'admin', password_set_at: '2026-11-01T00:00:00Z' }, tagged, { includeAdmins: true }),
      false
    )
  })

  test('never an account SHIP did not create (shared auth.users)', () => {
    assert.equal(needsPassword(consultant, { user_metadata: {} }), false)
    assert.equal(needsPassword(consultant, { user_metadata: { ship_invite: 'true' } }), false)
    assert.equal(needsPassword(consultant, { user_metadata: null }), false)
  })

  test('needs both a profile and an auth user', () => {
    assert.equal(needsPassword(null, tagged), false)
    assert.equal(needsPassword(consultant, null), false)
  })
})

describe('recoveryRecentlySent', () => {
  const now = new Date('2026-11-24T12:00:00Z')

  test('inside two minutes: yes', () => {
    assert.equal(recoveryRecentlySent('2026-11-24T11:58:30Z', now), true)
    assert.equal(recoveryRecentlySent('2026-11-24T12:00:00Z', now), true)
  })

  test('two minutes or older, never, or nonsense: no', () => {
    assert.equal(recoveryRecentlySent('2026-11-24T11:58:00Z', now), false)
    assert.equal(recoveryRecentlySent('2026-11-23T12:00:00Z', now), false)
    assert.equal(recoveryRecentlySent(null, now), false)
    assert.equal(recoveryRecentlySent('not a date', now), false)
  })

  test('a clock skewed into the future does not block forever', () => {
    assert.equal(recoveryRecentlySent('2026-11-24T13:00:00Z', now), false)
  })
})
