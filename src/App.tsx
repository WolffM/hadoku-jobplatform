import React, { useCallback, useRef, useState } from 'react'
import {
  HashRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams
} from 'react-router-dom'
import { ConnectedThemePicker, LoadingSkeleton } from '@wolffm/task-ui-components'
import { THEME_ICON_MAP } from '@wolffm/themes'
import { useTheme } from './hooks/useTheme'
import { CompaniesManager } from './components/CompaniesManager'
import { ProfileSidebar } from './components/ProfileSidebar'
import { JobsList } from './components/JobsList'
import { JobDrawer } from './components/JobDrawer'
import type { JobPlatformProps } from './entry'

export default function App(props: JobPlatformProps = {}) {
  const containerRef = useRef<HTMLElement>(null)

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
          <header className="job-platform__header">
            <h1>Job Platform</h1>
            <nav className="job-platform__nav">
              <NavLink to="/" end>
                Jobs
              </NavLink>
              <NavLink to="/companies">Companies</NavLink>
            </nav>
            <ConnectedThemePicker
              themeFamilies={THEME_FAMILIES}
              currentTheme={theme}
              onThemeChange={setTheme}
              getThemeIcon={(themeName: string) => {
                const Icon = THEME_ICON_MAP[themeName as keyof typeof THEME_ICON_MAP]
                return Icon ? <Icon /> : null
              }}
            />
          </header>

          <Routes>
            <Route element={<Dashboard apiKey={props.apiKey} />}>
              <Route index element={null} />
              <Route path="jobs/:jobId" element={<JobDrawerRoute apiKey={props.apiKey} />} />
            </Route>
            <Route path="/companies" element={<CompaniesPage apiKey={props.apiKey} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </HashRouter>
    </main>
  )
}

function Dashboard({ apiKey }: { apiKey?: string }) {
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

  return (
    <div className="jp-dashboard">
      <ProfileSidebar apiKey={apiKey} selectedId={profileId} onSelect={setProfileId} />
      <section className="jp-main">
        <JobsList
          apiKey={apiKey}
          profileId={profileId}
          onSelect={jobId => {
            const params = profileId ? `?profile=${encodeURIComponent(profileId)}` : ''
            void navigate(`/jobs/${encodeURIComponent(jobId)}${params}`)
          }}
        />
      </section>
      <Outlet />
    </div>
  )
}

function JobDrawerRoute({ apiKey }: { apiKey?: string }) {
  const { jobId } = useParams<{ jobId: string }>()
  const [searchParams] = useSearchParams()
  const profileId = searchParams.get('profile')
  const navigate = useNavigate()

  if (!jobId) return null

  const closeDrawer = () => {
    const params = profileId ? `?profile=${encodeURIComponent(profileId)}` : ''
    void navigate(`/${params}`)
  }

  return <JobDrawer apiKey={apiKey} jobId={jobId} profileId={profileId} onClose={closeDrawer} />
}

function CompaniesPage({ apiKey }: { apiKey?: string }) {
  return (
    <section className="job-platform__content">
      <p className="jp-companies-intro">
        <Link to="/">← Back to jobs</Link>
      </p>
      <CompaniesManager apiKey={apiKey} />
    </section>
  )
}
