import type { JobSummary } from '../api/jobs'

interface Props {
  job: JobSummary
  showScore: boolean
  onClick: () => void
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

export function JobCard({ job, showScore, onClick }: Props) {
  const salary = formatSalary(job.salary_min, job.salary_max)
  const posted = formatDate(job.posted_date ?? job.scraped_at)

  return (
    <button type="button" className="jp-jobcard" onClick={onClick}>
      <div className="jp-jobcard__top">
        <span className="jp-jobcard__title">{job.title}</span>
        {showScore && <span className="jp-jobcard__score">{job.score.toFixed(2)}</span>}
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
        {posted && <span className="jp-jobcard__posted">{posted}</span>}
      </div>
    </button>
  )
}
