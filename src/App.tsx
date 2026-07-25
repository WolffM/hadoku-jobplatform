import React, { useCallback, useRef, useState } from 'react'
import {
  HashRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams
} from 'react-router-dom'
import { AppHeader, ConnectedThemePicker, LoadingSkeleton } from '@wolffm/task-ui-components'
import { THEME_ICON_MAP } from '@wolffm/themes'
import { useTheme } from './hooks/useTheme'
import { ProfileSidebar } from './components/ProfileSidebar'
import { ProfileEditorModal } from './components/ProfileEditorModal'
import { JobsList } from './components/JobsList'
import { JobDrawer } from './components/JobDrawer'
import type { Auth } from './api/auth'
import type { JobProfile } from './api/profiles'
import type { JobPlatformProps } from './entry'

type EditorState = { mode: 'new' } | { mode: 'edit'; profile: JobProfile }

interface DashboardOutletCtx {
  onJobStateChanged: () => void
}

export default function App(props: JobPlatformProps = {}) {
  const containerRef = useRef<HTMLElement>(null)

  // Bundle the auth credentials once at the root, then thread the same
  // object through every component.
  const auth: Auth = { sessionId: props.sessionId }

  const [systemPrefersDark] = useState(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  const { theme, setTheme, isDarkTheme, isThemeReady, isInitialThemeLoad, THEME_FAMILIES } =
    useTheme({
      propsTheme: props.theme,
      experimentalThemes: false,
      containerRef
    })

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
          <AppHeader
            title="Job Platform"
            themePicker={
              <ConnectedThemePicker
                themeFamilies={THEME_FAMILIES}
                currentTheme={theme}
                onThemeChange={setTheme}
                getThemeIcon={(themeName: string) => {
                  const Icon = THEME_ICON_MAP[themeName as keyof typeof THEME_ICON_MAP]
                  return Icon ? <Icon /> : null
                }}
              />
            }
          />

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

  // Full-screen profile editor (create/edit) + a reload token that re-fetches
  // the sidebar list after a save.
  const [editing, setEditing] = useState<EditorState | null>(null)
  const [profilesReload, setProfilesReload] = useState(0)

  const ctx: DashboardOutletCtx = { onJobStateChanged }

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
          onSelect={jobId => {
            const params = profileId ? `?profile=${encodeURIComponent(profileId)}` : ''
            void navigate(`/jobs/${encodeURIComponent(jobId)}${params}`)
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
  const ctx = useOutletContext<DashboardOutletCtx>()

  if (!jobId) return null

  const closeDrawer = () => {
    const params = profileId ? `?profile=${encodeURIComponent(profileId)}` : ''
    void navigate(`/${params}`)
  }

  return (
    <JobDrawer
      auth={auth}
      jobId={jobId}
      profileId={profileId}
      onClose={closeDrawer}
      onStateChange={() => ctx.onJobStateChanged()}
    />
  )
}
