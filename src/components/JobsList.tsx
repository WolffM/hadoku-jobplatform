import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listJobs,
  JobsApiError,
  type JobSummary,
  type JobStateRead,
  type JobSort,
  type VoteValue
} from '../api/jobs'
import type { Auth } from '../api/auth'
import { JobCard } from './JobCard'

interface Props {
  auth: Auth
  profileId: string | null
  onSelect: (jobId: string, vote: VoteValue | null) => void
  // Bumped by the drawer when the user transitions a job — forces a refetch
  // so the list reflects the new state immediately.
  refreshKey?: number
  // This-session vote overrides (card thumbs + drawer), keyed by job id.
  // They shadow the fetched feed value so a vote never forces a refetch —
  // the feed only re-ranks on the next natural load.
  voteOverrides: Record<string, VoteValue | null>
  onVote: (jobId: string, vote: VoteValue | null) => void
}

const STATE_FILTERS: { value: '' | JobStateRead; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'interested', label: 'Interested' },
  { value: 'saved', label: 'Saved' },
  { value: 'applied', label: 'Applied' },
  { value: 'dismissed', label: 'Dismissed' }
]

export function JobsList({ auth, profileId, onSelect, refreshKey, voteOverrides, onVote }: Props) {
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sort, setSort] = useState<JobSort>('score')
  // Salary is a view control, not a profile criterion — it narrows what you're
  // looking at right now without changing how anything scores.
  const [minSalary, setMinSalary] = useState('')
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<'' | JobStateRead>('')
  const [hideDismissed, setHideDismissed] = useState(true)

  const limit = 25

  // hide_dismissed only matters when no specific state filter is active.
  // When the user picks state='dismissed' explicitly, we want them to see them.
  const effectiveHideDismissed = hideDismissed && stateFilter === ''

  // Without a profile nothing is scored, so "score" isn't an option the select
  // offers — fall back to date rather than rendering a blank selection.
  const effectiveSort: JobSort = !profileId && sort === 'score' ? 'date' : sort

  // Blank / unparseable means "no salary floor" rather than 0 — passing 0 would
  // read as an explicit filter and drop nothing, but it muddies the query.
  const minSalaryNum = minSalary.trim() ? Number(minSalary) : NaN
  const effectiveMinSalary =
    Number.isFinite(minSalaryNum) && minSalaryNum > 0 ? minSalaryNum : undefined

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listJobs(
        {
          profile_id: profileId ?? undefined,
          state: stateFilter || undefined,
          hide_dismissed: effectiveHideDismissed || undefined,
          page,
          limit,
          sort: effectiveSort,
          min_salary: effectiveMinSalary
        },
        auth
      )
      setJobs(res.jobs)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }, [
    auth,
    profileId,
    stateFilter,
    effectiveHideDismissed,
    page,
    limit,
    effectiveSort,
    effectiveMinSalary
  ])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1)
  }, [profileId, effectiveSort, effectiveMinSalary, stateFilter, effectiveHideDismissed])

  const filtered = useMemo(() => {
    if (!search.trim()) return jobs
    const q = search.toLowerCase()
    return jobs.filter(
      j =>
        j.title.toLowerCase().includes(q) ||
        j.company.toLowerCase().includes(q) ||
        j.location.toLowerCase().includes(q)
    )
  }, [jobs, search])

  const totalPages = Math.max(1, Math.ceil(total / limit))
  // Auth-gated filters: the API requires admin/friend for state=.
  // We don't pre-flight whoami here — instead, rely on a real state value in the
  // response. Both null (authed-but-no-row) and undefined (older worker without
  // the field) mean "not authed enough to surface the filters".
  const seemsAuthed = jobs.some(j => j.state !== null && j.state !== undefined)

  return (
    <div className="jp-jobs">
      <div className="jp-jobs__filters">
        <input
          type="search"
          placeholder="Search title / company / location"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="jp-jobs__search"
        />
        <label className="jp-jobs__filter">
          Sort
          <select value={effectiveSort} onChange={e => setSort(e.target.value as JobSort)}>
            {profileId && <option value="score">Score</option>}
            <option value="date">Date</option>
            <option value="salary">Salary</option>
          </select>
        </label>
        <label className="jp-jobs__filter">
          Min salary
          <input
            type="number"
            className="jp-jobs__salary"
            min={0}
            step={10000}
            value={minSalary}
            onChange={e => setMinSalary(e.target.value)}
            placeholder="any"
          />
        </label>
        {seemsAuthed && (
          <label className="jp-jobs__filter">
            State
            <select
              value={stateFilter}
              onChange={e => setStateFilter(e.target.value as '' | JobStateRead)}
            >
              {STATE_FILTERS.map(opt => (
                <option key={opt.value || 'all'} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {seemsAuthed && stateFilter === '' && (
          <label className="jp-jobs__filter">
            <input
              type="checkbox"
              checked={hideDismissed}
              onChange={e => setHideDismissed(e.target.checked)}
            />
            Hide dismissed
          </label>
        )}
      </div>

      {!profileId && (
        <p className="jp-muted">
          {auth.sessionId
            ? 'No profile selected. Showing all jobs, unscored. Pick or create a profile to see its companies’ jobs, scored and ranked.'
            : 'Showing every job in the corpus, newest first. Scoring and ranking need a profile, which needs an account.'}
        </p>
      )}

      {error && <p className="jp-error">{error}</p>}

      {loading ? (
        <p className="jp-muted">Loading jobs…</p>
      ) : filtered.length === 0 ? (
        <p className="jp-muted">
          {total === 0 ? 'No jobs match your filters.' : 'No matches for the current search.'}
        </p>
      ) : (
        <ul className="jp-jobs__list">
          {filtered.map(job => {
            const vote = job.id in voteOverrides ? voteOverrides[job.id] : (job.vote ?? null)
            return (
              <li key={job.id}>
                <JobCard
                  job={job}
                  showScore={!!profileId}
                  auth={auth}
                  vote={vote}
                  onClick={() => onSelect(job.id, vote)}
                  onVote={onVote}
                />
              </li>
            )
          })}
        </ul>
      )}

      {total > limit && (
        <div className="jp-jobs__pagination">
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            ← Prev
          </button>
          <span>
            Page {page} / {totalPages} · {total} total
          </span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
