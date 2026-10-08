'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Drop-in replacement for the old synchronous `useState(() => syncFn())` reads
 * against `lib/store.ts`, now that every store function returns a Promise.
 *
 *   const [items, setItems] = useState(() => getLineItemsForProject(id))
 *   // becomes
 *   const { data: items, setData: setItems, reload } = useAsyncData(
 *     () => getLineItemsForProject(id),
 *     [id],
 *     []
 *   )
 *
 * An imperative `refreshX()` helper becomes `reload()`.
 *
 * `setData` is exposed so components can still apply optimistic updates
 * locally without a round trip.
 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  initial: T
): {
  data: T
  setData: React.Dispatch<React.SetStateAction<T>>
  loading: boolean
  error: Error | null
  reload: () => void
} {
  const [data, setData] = useState<T>(initial)
  const [version, setVersion] = useState(0)
  // Which request the current `error` belongs to, and whether it has
  // settled. `loading` and `error` are DERIVED from this during render
  // instead of being reset with setState at the top of the effect (which
  // the React 19 / eslint-config-next 16.4 `react-hooks/set-state-in-effect`
  // rule rejects, and which costs an extra render). Same observable
  // behaviour as before: loading is true and error is null from the moment
  // the deps (or `reload`) change until that request settles.
  const [settled, setSettled] = useState<{ key: string; error: Error | null } | null>(null)

  const requestKey = depsKey([...deps, version])
  const loading = settled === null || settled.key !== requestKey
  const error = loading ? null : settled.error

  const reload = useCallback(() => {
    setVersion((current) => current + 1)
  }, [])

  useEffect(() => {
    // Guards against a slow earlier request resolving after a newer one and
    // clobbering fresh state (or setting state on an unmounted component).
    let cancelled = false

    loader()
      .then((result) => {
        if (cancelled) return
        setData(result)
        setSettled({ key: requestKey, error: null })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setSettled({
          key: requestKey,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        })
      })

    return () => {
      cancelled = true
    }
    // `loader` is intentionally excluded: callers pass an inline arrow that is
    // a new reference on every render. `requestKey` encodes the caller-declared
    // `deps` plus the reload counter, so it is the request's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  return { data, setData, loading, error, reload }
}

/** Stable identity for a deps list. Every caller passes primitive ids
 *  (project id, email), so JSON is exact; anything unserialisable falls back
 *  to String(), which is still stable per value. */
function depsKey(values: unknown[]): string {
  try {
    return JSON.stringify(values)
  } catch {
    return values.map((value) => String(value)).join('|')
  }
}
