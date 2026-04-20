import { useEffect, useState } from 'react'
import { getJob, JobsApiError, type JobDetail, type ScoreBreakdown } from '../api/jobs'

interface Props {
  apiKey?: string
  jobId: string
  profileId: string | null
  onClose: () => void
}

const BREAKDOWN_LABELS: Record<keyof ScoreBreakdown, string> = {
  title_match: 'Title',
  keyword_match: 'Keywords',
  company_boost: 'Company',
  seniority_match: 'Seniority',
  remote_match: 'Remote',
  salary_match: 'Salary'
}

export function JobDrawer({ apiKey, jobId, profileId, onClose }: Props) {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setJob(null)
    getJob(jobId, profileId ?? undefined, apiKey)
      .then(result => {
        if (!cancelled) setJob(result)
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof JobsApiError ? err.message : 'Failed to load job')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [apiKey, jobId, profileId])

  // Esc closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <>
      <div className="jp-drawer-backdrop" onClick={onClose} />
      <aside className="jp-drawer" role="dialog" aria-labelledby="jp-drawer-title">
        <div className="jp-drawer__header">
          <button type="button" className="jp-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {loading && <p className="jp-muted">Loading…</p>}
        {error && <p className="jp-error">{error}</p>}

        {job && (
          <>
            <h2 id="jp-drawer-title" className="jp-drawer__title">
              {job.title}
            </h2>
            <p className="jp-drawer__company">
              {job.company} · {job.location || 'location unknown'}
              {job.workplace_type && job.workplace_type !== 'unknown' && ` · ${job.workplace_type}`}
            </p>

            <div className="jp-drawer__facts">
              <span>{job.source_site}</span>
              {job.job_type && job.job_type !== 'unknown' && <span>{job.job_type}</span>}
              {(job.salary_min || job.salary_max) && (
                <span>
                  ${job.salary_min ?? '?'} – ${job.salary_max ?? '?'}
                </span>
              )}
              {job.posted_date && <span>Posted {job.posted_date}</span>}
            </div>

            {profileId && (
              <section className="jp-drawer__section">
                <h3>Score breakdown</h3>
                <div className="jp-drawer__score-total">
                  Total: <strong>{job.score.toFixed(2)}</strong>
                </div>
                <ul className="jp-drawer__breakdown">
                  {(Object.keys(BREAKDOWN_LABELS) as (keyof ScoreBreakdown)[]).map(key => (
                    <li key={key}>
                      <span className="jp-drawer__breakdown-label">{BREAKDOWN_LABELS[key]}</span>
                      <div className="jp-drawer__breakdown-bar">
                        <div
                          className="jp-drawer__breakdown-fill"
                          style={{ width: `${Math.min(100, job.score_breakdown[key] * 100)}%` }}
                        />
                      </div>
                      <span className="jp-drawer__breakdown-value">
                        {job.score_breakdown[key].toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="jp-drawer__section">
              <h3>Description</h3>
              <div
                className="jp-drawer__description"
                // Greenhouse/Lever descriptions are typically HTML; render as-is
                // since the source is our trusted ingest pipeline.
                dangerouslySetInnerHTML={{ __html: job.description || '<em>No description</em>' }}
              />
            </section>

            <section className="jp-drawer__section">
              <h3>Actions</h3>
              <div className="jp-drawer__actions">
                <a
                  className="jp-drawer__cta jp-drawer__cta--primary"
                  href={job.application_url ?? job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Apply on {job.source_site}
                </a>
                <button type="button" disabled className="jp-drawer__cta">
                  Mark interested (V2)
                </button>
                <button type="button" disabled className="jp-drawer__cta">
                  Dismiss (V2)
                </button>
                <button type="button" disabled className="jp-drawer__cta">
                  Generate resume (V3)
                </button>
              </div>
            </section>
          </>
        )}
      </aside>
    </>
  )
}
