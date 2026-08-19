import React, { useCallback, useRef, useState, type RefObject } from 'react'
import {
  HashRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams
} from 'react-router-dom'
import { AppHeader, LoadingSkeleton } from '@wolffm/task-ui-components'
import { useHadokuTheme, HadokuThemeRoot } from '@wolffm/themes'
import { ProfileSidebar } from './components/ProfileSidebar'
import { ProfileEditorModal } from './components/ProfileEditorModal'
import { JobsList } from './components/JobsList'
import { JobDrawer } from './components/JobDrawer'
import type { Auth } from './api/auth'
import type { VoteValue } from './api/jobs'
import type { JobProfile } from './api/profiles'
import type { JobPlatformProps } from './entry'

type EditorState = { mode: 'new' } | { mode: 'edit'; profile: JobProfile }

interface DashboardOutletCtx {
  onJobStateChanged: () => void
  onJobVoted: (jobId: string, vote: VoteValue | null) => void
}

/**
 * Provider boundary. Theme state belongs to the platform (@wolffm/themes),
 * not to this app — the local hooks/useTheme.ts, prefs/themePrefs.ts and
 * app/themeConfig.tsx copies are gone. AppHeader renders the shared picker
 * from this context, so nothing below passes one.
 */
export default function App(props: JobPlatformProps = {}) {
  const containerRef = useRef<HTMLElement>(null)
  return (
    <HadokuThemeRoot theme={props.theme} containerRef={containerRef}>
      <AppInner {...props} containerRef={containerRef} />
    </HadokuThemeRoot>
  )
}

function AppInner(props: JobPlatformProps & { containerRef: RefObject<HTMLElement | null> }) {
  const { containerRef } = props

  // Bundle the auth credentials once at the root, then thread the same
  // object through every component.
  const auth: Auth = { sessionId: props.sessionId }

  const [systemPrefersDark] = useState(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  // Theme comes from <HadokuThemeRoot> above — one implementation for
  // every app, instead of this repo's former hooks/useTheme.ts copy.
  const { theme, isDarkTheme, isThemeReady, isInitialThemeLoad } = useHadokuTheme()

  if (isInitialThemeLoad && !isThemeReady) {
    return <LoadingSkeleton isDarkTheme={systemPrefersDark} />
  }

  return (
    <main
      ref={containerRef}
      className="job-platform-container"
      data-theme={theme}
      data-dark-theme={isDarkTheme ? 'true' : 'false'}
    >
      <HashRouter>
        <div className="job-platform">
          <AppHeader title="Job Platform" />

          <Routes>
            <Route element={<Dashboard auth={auth} />}>
              <Route index element={null} />
              <Route path="jobs/:jobId" element={<JobDrawerRoute auth={auth} />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </HashRouter>
    </main>
  )
}

function Dashboard({ auth }: { auth: Auth }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const profileId = searchParams.get('profile')
  const navigate = useNavigate()

  const setProfileId = useCallback(
    (id: string | null) => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev)
          if (id) next.set('profile', id)
          else next.delete('profile')
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  // Bump on every triage transition coming from the drawer so JobsList
  // re-fetches and reflects the new state in the cards + filter counts.
  const [refreshKey, setRefreshKey] = useState(0)
  const onJobStateChanged = useCallback(() => setRefreshKey(k => k + 1), [])

  // Votes deliberately do NOT refetch — re-ranking the feed mid-rip would
  // shuffle jobs under the user. Overrides shadow the fetched value until the
  // next natural reload, and both the cards and the drawer write through here
  // so the two stay in sync.
  const [voteOverrides, setVoteOverrides] = useState<Record<string, VoteValue | null>>({})
  const onJobVoted = useCallback((jobId: string, vote: VoteValue | null) => {
    setVoteOverrides(prev => ({ ...prev, [jobId]: vote }))
  }, [])

  // Full-screen profile editor (create/edit) + a reload token that re-fetches
  // the sidebar list after a save.
  const [editing, setEditing] = useState<EditorState | null>(null)
  const [profilesReload, setProfilesReload] = useState(0)

  const ctx: DashboardOutletCtx = { onJobStateChanged, onJobVoted }

  return (
    <div className="jp-dashboard">
      <ProfileSidebar
        auth={auth}
        selectedId={profileId}
        onSelect={setProfileId}
        onNew={() => setEditing({ mode: 'new' })}
        onEdit={profile => setEditing({ mode: 'edit', profile })}
        reloadKey={profilesReload}
      />
      <section className="jp-main">
        <JobsList
          auth={auth}
          profileId={profileId}
          refreshKey={refreshKey}
          voteOverrides={voteOverrides}
          onVote={onJobVoted}
          onSelect={(jobId, vote) => {
            const params = profileId ? `?profile=${encodeURIComponent(profileId)}` : ''
            // The detail endpoint doesn't return the vote, so the card hands
            // its current value to the drawer via navigation state.
            void navigate(`/jobs/${encodeURIComponent(jobId)}${params}`, { state: { vote } })
          }}
        />
      </section>
      <Outlet context={ctx} />
      {editing && (
        <ProfileEditorModal
          auth={auth}
          initial={editing.mode === 'edit' ? editing.profile : null}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setProfilesReload(k => k + 1)
            setProfileId(saved.id)
            // A saved profile's companies/criteria may change its feed.
            onJobStateChanged()
          }}
          onCompaniesChanged={onJobStateChanged}
        />
      )}
    </div>
  )
}

function JobDrawerRoute({ auth }: { auth: Auth }) {
  const { jobId } = useParams<{ jobId: string }>()
  const [searchParams] = useSearchParams()
  const profileId = searchParams.get('profile')
  const navigate = useNavigate()
  const location = useLocation()
  const ctx = useOutletContext<DashboardOutletCtx>()

  if (!jobId) return null

  // Seeded by the card that opened the drawer (the detail endpoint doesn't
  // return the vote). A deep link has no state → null → shown as unvoted.
  const initialVote = (location.state as { vote?: VoteValue | null } | null)?.vote ?? null

  const closeDrawer = () => {
    const params = profileId ? `?profile=${encodeURIComponent(profileId)}` : ''
    void navigate(`/${params}`)
  }

  return (
    <JobDrawer
      auth={auth}
      jobId={jobId}
      profileId={profileId}
      initialVote={initialVote}
      onClose={closeDrawer}
      onStateChange={() => ctx.onJobStateChanged()}
      onVoteChange={ctx.onJobVoted}
    />
  )
}
