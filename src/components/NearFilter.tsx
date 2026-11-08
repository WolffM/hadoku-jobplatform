import { useEffect, useId, useState } from 'react'
import { searchLocations, type KnownPlace } from '../api/me'
import type { Auth } from '../api/auth'

export interface NearValue {
  place: KnownPlace
  radius: number
  includeRemote: boolean
}

const RADII = [10, 25, 50, 100]
const STORE_KEY = 'jobplatform:near'

/** The last location filter, so the feed reopens where the person left it. */
export function readNear(): NearValue | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<NearValue>
    return v.place?.key && v.place.label && typeof v.radius === 'number'
      ? { place: v.place, radius: v.radius, includeRemote: v.includeRemote !== false }
      : null
  } catch {
    // Storage can throw outright (Safari private mode). Remembering the
    // filter is a convenience; losing it is not an error.
    return null
  }
}

function writeNear(v: NearValue | null): void {
  try {
    if (v) window.localStorage.setItem(STORE_KEY, JSON.stringify(v))
    else window.localStorage.removeItem(STORE_KEY)
  } catch {
    // See readNear.
  }
}

/**
 * "Near Seattle, WA within 25 mi" for the feed. Places come from
 * GET /locations — the same table ingest reads postings' locations against —
 * so anything offered here is something the filter can actually match.
 */
export function NearFilter({
  auth,
  value,
  onChange
}: {
  auth: Auth
  value: NearValue | null
  onChange: (v: NearValue | null) => void
}) {
  const listId = useId()
  const [text, setText] = useState('')
  const [options, setOptions] = useState<KnownPlace[]>([])

  const set = (v: NearValue | null) => {
    writeNear(v)
    onChange(v)
  }

  // Debounced lookup; a stale answer for an older prefix is dropped.
  useEffect(() => {
    const q = text.trim()
    if (q.length < 2) {
      setOptions([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      searchLocations(q, auth).then(
        found => {
          if (!cancelled) setOptions(found)
        },
        () => {
          // A failed suggestion lookup leaves the old suggestions; the filter
          // itself is unaffected and the next keystroke retries.
        }
      )
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [text, auth])

  if (value) {
    return (
      <div className="jp-near" data-testid="near-filter">
        <span className="jp-near__chip">
          Near {value.place.label}
          <button
            type="button"
            className="jp-near__clear"
            aria-label={`Stop filtering near ${value.place.label}`}
            onClick={() => set(null)}
          >
            ×
          </button>
        </span>
        <label className="jp-jobs__filter">
          Within
          <select
            value={value.radius}
            onChange={e => set({ ...value, radius: Number(e.target.value) })}
          >
            {RADII.map(r => (
              <option key={r} value={r}>
                {r} mi
              </option>
            ))}
          </select>
        </label>
        <label className="jp-jobs__filter">
          <input
            type="checkbox"
            checked={value.includeRemote}
            onChange={e => set({ ...value, includeRemote: e.target.checked })}
          />
          Include remote
        </label>
      </div>
    )
  }

  return (
    <label className="jp-jobs__filter" data-testid="near-filter">
      Near
      <input
        type="search"
        className="jp-near__input"
        list={listId}
        value={text}
        placeholder="City"
        onChange={e => {
          const next = e.target.value
          // Picking from the datalist sets the input to an option's label.
          const picked = options.find(o => o.label === next)
          if (picked) {
            setText('')
            set({ place: picked, radius: 25, includeRemote: true })
          } else {
            setText(next)
          }
        }}
      />
      <datalist id={listId}>
        {options.map(o => (
          <option key={o.key} value={o.label} />
        ))}
      </datalist>
    </label>
  )
}
