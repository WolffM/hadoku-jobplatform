import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  listProfiles,
  createProfile,
  deleteProfile,
  ProfilesApiError,
  type JobProfile,
  type RemotePref
} from '../api/profiles'

interface Props {
  apiKey?: string
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export function ProfileSidebar({ apiKey, selectedId, onSelect }: Props) {
  const [profiles, setProfiles] = useState<JobProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listProfiles(apiKey)
      setProfiles(rows)
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to load profiles')
    } finally {
      setLoading(false)
    }
  }, [apiKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Keep selection in sync with available profiles: auto-pick first if none
  // selected, or clear selection if the selected one disappeared (e.g. after
  // deletion). Runs only after profiles load finishes.
  useEffect(() => {
    if (loading) return
    if (profiles.length === 0) {
      if (selectedId !== null) onSelect(null)
      return
    }
    if (!profiles.find(p => p.id === selectedId)) {
      onSelect(profiles[0].id)
    }
  }, [loading, profiles, selectedId, onSelect])

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this profile?')) return
    try {
      await deleteProfile(id, apiKey)
      await refresh()
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to delete profile')
    }
  }

  return (
    <aside className="jp-sidebar">
      <div className="jp-sidebar__header">
        <h2>Profiles</h2>
        <button type="button" className="jp-sidebar__new" onClick={() => setCreating(v => !v)}>
          {creating ? 'Cancel' : '+ New'}
        </button>
      </div>

      {creating && (
        <NewProfileForm
          apiKey={apiKey}
          onCreated={id => {
            setCreating(false)
            void refresh().then(() => onSelect(id))
          }}
          onError={setError}
        />
      )}

      {error && <p className="jp-error">{error}</p>}

      {loading ? (
        <p className="jp-muted">Loading…</p>
      ) : profiles.length === 0 ? (
        <p className="jp-muted">No profiles yet. Create one to start scoring jobs.</p>
      ) : (
        <ul className="jp-sidebar__list">
          {profiles.map(p => {
            const active = p.id === selectedId
            return (
              <li
                key={p.id}
                className={
                  active ? 'jp-sidebar__item jp-sidebar__item--active' : 'jp-sidebar__item'
                }
              >
                <button
                  type="button"
                  className="jp-sidebar__item-main"
                  onClick={() => onSelect(p.id)}
                >
                  <span className="jp-sidebar__item-name">{p.name}</span>
                  <span className="jp-sidebar__item-meta">
                    {p.keywords.length} kw · {p.remote_pref}
                  </span>
                </button>
                <button
                  type="button"
                  className="jp-sidebar__item-remove"
                  onClick={() => void handleDelete(p.id)}
                  aria-label={`Delete ${p.name}`}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}

interface NewProfileFormProps {
  apiKey?: string
  onCreated: (id: string) => void
  onError: (msg: string) => void
}

function NewProfileForm({ apiKey, onCreated, onError }: NewProfileFormProps) {
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [targetCompanies, setTargetCompanies] = useState('')
  const [roleTypes, setRoleTypes] = useState('')
  const [remotePref, setRemotePref] = useState<RemotePref>('any')
  const [minSalary, setMinSalary] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const splitCsv = (s: string) =>
    s
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || submitting) return
    setSubmitting(true)
    try {
      const created = await createProfile(
        {
          name: name.trim(),
          keywords: splitCsv(keywords),
          target_companies: splitCsv(targetCompanies),
          role_types: splitCsv(roleTypes),
          min_salary: minSalary ? Number(minSalary) : null,
          remote_pref: remotePref,
          experience_levels: []
        },
        apiKey
      )
      onCreated(created.id)
    } catch (err) {
      onError(err instanceof ProfilesApiError ? err.message : 'Failed to create profile')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="jp-profile-form" onSubmit={e => void handleSubmit(e)}>
      <label>
        Name
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Senior SWE — AI/ML"
          required
        />
      </label>
      <label>
        Keywords
        <input
          type="text"
          value={keywords}
          onChange={e => setKeywords(e.target.value)}
          placeholder="python, llm, distributed systems"
        />
      </label>
      <label>
        Target companies
        <input
          type="text"
          value={targetCompanies}
          onChange={e => setTargetCompanies(e.target.value)}
          placeholder="anthropic, openai, mistral"
        />
      </label>
      <label>
        Role types
        <input
          type="text"
          value={roleTypes}
          onChange={e => setRoleTypes(e.target.value)}
          placeholder="senior, staff, principal"
        />
      </label>
      <label>
        Remote preference
        <select value={remotePref} onChange={e => setRemotePref(e.target.value as RemotePref)}>
          <option value="any">Any</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">Onsite</option>
        </select>
      </label>
      <label>
        Min salary
        <input
          type="number"
          value={minSalary}
          onChange={e => setMinSalary(e.target.value)}
          placeholder="(optional)"
        />
      </label>
      <button type="submit" disabled={submitting || !name.trim()}>
        {submitting ? 'Creating…' : 'Create profile'}
      </button>
    </form>
  )
}
