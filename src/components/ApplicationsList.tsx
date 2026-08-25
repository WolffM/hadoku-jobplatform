import { useCallback, useEffect, useState } from 'react'
import {
  approveApplication,
  listApplications,
  JobsApiError,
  type ApplicationStatus,
  type ApplicationSummary
} from '../api/jobs'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
}

/** What each status means to the person reading the list. */
const STATUS_COPY: Record<ApplicationStatus, string> = {
  queued: 'waiting for the runner',
  filled: 'filled — review the screenshot, then approve',
  approved: 'approved — the runner will submit it',
  submitted: 'submitted',
  needs_manual: 'needs you: the runner stopped rather than guess',
  failed: 'failed'
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** The screenshot the runner stored for this row, if it left one. */
function evidenceShot(app: ApplicationSummary): string | null {
  const shot = app.evidence?.screenshot
  return typeof shot === 'string' && shot ? shot : null
}

/**
 * The Applications view: the approve-to-apply queue (issue #15).
 *
 * This is a workflow, not a reference list — the one action it offers is
 * Approve, and only on `filled` rows. That is the review-mode contract: the
 * runner fills the form and stops with a screenshot, and nothing reaches an
 * employer until a human has looked at that screenshot and said yes here.
 */
export function ApplicationsList({ auth }: Props) {
  const [apps, setApps] = useState<ApplicationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [approving, setApproving] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    listApplications(undefined, auth)
      .then(setApps)
      .catch((err: unknown) => {
        if (err instanceof JobsApiError && err.status === 403) setNeedsAuth(true)
        else setError(err instanceof JobsApiError ? err.message : 'Failed to load applications')
      })
      .finally(() => setLoading(false))
  }, [auth])

  useEffect(load, [load])

  async function handleApprove(app: ApplicationSummary) {
    setApproving(app.id)
    setError(null)
    try {
      const updated = await approveApplication(app.id, auth)
      setApps(rows => rows.map(r => (r.id === updated.id ? updated : r)))
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to approve')
    } finally {
      setApproving(null)
    }
  }

  if (needsAuth) return <p className="jp-muted">Sign in to see your applications.</p>
  if (loading) return <p className="jp-muted">Loading applications…</p>
  if (!apps.length) {
    return (
      <p className="jp-muted">
        No applications queued. Open a job, prepare its application, then hit Apply.
      </p>
    )
  }

  return (
    <div className="jp-applications">
      {error && <p className="jp-error">{error}</p>}
      <ul className="jp-applications__list">
        {apps.map(app => {
          const shot = evidenceShot(app)
          return (
            <li key={app.id} className={`jp-applications__row jp-applications__row--${app.status}`}>
              <div className="jp-applications__head">
                <span className="jp-applications__title">{app.title}</span>
                <span className="jp-applications__company">{app.company}</span>
                <span className={`jp-applications__status jp-applications__status--${app.status}`}>
                  {app.status}
                </span>
              </div>
              <p className="jp-applications__meta">
                {STATUS_COPY[app.status]} · {app.mode} mode · updated {formatWhen(app.updated_at)}
              </p>
              {app.error && <p className="jp-error">{app.error}</p>}
              {shot && (
                <p className="jp-applications__evidence">
                  Runner screenshot: <code>{shot}</code>
                </p>
              )}
              {app.status === 'filled' && (
                <button
                  type="button"
                  className="jp-drawer__cta jp-drawer__cta--primary"
                  onClick={() => void handleApprove(app)}
                  disabled={approving === app.id}
                >
                  {approving === app.id ? 'Approving…' : 'Approve and submit'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
