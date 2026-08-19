import type { JobSummary, VoteValue } from '../api/jobs'
import type { Auth } from '../api/auth'
import { VoteControl } from './VoteControl'

interface Props {
  job: JobSummary
  showScore: boolean
  auth: Auth
  // The vote to display — feed value merged with any this-session override.
  vote: VoteValue | null
  onClick: () => void
  onVote: (jobId: string, vote: VoteValue | null) => void
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

function scoreTier(score: number): 'high' | 'mid' | 'low' {
  if (score >= 0.75) return 'high'
  if (score >= 0.5) return 'mid'
  return 'low'
}

export function JobCard({ job, showScore, auth, vote, onClick, onVote }: Props) {
  const salary = formatSalary(job.salary_min, job.salary_max)
  const posted = formatDate(job.posted_date ?? job.scraped_at)
  const tier = showScore ? scoreTier(job.score) : null
  const hasState = job.state && job.state !== 'new'
  // Voting is per-user; an unauthenticated feed has state: null on every job.
  const canVote = job.state !== null && job.state !== undefined

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
          {canVote && <VoteControl jobId={job.id} auth={auth} vote={vote} onVoteChange={onVote} />}
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
        <span className="jp-jobcard__source">{job.source_site}</span>
        {posted && <span>{posted}</span>}
      </div>
    </div>
  )
}
