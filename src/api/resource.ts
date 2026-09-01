/**
 * A tiny stale-while-revalidate cache for the dashboard's GET endpoints.
 *
 * Every list in this app used to refetch from zero on mount, which is what
 * makes the UI feel slow even when nothing changed: opening a job and pressing
 * back, switching to Packets and returning, or paging the feed and paging back
 * each cost a full round trip behind a "Loading…" line. The scored feed is the
 * worst of them — it ranks the whole corpus per request — so a cache hit there
 * is the difference between an instant view and several seconds of blank.
 *
 * Deliberately small: an in-memory Map that lives as long as the mounted MFE.
 * Nothing is persisted, so a reload is still a cold read and there is no
 * cross-session staleness to reason about.
 */

interface Entry<T> {
  value: T
  /** When the value landed, for the freshness check. */
  at: number
  /** Set while a request for this key is in flight, so callers share one. */
  inflight?: Promise<T>
}

const store = new Map<string, Entry<unknown>>()

/** Below this age a cached value is served without a background refresh. */
export const FRESH_MS = 30_000

/**
 * Run `fetcher` for `key`, sharing one request between concurrent callers.
 *
 * `onStale` fires synchronously with a cached value when there is one, so a
 * caller can paint immediately and then settle on the resolved promise.
 */
export function fetchResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  onStale?: (cached: T, fresh: boolean) => void
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined

  if (hit && 'value' in hit) {
    const fresh = Date.now() - hit.at < FRESH_MS
    onStale?.(hit.value, fresh)
    // A fresh value is the answer, not a placeholder — don't re-request it.
    if (fresh) return Promise.resolve(hit.value)
  }

  if (hit?.inflight) return hit.inflight

  const inflight = fetcher()
    .then(value => {
      store.set(key, { value, at: Date.now() })
      return value
    })
    .catch((err: unknown) => {
      // Drop only the in-flight marker: a failed refresh must not evict a
      // good cached value, or an offline blip empties every list.
      const cur = store.get(key) as Entry<T> | undefined
      if (cur) store.set(key, { value: cur.value, at: cur.at })
      else store.delete(key)
      throw err
    })

  store.set(key, hit ? { ...hit, inflight } : ({ inflight } as unknown as Entry<T>))
  return inflight
}

/** Read a cached value without triggering a request. */
export function peekResource<T>(key: string): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined
  return hit && 'value' in hit ? hit.value : undefined
}

/** Overwrite a cached value in place — for a mutation whose response IS the new state. */
export function primeResource<T>(key: string, value: T): void {
  store.set(key, { value, at: Date.now() })
}

/**
 * Drop every key starting with `prefix`.
 *
 * Callers pass the prefix that brackets what a write actually invalidated —
 * `'jobs:'` after a profile edit re-scores the feed, `'profiles:'` after a
 * profile is saved or deleted.
 */
export function invalidateResource(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}
