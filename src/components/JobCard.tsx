import type { FeedbackReason, JobSummary, VoteValue } from '../api/jobs'
import type { ApplyPhase, ApplyStatus } from '../api/applyQueue'
import type { Auth } from '../api/auth'
import { VoteControl } from './VoteControl'

interface Props {
  job: JobSummary
  showScore: boolean
  auth: Auth
  // The vote to display — feed value merged with any this-session override.
  vote: VoteValue | null
  voteReasons: FeedbackReason[]
  onClick: () => void
  onVote: (jobId: string, vote: VoteValue | null, reasons: FeedbackReason[]) => void
  // Hand this posting to the form runner. The list owns the call so one
  // handler covers every card, and so the shared queue has one caller.
  onApply: (jobId: string) => void
  // Where this job is in that sequence, when it has been started this session.
  applyStatus?: ApplyStatus
}

function formatSalary(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null
  const fmt = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`)
  if (min && max) return `${fmt(min)}–${fmt(max)}`
  return fmt((min ?? max)!)
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}

/**
 * What the button says at each step.
 *
 * It narrates rather than spinning, because the sequence is genuinely slow
 * (two LLM generations) and a card that just says "…" for thirty seconds is
 * indistinguishable from one that has hung. "Queued" is the honest end state:
 * the runner has not filled anything yet, and nothing has been sent.
 */
const APPLY_LABEL: Record<ApplyPhase, string> = {
  idle: 'Apply',
  waiting: 'Waiting…',
  preparing: 'Tailoring…',
  queueing: 'Queueing…',
  queued: 'Queued ✓',
  error: 'Retry'
}

function scoreTier(score: number): 'high' | 'mid' | 'low' {
  if (score >= 0.75) return 'high'
  if (score >= 0.5) return 'mid'
  return 'low'
}

export function JobCard({
  job,
  showScore,
  auth,
  vote,
  voteReasons,
  onClick,
  onVote,
  onApply,
  applyStatus
}: Props) {
  const salary = formatSalary(job.salary_min, job.salary_max)
  const posted = formatDate(job.posted_date ?? job.scraped_at)
  const tier = showScore ? scoreTier(job.score) : null
  const hasState = job.state && job.state !== 'new'
  // Voting is per-user; an unauthenticated feed has state: null on every job.
  const canVote = job.state !== null && job.state !== undefined
  // Same signal for triage: unauthed, Apply is a plain link to the posting and
  // marks nothing, because there is no user to mark it for.
  const canMark = canVote
  const phase = applyStatus?.phase ?? 'idle'
  // Any phase between the click and the answer. The button is inert through
  // all of them so a second click cannot enqueue the same posting twice.
  const busy = phase === 'waiting' || phase === 'preparing' || phase === 'queueing'

  const cardClasses = ['jp-jobcard']
  if (tier) cardClasses.push(`jp-jobcard--score-${tier}`)
  if (hasState) cardClasses.push(`jp-jobcard--state-${job.state}`)
  if (vote === -1) cardClasses.push('jp-jobcard--downvoted')
  const scoreClass = tier ? `jp-jobcard__score jp-jobcard__score--${tier}` : 'jp-jobcard__score'

  return (
    // Not a <button>: the vote thumbs live inside the card, and buttons can't
    // nest. role+tabIndex+keydown keep it clickable and keyboard-activatable.
    <div
      role="button"
      tabIndex={0}
      className={cardClasses.join(' ')}
      onClick={onClick}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <div className="jp-jobcard__top">
        <span className="jp-jobcard__title">{job.title}</span>
        <div className="jp-jobcard__top-right">
          {hasState && (
            <span
              className={`jp-jobcard__state jp-jobcard__state--${job.state}`}
              data-testid="card-state-badge"
            >
              {job.state}
            </span>
          )}
          {showScore && <span className={scoreClass}>{job.score.toFixed(2)}</span>}
          {canVote && (
            <VoteControl
              jobId={job.id}
              auth={auth}
              vote={vote}
              reasons={voteReasons}
              onVoteChange={onVote}
            />
          )}
        </div>
      </div>
      <div className="jp-jobcard__meta">
        <span className="jp-jobcard__company">{job.company}</span>
        <span className="jp-jobcard__sep">·</span>
        <span>{job.location || 'location unknown'}</span>
        {job.workplace_type && job.workplace_type !== 'unknown' && (
          <>
            <span className="jp-jobcard__sep">·</span>
            <span>{job.workplace_type}</span>
          </>
        )}
      </div>
      <div className="jp-jobcard__footer">
        {salary && <span className="jp-jobcard__salary">{salary}</span>}
        <a
          className="jp-jobcard__source jp-jobcard__source--link"
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          // Inside a clickable card: the origin link must not also open the drawer.
          onClick={e => e.stopPropagation()}
          title="Open the original posting"
        >
          {job.source_site} ↗
        </a>
        {posted && <span>{posted}</span>}
        {/*
          Apply WITHOUT leaving the feed: this hands the posting to the form
          runner rather than opening the employer's site. Opening a tab is
          still one click away — that is what the source link to the left is —
          but it is no longer what the button labelled Apply does.

          The click only ever ENQUEUES. Each job costs two LLM generations, so
          the shared lane in applyQueue.ts runs them one at a time; a card
          clicked while another is running says "waiting" and still lands.
        */}
        <button
          type="button"
          className={`jp-jobcard__apply jp-jobcard__apply--${phase}`}
          data-testid="card-apply"
          disabled={!canMark || busy || phase === 'queued'}
          title={
            canMark
              ? 'Build the application packet and hand it to the form runner'
              : 'Sign in to hand postings to the runner'
          }
          onClick={e => {
            e.stopPropagation()
            if (canMark) onApply(job.id)
          }}
        >
          {APPLY_LABEL[phase]}
        </button>
      </div>
    </div>
  )
}
