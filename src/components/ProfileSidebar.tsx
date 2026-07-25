import { useCallback, useEffect, useState } from 'react'
import { listProfiles, deleteProfile, ProfilesApiError, type JobProfile } from '../api/profiles'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Open the full-screen editor for a new profile. */
  onNew: () => void
  /** Open the full-screen editor for an existing profile. */
  onEdit: (profile: JobProfile) => void
  /** Bumped by the parent after a save so the list refetches. */
  reloadKey?: number
}

export function ProfileSidebar({ auth, selectedId, onSelect, onNew, onEdit, reloadKey }: Props) {
  const [profiles, setProfiles] = useState<JobProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setProfiles(await listProfiles(auth))
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to load profiles')
    } finally {
      setLoading(false)
    }
  }, [auth])

  useEffect(() => {
    void refresh()
  }, [refresh, reloadKey])

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
      await refresh()
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to delete profile')
    }
  }

  return (
    <aside className="jp-sidebar">
      <div className="jp-sidebar__header">
        <h2>Profiles</h2>
        <button type="button" className="jp-sidebar__new" onClick={onNew}>
          + New
        </button>
      </div>

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
                    onClick={() => onEdit(p)}
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
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
