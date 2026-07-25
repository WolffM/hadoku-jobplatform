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
  type JobProfile,
  type ProfileInput,
  type RemotePref
} from '../api/profiles'
import { preflightCount } from '../api/jobs'
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

// The seniority buckets the scoring engine understands. Free-text role names
// don't score, so this is a fixed picker rather than a text box.
const ROLE_OPTIONS = ['senior', 'staff', 'principal', 'lead', 'manager', 'director'] as const

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
  const [roleTypes, setRoleTypes] = useState<string[]>(
    (initial?.role_types ?? []).filter(r => (ROLE_OPTIONS as readonly string[]).includes(r))
  )
  const [remotePref, setRemotePref] = useState<RemotePref>(initial?.remote_pref ?? 'any')
  const [minSalary, setMinSalary] = useState(
    initial && initial.min_salary !== null ? String(initial.min_salary) : ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  const [kwCounts, setKwCounts] = useState<Record<string, Count>>({})
  const [roleCounts, setRoleCounts] = useState<Record<string, Count>>({})

  // Probe a keyword / role against the live corpus and stash the count.
  const probeKeyword = useCallback(
    async (kw: string) => {
      setKwCounts(prev => ({ ...prev, [kw]: 'loading' }))
      try {
        const n = await preflightCount({ keyword: kw }, auth)
        setKwCounts(prev => ({ ...prev, [kw]: n }))
      } catch {
        setKwCounts(prev => ({ ...prev, [kw]: null }))
      }
    },
    [auth]
  )
  const probeRole = useCallback(
    async (rt: string) => {
      setRoleCounts(prev => ({ ...prev, [rt]: 'loading' }))
      try {
        const n = await preflightCount({ role_type: rt }, auth)
        setRoleCounts(prev => ({ ...prev, [rt]: n }))
      } catch {
        setRoleCounts(prev => ({ ...prev, [rt]: null }))
      }
    },
    [auth]
  )

  // Probe any keywords/roles the profile already has, once on open.
  const probedOnce = useRef(false)
  useEffect(() => {
    if (probedOnce.current) return
    probedOnce.current = true
    for (const kw of keywords) void probeKeyword(kw)
    for (const rt of roleTypes) void probeRole(rt)
  }, [keywords, roleTypes, probeKeyword, probeRole])

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
  const toggleRole = (r: string) =>
    setRoleTypes(prev => {
      if (prev.includes(r)) return prev.filter(x => x !== r)
      if (roleCounts[r] === undefined) void probeRole(r)
      return [...prev, r]
    })

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
      role_types: roleTypes,
      min_salary: minSalary ? Number(minSalary) : null,
      remote_pref: remotePref,
      experience_levels: initial?.experience_levels ?? []
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
            <span className="jp-editor__field-label">Role types</span>
            <div className="jp-role-picker">
              {ROLE_OPTIONS.map(r => {
                const on = roleTypes.includes(r)
                return (
                  <button
                    type="button"
                    key={r}
                    className={on ? 'jp-role-opt jp-role-opt--on' : 'jp-role-opt'}
                    onClick={() => toggleRole(r)}
                    aria-pressed={on}
                  >
                    {r}
                    {on && <CountBadge count={roleCounts[r] ?? null} />}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="jp-editor__section jp-editor__section--split">
            <div>
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
            </div>
            <div>
              <label className="jp-editor__field-label" htmlFor="jp-editor-salary">
                Min salary
              </label>
              <input
                id="jp-editor-salary"
                type="number"
                className="jp-editor__text"
                value={minSalary}
                onChange={e => setMinSalary(e.target.value)}
                placeholder="(optional)"
              />
            </div>
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
