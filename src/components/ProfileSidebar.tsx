import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  ProfilesApiError,
  type JobProfile,
  type ProfileInput,
  type RemotePref
} from '../api/profiles'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export function ProfileSidebar({ auth, selectedId, onSelect }: Props) {
  const [profiles, setProfiles] = useState<JobProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listProfiles(auth)
      setProfiles(rows)
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to load profiles')
    } finally {
      setLoading(false)
    }
  }, [auth])

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

  const handleDelete = async (p: JobProfile) => {
    const msg = p.is_default
      ? 'Hide the default profile? It won’t come back (your edits/deletion are remembered).'
      : 'Delete this profile?'
    if (!window.confirm(msg)) return
    try {
      await deleteProfile(p.id, auth)
      if (editingId === p.id) setEditingId(null)
      await refresh()
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to delete profile')
    }
  }

  return (
    <aside className="jp-sidebar">
      <div className="jp-sidebar__header">
        <h2>Profiles</h2>
        <button
          type="button"
          className="jp-sidebar__new"
          onClick={() => {
            setEditingId(null)
            setCreating(v => !v)
          }}
        >
          {creating ? 'Cancel' : '+ New'}
        </button>
      </div>

      {creating && (
        <ProfileForm
          auth={auth}
          submitLabel="Create profile"
          onSaved={id => {
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
            const isEditing = editingId === p.id
            return (
              <li
                key={p.id}
                className={
                  active ? 'jp-sidebar__item jp-sidebar__item--active' : 'jp-sidebar__item'
                }
              >
                {isEditing ? (
                  <ProfileForm
                    auth={auth}
                    initial={p}
                    submitLabel="Save changes"
                    onSaved={() => {
                      setEditingId(null)
                      void refresh()
                    }}
                    onCancel={() => setEditingId(null)}
                    onError={setError}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="jp-sidebar__item-main"
                      onClick={() => onSelect(p.id)}
                    >
                      <span className="jp-sidebar__item-name">
                        {p.name}
                        {p.is_default && <span className="jp-sidebar__badge">default</span>}
                      </span>
                      <span className="jp-sidebar__item-meta">
                        {p.keywords.length} kw · {p.remote_pref}
                      </span>
                    </button>
                    <div className="jp-sidebar__item-actions">
                      <button
                        type="button"
                        className="jp-sidebar__item-edit"
                        onClick={() => {
                          setCreating(false)
                          setEditingId(p.id)
                        }}
                        aria-label={`Edit ${p.name}`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="jp-sidebar__item-remove"
                        onClick={() => void handleDelete(p)}
                        aria-label={p.is_default ? `Hide ${p.name}` : `Delete ${p.name}`}
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}

interface ProfileFormProps {
  auth: Auth
  initial?: JobProfile
  submitLabel: string
  onSaved: (id: string) => void
  onCancel?: () => void
  onError: (msg: string) => void
}

const joinCsv = (xs: string[]) => xs.join(', ')
const splitCsv = (s: string) =>
  s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

function ProfileForm({ auth, initial, submitLabel, onSaved, onCancel, onError }: ProfileFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [keywords, setKeywords] = useState(initial ? joinCsv(initial.keywords) : '')
  const [targetCompanies, setTargetCompanies] = useState(
    initial ? joinCsv(initial.target_companies) : ''
  )
  const [roleTypes, setRoleTypes] = useState(initial ? joinCsv(initial.role_types) : '')
  const [remotePref, setRemotePref] = useState<RemotePref>(initial?.remote_pref ?? 'any')
  const [minSalary, setMinSalary] = useState(
    initial && initial.min_salary !== null ? String(initial.min_salary) : ''
  )
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || submitting) return
    setSubmitting(true)
    try {
      const input: ProfileInput = {
        name: name.trim(),
        keywords: splitCsv(keywords),
        target_companies: splitCsv(targetCompanies),
        role_types: splitCsv(roleTypes),
        min_salary: minSalary ? Number(minSalary) : null,
        remote_pref: remotePref,
        // Preserve experience_levels (not exposed in this form) across edits.
        experience_levels: initial?.experience_levels ?? []
      }
      const saved = initial
        ? await updateProfile(initial.id, input, auth)
        : await createProfile(input, auth)
      onSaved(saved.id)
    } catch (err) {
      onError(err instanceof ProfilesApiError ? err.message : 'Failed to save profile')
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
      <div className="jp-profile-form__actions">
        <button type="submit" disabled={submitting || !name.trim()}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="jp-profile-form__cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
