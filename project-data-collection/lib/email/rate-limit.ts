/**
 * A tiny in-memory sliding-window rate limiter for the routes that send email
 * (sign-up, forgot password, invite).
 *
 * WHY IN MEMORY IS ACCEPTABLE (FOR NOW). Each of those routes costs us a real
 * email through Resend and can be pointed at any address by anyone who can
 * reach the sign-up page. Without a limit, a script can mail-bomb a stranger
 * from our domain, burn the Resend quota, and get the sending domain flagged.
 * A per-process Map does not survive a cold start and is not shared between
 * serverless instances, so it is a speed bump, not a wall — but it stops the
 * casual loop and the double-clicked button, which is the realistic threat
 * today. If abuse ever shows up in the Resend logs, move this to a shared
 * store (Upstash / Vercel KV) behind the same `checkRateLimit` signature.
 *
 * Pure module (no Next imports) so it can be unit tested with `node --test`.
 */

type Bucket = number[]

const buckets = new Map<string, Bucket>()

// Bound memory: a flood of distinct keys (random emails) must not grow the
// Map forever. When it gets big, drop every bucket whose newest hit is older
// than the longest window we use.
const MAX_KEYS = 5000
const PRUNE_OLDER_THAN_MS = 60 * 60 * 1000

function prune(now: number) {
  if (buckets.size < MAX_KEYS) return
  for (const [key, hits] of buckets) {
    const newest = hits[hits.length - 1] ?? 0
    if (now - newest > PRUNE_OLDER_THAN_MS) buckets.delete(key)
  }
  // Still too big (a burst inside the window): drop oldest-inserted keys.
  while (buckets.size >= MAX_KEYS) {
    const first = buckets.keys().next().value
    if (first === undefined) break
    buckets.delete(first)
  }
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }

/**
 * Records one hit for `key` and reports whether it is within `limit` hits per
 * `windowMs`. A rejected hit is NOT recorded, so a client that keeps retrying
 * gets through again as soon as the window slides past its earlier hits.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  prune(now)
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    const oldest = hits[0]
    buckets.set(key, hits)
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) }
  }
  hits.push(now)
  buckets.set(key, hits)
  return { ok: true }
}

/** Test hook. */
export function resetRateLimits() {
  buckets.clear()
}

/**
 * Best-effort client IP for rate-limit keys. On Vercel `x-forwarded-for` is
 * set by the platform (first entry is the client); locally it is usually
 * absent, and every request shares the 'unknown' bucket, which is fine for
 * one developer.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return headers.get('x-real-ip')?.trim() || 'unknown'
}
