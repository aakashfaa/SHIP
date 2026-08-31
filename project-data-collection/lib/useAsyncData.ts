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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [version, setVersion] = useState(0)

  const reload = useCallback(() => {
    setVersion((current) => current + 1)
  }, [])

  useEffect(() => {
    // Guards against a slow earlier request resolving after a newer one and
    // clobbering fresh state (or setting state on an unmounted component).
    let cancelled = false

    setLoading(true)
    setError(null)

    loader()
      .then((result) => {
        if (cancelled) return
        setData(result)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // `loader` is intentionally excluded: callers pass an inline arrow that is
    // a new reference on every render. `deps` is the caller-declared identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version])

  return { data, setData, loading, error, reload }
}
