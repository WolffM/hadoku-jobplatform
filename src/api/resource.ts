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

/**
 * Cap on cached entries. A job posting carries its full description (~7.5KB
 * average), so a long browsing session would otherwise accumulate megabytes
 * that nothing ever drops. Map preserves insertion order, so evicting from the
 * front sheds the least recently ADDED — good enough here, where the entries
 * worth keeping (the current feed page) are also the ones most recently
 * written by a refresh.
 */
const MAX_ENTRIES = 120

function evictIfFull(): void {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next()
    if (oldest.done) return
    store.delete(oldest.value)
  }
}

/** Below this age a cached value is served without a background refresh. */
export const FRESH_MS = 30_000

export interface FetchOptions<T> {
  /**
   * Fires synchronously with a cached value when there is one, so a caller can
   * paint immediately and then settle on the resolved promise.
   */
  onStale?: (cached: T, fresh: boolean) => void
  /**
   * How long a value counts as fresh. The default suits a feed, where a stale
   * read should still be re-checked promptly. Answers that only move when the
   * corpus is re-scraped — the editor's "312 matching jobs" probes, each a
   * full-table LIKE — pass something much longer.
   */
  maxAgeMs?: number
}

/** Run `fetcher` for `key`, sharing one request between concurrent callers. */
export function fetchResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  { onStale, maxAgeMs = FRESH_MS }: FetchOptions<T> = {}
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined

  if (hit && 'value' in hit) {
    const fresh = Date.now() - hit.at < maxAgeMs
    onStale?.(hit.value, fresh)
    // A fresh value is the answer, not a placeholder — don't re-request it.
    if (fresh) return Promise.resolve(hit.value)
  }

  if (hit?.inflight) return hit.inflight

  const inflight = fetcher()
    .then(value => {
      // Re-insert rather than mutate, so a refreshed entry moves to the back
      // of the eviction order.
      store.delete(key)
      store.set(key, { value, at: Date.now() })
      evictIfFull()
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
