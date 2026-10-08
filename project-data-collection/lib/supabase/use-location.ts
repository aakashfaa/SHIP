'use client'

import { useSyncExternalStore } from 'react'

// Reads `window.location.search` / `.hash` in a client component without
// `useSearchParams` (which forces a Suspense boundary on statically
// prerendered pages like `/` and the /auth/* screens) and without setting
// state from an effect. During prerender and hydration the server snapshot
// ('') is used, then React re-renders with the real value — no hydration
// mismatch.

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  window.addEventListener('hashchange', onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener('hashchange', onChange)
  }
}

export function useLocationSearch(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => ''
  )
}

export function useLocationHash(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => ''
  )
}

export function useQueryParam(name: string): string | null {
  return new URLSearchParams(useLocationSearch()).get(name)
}
