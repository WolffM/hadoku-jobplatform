import { useEffect, useState } from 'react'
import { listProfiles, deleteProfile, ProfilesApiError, type JobProfile } from '../api/profiles'
import type { Auth } from '../api/auth'
import { invalidateResource } from '../api/resource'
import { useResource } from '../api/useResource'

/**
 * Where "Sign in" sends an anonymous visitor.
 *
 * edge-router's /auth takes a `return` param and bounces back to it after a
 * successful sign-in, so this brings the user back to the app rather than to
 * the site root. The app mounts under /jobplatform/ and keeps its own state in
 * the hash, which `location.hash` preserves.
 */
function signInHref(): string {
  const here = window.location.pathname + window.location.search + window.location.hash
  return `/auth?return=${encodeURIComponent(here)}`
}

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
  /**
   * Fired once the profile list has settled, with how many profiles there are
   * — including for a signed-out visitor, where there is nothing to fetch and
   * the count is 0. The dashboard holds the feed's request while a selection is
   * still coming, so it never asks for an unscored feed it is about to replace
   * with a scored one; a count of 0 means no selection is coming.
   */
  onResolved?: (count: number) => void
}

export function ProfileSidebar({
  auth,
  selectedId,
  onSelect,
  onNew,
  onEdit,
  reloadKey,
  onResolved
}: Props) {
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Profiles are per-user and the API gates /profiles at friend tier, so an
  // anonymous visitor can only ever get a 403 here. The feed itself is public,
  // so we skip the call rather than firing a request whose only outcome is a
  // console error and an error string in the sidebar.
  //
  // This reads the sessionId the shell already handed us — it is not a whoami
  // pre-flight, which is exactly what JobsList avoids.
  const isAuthed = Boolean(auth.sessionId)

  const {
    data,
    loading,
    error: loadError,
    reload
  } = useResource(`profiles:${reloadKey ?? 0}`, () => listProfiles(auth), { enabled: isAuthed })

  const profiles = data ?? []
  const error =
    deleteError ??
    (loadError
      ? loadError instanceof ProfilesApiError
        ? loadError.message
        : 'Failed to load profiles'
      : null)

  // Settled = we have an answer, or there was never a question to ask.
  const resolved = !isAuthed || !loading
  useEffect(() => {
    if (resolved) onResolved?.(profiles.length)
  }, [resolved, profiles.length, onResolved])

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
    setDeleteError(null)
    try {
      await deleteProfile(p.id, auth)
      invalidateResource('profiles:')
      reload()
    } catch (err) {
      setDeleteError(err instanceof ProfilesApiError ? err.message : 'Failed to delete profile')
    }
  }

  if (!isAuthed) {
    return (
      <aside className="jp-sidebar">
        <div className="jp-sidebar__header">
          <h2>Profiles</h2>
        </div>
        <p className="jp-muted">
          The feed to the right is the whole public corpus, newest first. Sign in to rank it against
          your own profile — keywords, IC or manager track, level and remote preference — and to
          track which jobs you’ve looked at.
        </p>
        <a className="jp-sidebar__signin" href={signInHref()}>
          Sign in
        </a>
      </aside>
    )
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
