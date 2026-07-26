import { useEffect, useState } from 'react'
import {
  getJob,
  setJobState,
  generateResume,
  generateCoverLetter,
  mintPacketLink,
  JobsApiError,
  type JobDetail,
  type ScoreBreakdown,
  type JobStateRead,
  type JobStateWrite
} from '../api/jobs'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
  jobId: string
  profileId: string | null
  onClose: () => void
  onStateChange?: (jobId: string, newState: JobStateRead) => void
}

const BREAKDOWN_LABELS: Record<keyof ScoreBreakdown, string> = {
  title_match: 'Title',
  keyword_match: 'Keywords',
  seniority_match: 'Seniority',
  remote_match: 'Remote',
  salary_match: 'Salary'
}

const STATE_ACTIONS: { state: JobStateWrite; label: string; verb: string }[] = [
  { state: 'interested', label: 'Interested', verb: 'Mark interested' },
  { state: 'saved', label: 'Saved', verb: 'Save' },
  { state: 'applied', label: 'Applied', verb: 'Mark applied' },
  { state: 'dismissed', label: 'Dismissed', verb: 'Dismiss' }
]

// Greenhouse descriptions are HTML (<p>, <br>, <li>). Lever and LinkedIn are
// plain text with \n linebreaks. dangerouslySetInnerHTML on plain text collapses
// \n so everything renders as one paragraph — hence the split.
function Description({ text }: { text: string }) {
  if (!text) {
    return (
      <p className="jp-drawer__description jp-muted">
        <em>No description</em>
      </p>
    )
  }
  const isHtml = /<(p|br|div|li|ul|ol|h[1-6])\b/i.test(text)
  if (isHtml) {
    return <div className="jp-drawer__description" dangerouslySetInnerHTML={{ __html: text }} />
  }
  return <div className="jp-drawer__description jp-drawer__description--plain">{text}</div>
}

export function JobDrawer({ auth, jobId, profileId, onClose, onStateChange }: Props) {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Optimistic local state so the buttons update without a full refetch.
  const [currentState, setCurrentState] = useState<JobStateRead | null>(null)
  const [pendingState, setPendingState] = useState<JobStateWrite | null>(null)
  // V3 application packet (tailored resume + cover letter), generated on demand.
  const [generating, setGenerating] = useState(false)
  const [packet, setPacket] = useState<{ resume: string; coverLetter: string } | null>(null)
  const [packetError, setPacketError] = useState<string | null>(null)
  // Shareable packet link (minted from the generated packet).
  const [linking, setLinking] = useState(false)
  const [packetLink, setPacketLink] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setJob(null)
    setCurrentState(null)
    setPacket(null)
    setPacketError(null)
    setPacketLink(null)
    setLinkError(null)
    setCopied(false)
    getJob(jobId, profileId ?? undefined, auth)
      .then(result => {
        if (!cancelled) {
          setJob(result)
          setCurrentState(result.state)
        }
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
  }, [auth, jobId, profileId])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSetState = async (next: JobStateWrite) => {
    if (pendingState) return
    setPendingState(next)
    setError(null)
    try {
      const res = await setJobState(jobId, next, auth)
      setCurrentState(res.state)
      onStateChange?.(jobId, res.state)
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to update state')
    } finally {
      setPendingState(null)
    }
  }

  const handleGenerate = async () => {
    if (generating) return
    setGenerating(true)
    setPacketError(null)
    // A fresh packet invalidates any previously minted link.
    setPacketLink(null)
    setLinkError(null)
    setCopied(false)
    try {
      const [resume, cover] = await Promise.all([
        generateResume(jobId, auth),
        generateCoverLetter(jobId, auth)
      ])
      setPacket({ resume: resume.resume_markdown, coverLetter: cover.cover_letter_markdown })
    } catch (err) {
      setPacketError(err instanceof JobsApiError ? err.message : 'Failed to generate packet')
    } finally {
      setGenerating(false)
    }
  }

  const handleCreateLink = async () => {
    if (!packet || linking) return
    setLinking(true)
    setLinkError(null)
    try {
      const { url } = await mintPacketLink(
        jobId,
        { resume_markdown: packet.resume, cover_letter_markdown: packet.coverLetter },
        auth
      )
      setPacketLink(url)
    } catch (err) {
      setLinkError(err instanceof JobsApiError ? err.message : 'Failed to create link')
    } finally {
      setLinking(false)
    }
  }

  const handleCopyLink = () => {
    if (!packetLink) return
    void navigator.clipboard?.writeText(packetLink).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => setLinkError('Copy failed — select the link and copy manually')
    )
  }

  // Auth state is unknown until first fetch resolves. After load, `state`
  // null means caller is unauthenticated.
  const stateButtonsEnabled = currentState !== null

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
              {currentState && currentState !== 'new' && (
                <span
                  className={`jp-drawer__facts-state jp-drawer__facts-state--${currentState}`}
                  data-testid="drawer-state-badge"
                >
                  {currentState}
                </span>
              )}
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
              <Description text={job.description} />
            </section>

            <section className="jp-drawer__section">
              <h3>Triage</h3>
              {!stateButtonsEnabled && (
                <p className="jp-muted">Sign in to track your interest in this job.</p>
              )}
              <div className="jp-drawer__actions">
                {STATE_ACTIONS.map(({ state, label, verb }) => {
                  const isActive = currentState === state
                  const isPending = pendingState === state
                  return (
                    <button
                      key={state}
                      type="button"
                      className={`jp-drawer__cta jp-drawer__cta--state-${state}${
                        isActive ? ' jp-drawer__cta--active' : ''
                      }`}
                      disabled={!stateButtonsEnabled || pendingState !== null}
                      onClick={() => void handleSetState(state)}
                      aria-pressed={isActive}
                      data-testid={`state-action-${state}`}
                    >
                      {isPending ? '…' : isActive ? label : verb}
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="jp-drawer__section">
              <h3>Apply</h3>
              <div className="jp-drawer__actions">
                <a
                  className="jp-drawer__cta jp-drawer__cta--primary"
                  href={job.application_url ?? job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Apply on {job.source_site}
                </a>
                <button
                  type="button"
                  className="jp-drawer__cta"
                  onClick={() => void handleGenerate()}
                  disabled={!stateButtonsEnabled || generating}
                  data-testid="generate-packet"
                >
                  {generating ? 'Generating…' : packet ? 'Regenerate packet' : 'Generate packet'}
                </button>
              </div>
              {packetError && <p className="jp-error">{packetError}</p>}
              {packet && (
                <div className="jp-drawer__packet">
                  <label className="jp-drawer__packet-label">
                    Tailored resume
                    <textarea
                      className="jp-drawer__packet-text"
                      readOnly
                      rows={12}
                      value={packet.resume}
                      onFocus={e => e.currentTarget.select()}
                    />
                  </label>
                  <label className="jp-drawer__packet-label">
                    Cover letter
                    <textarea
                      className="jp-drawer__packet-text"
                      readOnly
                      rows={12}
                      value={packet.coverLetter}
                      onFocus={e => e.currentTarget.select()}
                    />
                  </label>

                  <div className="jp-drawer__packet-link">
                    {packetLink ? (
                      <>
                        <input
                          className="jp-drawer__packet-link-input"
                          readOnly
                          value={packetLink}
                          onFocus={e => e.currentTarget.select()}
                          aria-label="Shareable packet link"
                        />
                        <button type="button" className="jp-drawer__cta" onClick={handleCopyLink}>
                          {copied ? 'Copied ✓' : 'Copy'}
                        </button>
                        <a
                          className="jp-drawer__cta"
                          href={packetLink}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open
                        </a>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="jp-drawer__cta jp-drawer__cta--primary"
                        onClick={() => void handleCreateLink()}
                        disabled={linking}
                      >
                        {linking ? 'Creating link…' : 'Create shareable link'}
                      </button>
                    )}
                  </div>
                  {linkError && <p className="jp-error">{linkError}</p>}
                </div>
              )}
            </section>
          </>
        )}
      </aside>
    </>
  )
}
