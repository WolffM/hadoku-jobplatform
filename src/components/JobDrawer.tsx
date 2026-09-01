import { useEffect, useRef, useState } from 'react'
import {
  getJob,
  setJobState,
  generateResume,
  generateCoverLetter,
  generateApplicationExtras,
  mintPacketLink,
  queueApplication,
  JobsApiError,
  type JobDetail,
  type ScoreBreakdown,
  type JobStateRead,
  type JobStateWrite,
  type ApplicationExtras,
  type FeedbackReason,
  type VoteValue
} from '../api/jobs'
import type { Auth } from '../api/auth'
import { VoteControl } from './VoteControl'

interface Props {
  auth: Auth
  jobId: string
  profileId: string | null
  // The vote known at open time (from the feed card). The detail endpoint
  // doesn't return votes, so a deep link opens as unvoted.
  initialVote?: VoteValue | null
  onClose: () => void
  onStateChange?: (jobId: string, newState: JobStateRead) => void
  onVoteChange?: (jobId: string, vote: VoteValue | null, reasons: FeedbackReason[]) => void
}

// Track and companies are hard filters, not score factors, so they never appear
// here — a job that reached the drawer already passed them. Salary is a view
// filter and doesn't score at all.
const BREAKDOWN_LABELS: Record<keyof ScoreBreakdown, string> = {
  relevance: 'Relevance',
  level_match: 'Level',
  geo_fit: 'Geo/Remote',
  comp_fit: 'Comp',
  stack_fit: 'Stack',
  domain_interest: 'Interest',
  discipline_factor: 'Discipline'
}

const STATE_ACTIONS: { state: JobStateWrite; label: string; verb: string }[] = [
  { state: 'interested', label: 'Interested', verb: 'Mark interested' },
  { state: 'saved', label: 'Saved', verb: 'Save' },
  { state: 'applied', label: 'Applied', verb: 'Mark applied' },
  { state: 'dismissed', label: 'Dismissed', verb: 'Dismiss' }
]

// Greenhouse descriptions are HTML (<p>, <br>, <li>). Lever and LinkedIn are
// plain text with \n linebreaks. dangerouslySetInnerHTML on plain text collapses
// \n so everything renders as one paragraph — hence the split. Exported because
// the packets split view renders the posting the same way.
export function Description({ text }: { text: string }) {
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

// One copy-able field of the kit: a labelled read-only textarea + a Copy button.
// Each owns its "Copied ✓" flash so copying one field doesn't flash the rest.
function CopyBlock({
  label,
  value,
  rows = 4,
  hint
}: {
  label: string
  value: string
  rows?: number
  hint?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div className="jp-drawer__kit-field">
      <div className="jp-drawer__kit-field-head">
        <span className="jp-drawer__kit-field-label">{label}</span>
        {hint && <span className="jp-muted jp-drawer__kit-field-hint">{hint}</span>}
        <button type="button" className="jp-drawer__kit-copy" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <textarea
        className="jp-drawer__packet-text"
        readOnly
        rows={rows}
        value={value}
        onFocus={e => e.currentTarget.select()}
      />
    </div>
  )
}

/**
 * How much of this application the runner can take on.
 *
 * Two claims with very different standing, and the wording keeps them apart.
 * `verified` means a form on this board was actually filled — evidence. `tier`
 * is read off the URL and no page has been opened, so it says "should" and not
 * "will". Dressing a prediction as a check is how a queue full of surprises
 * gets built.
 */
function ApplyTierChip({ tier, verified }: { tier: JobDetail['apply_tier']; verified: boolean }) {
  if (verified) {
    return (
      <p className="jp-apply-tier jp-apply-tier--verified">
        Auto-apply verified — the runner has filled a form on this board before.
      </p>
    )
  }
  const COPY: Record<JobDetail['apply_tier'], string | null> = {
    supported: 'The runner should be able to fill this form; it has not driven this board yet.',
    embedded:
      'This employer hosts its own careers page, but the form underneath is one the runner ' +
      'knows. Not tried on this board yet.',
    unsupported: 'No adapter for this ATS — this one is by hand.',
    unknown: null
  }
  const copy = COPY[tier]
  if (!copy) return null
  return <p className={`jp-apply-tier jp-apply-tier--${tier}`}>{copy}</p>
}

export function JobDrawer({
  auth,
  jobId,
  profileId,
  initialVote,
  onClose,
  onStateChange,
  onVoteChange
}: Props) {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Optimistic local state so the buttons update without a full refetch.
  const [currentState, setCurrentState] = useState<JobStateRead | null>(null)
  const [pendingState, setPendingState] = useState<JobStateWrite | null>(null)
  const [vote, setVote] = useState<VoteValue | null>(initialVote ?? null)
  const [voteReasons, setVoteReasons] = useState<FeedbackReason[]>([])
  // The apply kit, built by "Prepare application" in two waves: résumé + cover
  // letter first, then the extras (which need the résumé as input).
  const [preparing, setPreparing] = useState(false)
  const [packet, setPacket] = useState<{ resume: string; coverLetter: string } | null>(null)
  const [packetError, setPacketError] = useState<string | null>(null)
  const [extras, setExtras] = useState<ApplicationExtras | null>(null)
  const [extrasError, setExtrasError] = useState<string | null>(null)
  // Shareable packet link (minted from the generated packet).
  const [linking, setLinking] = useState(false)
  const [packetLink, setPacketLink] = useState<string | null>(null)
  const [packetSlug, setPacketSlug] = useState<string | null>(null)
  // Queue state for the approve-to-apply runner. Local to the drawer: the
  // Applications tab is where the queue is actually managed.
  const [queueing, setQueueing] = useState(false)
  const [queued, setQueued] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setJob(null)
    setCurrentState(null)
    setVote(initialVote ?? null)
    setPacket(null)
    setPacketError(null)
    setExtras(null)
    setExtrasError(null)
    setPacketLink(null)
    setPacketSlug(null)
    setQueued(false)
    setQueueError(null)
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
  }, [auth, jobId, profileId, initialVote])

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
      // Marking applied with a prepared packet records which link went out.
      const slug = next === 'applied' ? (packetSlug ?? undefined) : undefined
      const res = await setJobState(jobId, next, auth, slug)
      setCurrentState(res.state)
      onStateChange?.(jobId, res.state)
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to update state')
    } finally {
      setPendingState(null)
    }
  }

  const handlePrepare = async () => {
    if (preparing) return
    setPreparing(true)
    setPacketError(null)
    setExtrasError(null)
    // A fresh preparation invalidates any previously minted link + extras.
    setExtras(null)
    setPacketLink(null)
    setPacketSlug(null)
    setLinkError(null)
    setCopied(false)
    try {
      // Two sequenced Groq requests. The résumé (itself block-selection +
      // rewrite) is the token-heavy one, so it runs alone first; then a single
      // application-extras call returns the cover letter AND the rest of the kit
      // together. Firing the cover letter and extras as separate back-to-back
      // calls used to stack past Groq's per-minute token cap so the trailing one
      // (extras) 500'd — leaving a cold packet with a résumé + cover but no kit.
      const resume = await generateResume(jobId, auth)
      // Surface the résumé the moment it lands; the cover letter + kit fill in.
      setPacket({ resume: resume.resume_markdown, coverLetter: '' })

      try {
        const kit = await generateApplicationExtras(
          jobId,
          { resume_markdown: resume.resume_markdown },
          auth
        )
        // The cover letter now comes back with the kit; fall back to a separate
        // fetch only if it didn't (older resume-api, or the model dropped it).
        const coverLetter =
          kit.cover_letter_markdown ||
          (await generateCoverLetter(jobId, auth)).cover_letter_markdown
        setPacket({ resume: resume.resume_markdown, coverLetter })
        setExtras(kit)
        // Auto-mint: preparing an application IS creating the packet. The mint
        // is instant (no LLM) and records the slug on the job, so the Packets
        // view always finds it — the owner generated two kits that vanished
        // because this was a separate button. Failure is non-fatal; the manual
        // link button remains.
        try {
          const { url, slug } = await mintPacketLink(
            jobId,
            {
              resume_markdown: resume.resume_markdown,
              ...(coverLetter ? { cover_letter_markdown: coverLetter } : {})
            },
            auth
          )
          setPacketLink(url)
          setPacketSlug(slug)
        } catch {
          // leave the manual "Create link" path available
        }
      } catch (err) {
        setExtrasError(
          err instanceof JobsApiError ? err.message : 'Failed to generate the application kit'
        )
      }
    } catch (err) {
      setPacketError(err instanceof JobsApiError ? err.message : 'Failed to generate résumé')
    } finally {
      setPreparing(false)
    }
  }

  const handleCreateLink = async () => {
    if (!packet || linking) return
    setLinking(true)
    setLinkError(null)
    try {
      const { url, slug } = await mintPacketLink(
        jobId,
        { resume_markdown: packet.resume, cover_letter_markdown: packet.coverLetter },
        auth
      )
      setPacketLink(url)
      setPacketSlug(slug)
    } catch (err) {
      setLinkError(err instanceof JobsApiError ? err.message : 'Failed to create link')
    } finally {
      setLinking(false)
    }
  }

  /**
   * Queue this job for the PC-side form runner.
   *
   * Clicking this IS the consent step — the runner only ever drains the queue
   * and never chooses jobs itself. It needs a minted packet, because the
   * variant_slug is copied onto the row so a later re-tailor cannot change
   * what an in-flight application sends; the button stays disabled until
   * "Prepare application" has produced one.
   */
  async function handleApply() {
    setQueueing(true)
    setQueueError(null)
    try {
      await queueApplication(jobId, 'review', auth)
      setQueued(true)
    } catch (err) {
      setQueueError(err instanceof JobsApiError ? err.message : 'Failed to queue the application')
    } finally {
      setQueueing(false)
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
              <div className="jp-drawer__vote">
                <VoteControl
                  jobId={jobId}
                  auth={auth}
                  vote={vote}
                  reasons={voteReasons}
                  disabled={!stateButtonsEnabled}
                  align="start"
                  onVoteChange={(id, next, nextReasons) => {
                    setVote(next)
                    setVoteReasons(nextReasons)
                    onVoteChange?.(id, next, nextReasons)
                  }}
                />
              </div>
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
              <ApplyTierChip tier={job.apply_tier} verified={job.apply_verified} />
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
                  onClick={() => void handlePrepare()}
                  disabled={!stateButtonsEnabled || preparing}
                  data-testid="prepare-application"
                >
                  {preparing
                    ? 'Preparing…'
                    : packet
                      ? 'Regenerate application'
                      : 'Prepare application'}
                </button>
              </div>
              {packetError && <p className="jp-error">{packetError}</p>}

              {packet && (
                <div className="jp-drawer__packet">
                  <CopyBlock label="Tailored résumé" value={packet.resume} rows={12} />
                  {packet.coverLetter && (
                    <CopyBlock label="Cover letter" value={packet.coverLetter} rows={12} />
                  )}

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
                        disabled={linking || !packet.coverLetter}
                      >
                        {linking ? 'Creating link…' : 'Create shareable link'}
                      </button>
                    )}
                  </div>
                  {linkError && <p className="jp-error">{linkError}</p>}

                  <div className="jp-drawer__apply">
                    <button
                      type="button"
                      className="jp-drawer__cta jp-drawer__cta--primary"
                      onClick={() => void handleApply()}
                      disabled={queueing || queued || !packetSlug}
                      title={
                        packetSlug
                          ? 'Queue this application for the form runner'
                          : 'Create the shareable link first — the queue pins that packet'
                      }
                    >
                      {queued ? 'Queued ✓' : queueing ? 'Queueing…' : 'Apply'}
                    </button>
                    <span className="jp-muted">
                      {queued
                        ? 'The runner will fill the form and stop for your review.'
                        : 'Review mode: the runner fills the form and pauses for approval.'}
                    </span>
                  </div>
                  {queueError && <p className="jp-error">{queueError}</p>}

                  {preparing && !extras && (
                    <p className="jp-muted">Preparing the rest of the kit…</p>
                  )}
                  {extrasError && <p className="jp-error">{extrasError}</p>}

                  {extras && (
                    <div className="jp-drawer__kit">
                      <CopyBlock label="Intro email" value={extras.intro_email} rows={8} />
                      <CopyBlock label="Why this role" value={extras.why_hook} rows={3} />
                      {extras.screening_answers.map((sa, i) => (
                        <CopyBlock key={i} label={sa.q} value={sa.a} rows={4} />
                      ))}
                      <CopyBlock
                        label="Expected compensation"
                        value={extras.salary_line}
                        rows={2}
                      />
                      <CopyBlock
                        label="LinkedIn note"
                        value={extras.linkedin_note}
                        rows={3}
                        hint={`${extras.linkedin_note.length}/300`}
                      />
                      <CopyBlock
                        label="Phone-screen talking points"
                        value={extras.talking_points.map(t => `• ${t}`).join('\n')}
                        rows={Math.max(3, extras.talking_points.length)}
                      />
                      <CopyBlock
                        label="Standard fields"
                        value={extras.standard_fields}
                        rows={8}
                        hint="name · contact · work auth"
                      />
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </aside>
    </>
  )
}
