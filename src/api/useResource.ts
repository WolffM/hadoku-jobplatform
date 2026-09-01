import { useEffect, useRef, useState } from 'react'
import { fetchResource, peekResource } from './resource'

export interface ResourceState<T> {
  data: T | undefined
  /** True only while there is nothing to show — a background refresh is not "loading". */
  loading: boolean
  /** A refresh is in flight over data already on screen. Dim it, don't replace it. */
  refreshing: boolean
  error: unknown
  reload: () => void
}

/**
 * Read a cached GET endpoint into a component.
 *
 * The point is what it does NOT do: it never drops back to an empty state to
 * show a spinner. A cached value paints on the first render — before any
 * effect runs — and a refresh swaps it out only once the new value has landed.
 * That is what turns "Loading jobs…" on every filter change into a list that
 * stays put and updates underneath.
 *
 * Pass `enabled: false` to hold off entirely (the feed uses it to avoid firing
 * a request for a profile the sidebar is still resolving).
 */
export function useResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  { enabled = true }: { enabled?: boolean } = {}
): ResourceState<T> {
  const [data, setData] = useState<T | undefined>(() =>
    enabled ? peekResource<T>(key) : undefined
  )
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [nonce, setNonce] = useState(0)

  // The fetcher closes over props and is rebuilt every render; re-running on
  // its identity would refetch on every parent render. `key` is the dependency
  // that actually describes the request, so the latest fetcher is read from a
  // ref instead of the dep array.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    if (!enabled) {
      setRefreshing(false)
      return
    }
    let cancelled = false
    setError(null)

    // Paint whatever is cached for the NEW key before the request resolves,
    // so switching pages or sorts doesn't blank what's on screen.
    const cached = peekResource<T>(key)
    if (cached !== undefined) setData(cached)
    setRefreshing(true)

    fetchResource<T>(
      key,
      () => fetcherRef.current(),
      (value, fresh) => {
        if (!cancelled) {
          setData(value)
          if (fresh) setRefreshing(false)
        }
      }
    )
      .then(value => {
        if (!cancelled) setData(value)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err)
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false)
      })

    return () => {
      cancelled = true
    }
  }, [key, enabled, nonce])

  return {
    data,
    loading: enabled && data === undefined && error === null,
    refreshing,
    error,
    reload: () => setNonce(n => n + 1)
  }
}
