import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import {
  createProfile,
  updateProfile,
  ProfilesApiError,
  IC_LEVELS,
  MANAGER_LEVELS,
  LEVEL_LABELS,
  type JobProfile,
  type ProfileInput,
  type ProfileTrack,
  type RemotePref,
  type RoleLevel
} from '../api/profiles'
import { preflightCount } from '../api/jobs'
import { fetchResource } from '../api/resource'

// Corpus counts only move when the scraper ingests, which is daily — so a
// probe answer is good for the whole editing session. Without this the counts
// go stale after 30s and reopening the editor re-runs every full-table scan.
const PROBE_MAX_AGE_MS = 15 * 60_000
import type { Auth } from '../api/auth'
import { CompaniesManager } from './CompaniesManager'

interface Props {
  auth: Auth
  /** null/undefined = create a new profile. */
  initial?: JobProfile | null
  onClose: () => void
  /** Called after every persist (create or update) so the parent can refresh. */
  onSaved: (profile: JobProfile) => void
  /** Bumped-through to the feed so it refetches when companies change. */
  onCompaniesChanged?: () => void
}

const TRACK_OPTIONS: { value: ProfileTrack; label: string; hint: string }[] = [
  { value: 'either', label: 'Either', hint: 'No constraint — both tracks in the feed' },
  { value: 'ic', label: 'IC', hint: 'No direct reports' },
  { value: 'manager', label: 'Manager', hint: 'Has direct reports' }
]

// Which ladder's rungs to offer. 'either' shows both — you can want Staff OR
// Director, you just can't want a rung that belongs to neither ladder.
function levelsForTrack(track: ProfileTrack): readonly RoleLevel[] {
  if (track === 'ic') return IC_LEVELS
  if (track === 'manager') return MANAGER_LEVELS
  return [...IC_LEVELS, ...MANAGER_LEVELS]
}

// A live corpus count for one probe input, or a loading/absent sentinel.
type Count = number | 'loading' | null

function CountBadge({ count }: { count: Count }) {
  if (count === null) return null
  if (count === 'loading')
    return <span className="jp-editor__count jp-editor__count--loading">…</span>
  const cls = count === 0 ? 'jp-editor__count jp-editor__count--zero' : 'jp-editor__count'
  return (
    <span className={cls}>
      {count} job{count === 1 ? '' : 's'}
    </span>
  )
}

export function ProfileEditorModal({ auth, initial, onClose, onSaved, onCompaniesChanged }: Props) {
  const [pid, setPid] = useState<string | null>(initial?.id ?? null)
  const [name, setName] = useState(initial?.name ?? '')
  const [keywords, setKeywords] = useState<string[]>(initial?.keywords ?? [])
  const [kwInput, setKwInput] = useState('')
  const [track, setTrack] = useState<ProfileTrack>(initial?.track ?? 'either')
  const [levels, setLevels] = useState<RoleLevel[]>(initial?.levels ?? [])
  const [remotePref, setRemotePref] = useState<RemotePref>(initial?.remote_pref ?? 'any')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  const [kwCounts, setKwCounts] = useState<Record<string, Count>>({})
  const [levelCounts, setLevelCounts] = useState<Record<string, Count>>({})
  const [trackCount, setTrackCount] = useState<Count>(null)

  // Probe a keyword / role against the live corpus and stash the count.
  //
  // Each probe is a full scan — the keyword one runs LIKE over every
  // description in the corpus — and opening this editor fires one per keyword
  // and level at once. Routing them through the resource cache means a repeat
  // probe of the same term is free, and two components asking at the same
  // moment share one request instead of racing two identical scans.
  const probeKeyword = useCallback(
    async (kw: string) => {
      setKwCounts(prev => ({ ...prev, [kw]: 'loading' }))
      try {
        const n = await fetchResource(
          `preflight:kw:${kw}`,
          () => preflightCount({ keyword: kw }, auth),
          { maxAgeMs: PROBE_MAX_AGE_MS }
        )
        setKwCounts(prev => ({ ...prev, [kw]: n }))
      } catch {
        setKwCounts(prev => ({ ...prev, [kw]: null }))
      }
    },
    [auth]
  )
  const probeLevel = useCallback(
    async (lvl: RoleLevel) => {
      setLevelCounts(prev => ({ ...prev, [lvl]: 'loading' }))
      try {
        const n = await fetchResource(
          `preflight:level:${lvl}`,
          () => preflightCount({ level: lvl }, auth),
          { maxAgeMs: PROBE_MAX_AGE_MS }
        )
        setLevelCounts(prev => ({ ...prev, [lvl]: n }))
      } catch {
        setLevelCounts(prev => ({ ...prev, [lvl]: null }))
      }
    },
    [auth]
  )

  // Probe any keywords/levels the profile already has, once on open.
  const probedOnce = useRef(false)
  useEffect(() => {
    if (probedOnce.current) return
    probedOnce.current = true
    for (const kw of keywords) void probeKeyword(kw)
    for (const lvl of levels) void probeLevel(lvl)
  }, [keywords, levels, probeKeyword, probeLevel])

  // Track is a hard filter, so its count is the ceiling on the whole feed —
  // worth showing live as the choice changes, unlike the per-level counts.
  useEffect(() => {
    if (track === 'either') {
      setTrackCount(null)
      return
    }
    let stale = false
    setTrackCount('loading')
    fetchResource(`preflight:track:${track}`, () => preflightCount({ track }, auth), {
      maxAgeMs: PROBE_MAX_AGE_MS
    })
      .then(n => !stale && setTrackCount(n))
      .catch(() => !stale && setTrackCount(null))
    return () => {
      stale = true
    }
  }, [track, auth])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addKeywords = (raw: string) => {
    const parts = raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    setKeywords(prev => {
      const seen = new Set(prev.map(k => k.toLowerCase()))
      const next = [...prev]
      for (const p of parts) {
        if (!seen.has(p.toLowerCase())) {
          seen.add(p.toLowerCase())
          next.push(p)
          void probeKeyword(p)
        }
      }
      return next
    })
    setKwInput('')
  }
  const onKwKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addKeywords(kwInput)
    } else if (e.key === 'Backspace' && !kwInput && keywords.length) {
      setKeywords(prev => prev.slice(0, -1))
    }
  }
  const removeKeyword = (kw: string) => setKeywords(prev => prev.filter(x => x !== kw))

  const toggleLevel = (lvl: RoleLevel) =>
    setLevels(prev => {
      if (prev.includes(lvl)) return prev.filter(x => x !== lvl)
      if (levelCounts[lvl] === undefined) void probeLevel(lvl)
      return [...prev, lvl]
    })

  // Narrowing the track drops any selected rungs from the other ladder — they'd
  // be unreachable behind the hard filter and would silently score nothing.
  const changeTrack = (next: ProfileTrack) => {
    setTrack(next)
    const allowed = levelsForTrack(next)
    setLevels(prev => prev.filter(l => (allowed as readonly string[]).includes(l)))
  }

  const buildInput = (): ProfileInput => {
    const pending = kwInput.trim()
      ? [
          ...keywords,
          ...kwInput
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        ]
      : keywords
    return {
      name: name.trim(),
      keywords: pending,
      track,
      levels,
      remote_pref: remotePref
    }
  }

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const input = buildInput()
      if (pid) {
        const saved = await updateProfile(pid, input, auth)
        onSaved(saved)
        onClose()
      } else {
        // Create, then stay open so companies can be added to the new profile.
        const created = await createProfile(input, auth)
        setPid(created.id)
        setKeywords(created.keywords)
        onSaved(created)
        setJustSaved(true)
      }
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  const onBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="jp-editor-backdrop" onClick={onBackdrop}>
      <div
        className="jp-editor"
        role="dialog"
        aria-modal="true"
        aria-label={pid ? 'Edit profile' : 'New profile'}
      >
        <div className="jp-editor__header">
          <h2 className="jp-editor__title">{initial ? 'Edit profile' : 'New profile'}</h2>
          <button
            type="button"
            className="jp-editor__close"
            onClick={onClose}
            aria-label="Close editor"
          >
            ×
          </button>
        </div>

        <div className="jp-editor__body">
          <section className="jp-editor__section">
            <label className="jp-editor__field-label" htmlFor="jp-editor-name">
              Name
            </label>
            <input
              id="jp-editor-name"
              type="text"
              className="jp-editor__text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Senior SWE — AI/ML"
            />
          </section>

          <section className="jp-editor__section">
            <div className="jp-editor__section-head">
              <span className="jp-editor__field-label">Keywords</span>
              <span className="jp-editor__hint">
                Each keyword is scraped and scored — the count is live corpus matches.
              </span>
            </div>
            <div className="jp-chips">
              {keywords.map(k => (
                <span key={k} className="jp-chip">
                  {k}
                  <CountBadge count={kwCounts[k] ?? null} />
                  <button type="button" onClick={() => removeKeyword(k)} aria-label={`Remove ${k}`}>
                    ×
                  </button>
                </span>
              ))}
              <input
                className="jp-chips__input"
                value={kwInput}
                onChange={e => setKwInput(e.target.value)}
                onKeyDown={onKwKey}
                onBlur={() => addKeywords(kwInput)}
                placeholder={keywords.length ? 'Add…' : 'python, llm, distributed systems'}
              />
            </div>
          </section>

          <section className="jp-editor__section">
            <div className="jp-editor__section-head">
              <span className="jp-editor__field-label">Track</span>
              <span className="jp-editor__hint">
                Does the role have direct reports? A hard filter — jobs on the other track don’t
                appear in this profile’s feed at all.
              </span>
            </div>
            <div className="jp-role-picker" role="radiogroup" aria-label="Track">
              {TRACK_OPTIONS.map(opt => {
                const on = track === opt.value
                return (
                  <button
                    type="button"
                    key={opt.value}
                    role="radio"
                    aria-checked={on}
                    title={opt.hint}
                    className={on ? 'jp-role-opt jp-role-opt--on' : 'jp-role-opt'}
                    onClick={() => changeTrack(opt.value)}
                  >
                    {opt.label}
                    {on && opt.value !== 'either' && <CountBadge count={trackCount} />}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="jp-editor__section">
            <div className="jp-editor__section-head">
              <span className="jp-editor__field-label">Levels</span>
              <span className="jp-editor__hint">
                Rungs on the ladder. Scored by distance — one rung off still counts, two doesn’t.
                Pick none to ignore level entirely.
              </span>
            </div>
            <div className="jp-role-picker">
              {levelsForTrack(track).map(lvl => {
                const on = levels.includes(lvl)
                return (
                  <button
                    type="button"
                    key={lvl}
                    className={on ? 'jp-role-opt jp-role-opt--on' : 'jp-role-opt'}
                    onClick={() => toggleLevel(lvl)}
                    aria-pressed={on}
                  >
                    {LEVEL_LABELS[lvl]}
                    {on && <CountBadge count={levelCounts[lvl] ?? null} />}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="jp-editor__section">
            <label className="jp-editor__field-label" htmlFor="jp-editor-remote">
              Remote preference
            </label>
            <select
              id="jp-editor-remote"
              className="jp-editor__text"
              value={remotePref}
              onChange={e => setRemotePref(e.target.value as RemotePref)}
            >
              <option value="any">Any</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">Onsite</option>
            </select>
          </section>

          <section className="jp-editor__section">
            <div className="jp-editor__section-head">
              <span className="jp-editor__field-label">Companies</span>
              <span className="jp-editor__hint">
                Optional. Empty = score the whole corpus; add companies to scope the feed.
              </span>
            </div>
            {pid ? (
              <CompaniesManager
                auth={auth}
                profileId={pid}
                onCompaniesChanged={onCompaniesChanged}
              />
            ) : (
              <p className="job-platform__companies-empty">
                Create the profile first (below), then add the companies it should track.
              </p>
            )}
          </section>
        </div>

        {error && <p className="jp-editor__error">{error}</p>}

        <div className="jp-editor__footer">
          {justSaved && !error && (
            <span className="jp-editor__saved">Saved — add companies above, or close.</span>
          )}
          <button type="button" className="jp-editor__cancel" onClick={onClose}>
            {pid ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="jp-editor__save"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving…' : pid ? 'Save changes' : 'Create profile'}
          </button>
        </div>
      </div>
    </div>
  )
}
