import { useCallback, useEffect, useState } from 'react'
import {
  approveApplication,
  listApplications,
  JobsApiError,
  type ApplicationStatus,
  type ApplicationSummary
} from '../api/jobs'
import type { Auth } from '../api/auth'
import { UnansweredQuestions } from './UnansweredQuestions'

interface Props {
  auth: Auth
}

/** What each status means to the person reading the list. */
const STATUS_COPY: Record<ApplicationStatus, string> = {
  queued: 'waiting for the runner',
  filled: 'filled — review the screenshot, then approve',
  approved: 'approved — the runner will submit it on its next run with --submit',
  submitted: 'submitted',
  needs_manual: 'needs you: the runner stopped rather than guess',
  failed: 'failed',
  job_closed: 'the posting was taken down before this could be sent'
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
 * The digest of the fill on screen — what an approval would actually bind to.
 *
 * A `filled` row without one cannot be approved: the runner would have nothing
 * to check its re-fill against and would send whatever a fresh LLM draft
 * produced, which is not what the screenshot shows.
 */
function fillDigest(app: ApplicationSummary): string | null {
  const fp = app.evidence?.fingerprint
  return typeof fp === 'string' && fp ? fp : null
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

  // The questions section sits ABOVE the queue and outside the empty-state
  // early return. An unanswered question is usually WHY the rows below are
  // stuck, so it is the thing to act on first — and with an empty queue it is
  // still the only way to reach saved answers.
  if (!apps.length) {
    return (
      <div className="jp-applications">
        <UnansweredQuestions auth={auth} />
        <p className="jp-muted">
          No applications queued. Open a job, prepare its application, then hit Apply.
        </p>
      </div>
    )
  }

  return (
    <div className="jp-applications">
      <UnansweredQuestions auth={auth} />
      {error && <p className="jp-error">{error}</p>}
      <ul className="jp-applications__list">
        {apps.map(app => {
          const shot = evidenceShot(app)
          const digest = fillDigest(app) ?? app.approved_fingerprint
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
              {digest && (
                <p className="jp-applications__evidence">
                  {app.approved_fingerprint ? 'Approved fill' : 'This fill'}:{' '}
                  <code>{digest.slice(0, 12)}</code>
                </p>
              )}
              {app.status === 'filled' &&
                (digest ? (
                  <button
                    type="button"
                    className="jp-drawer__cta jp-drawer__cta--primary"
                    onClick={() => void handleApprove(app)}
                    disabled={approving === app.id}
                  >
                    {approving === app.id ? 'Approving…' : 'Approve for submission'}
                  </button>
                ) : (
                  <p className="jp-muted">
                    Filled by a runner that did not record what it filled, so there is nothing to
                    approve against. Re-run the fill.
                  </p>
                ))}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
