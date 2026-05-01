import { useCallback, useEffect, useMemo, useState } from 'react'
import { listJobs, JobsApiError, type JobSummary, type JobStateRead } from '../api/jobs'
import type { Auth } from '../api/auth'
import { JobCard } from './JobCard'

interface Props {
  auth: Auth
  profileId: string | null
  onSelect: (jobId: string) => void
  // Bumped by the drawer when the user transitions a job — forces a refetch
  // so the list reflects the new state immediately.
  refreshKey?: number
}

const STATE_FILTERS: { value: '' | JobStateRead; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'interested', label: 'Interested' },
  { value: 'saved', label: 'Saved' },
  { value: 'applied', label: 'Applied' },
  { value: 'dismissed', label: 'Dismissed' }
]

export function JobsList({ auth, profileId, onSelect, refreshKey }: Props) {
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sort, setSort] = useState<'score' | 'date'>('score')
  const [minScore, setMinScore] = useState(0)
  const [mine, setMine] = useState(false)
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<'' | JobStateRead>('')
  const [hideDismissed, setHideDismissed] = useState(true)

  const limit = 25

  // hide_dismissed only matters when no specific state filter is active.
  // When the user picks state='dismissed' explicitly, we want them to see them.
  const effectiveHideDismissed = hideDismissed && stateFilter === ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listJobs(
        {
          profile_id: profileId ?? undefined,
          mine: mine || undefined,
          state: stateFilter || undefined,
          hide_dismissed: effectiveHideDismissed || undefined,
          page,
          limit,
          sort,
          min_score: minScore
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
  }, [auth, profileId, mine, stateFilter, effectiveHideDismissed, page, sort, minScore])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1)
  }, [profileId, mine, sort, minScore, stateFilter, effectiveHideDismissed])

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
  // Auth-gated filters: the API requires admin/friend for state= / mine= / hide_dismissed=.
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
        {profileId && (
          <>
            <label className="jp-jobs__filter">
              Sort
              <select value={sort} onChange={e => setSort(e.target.value as 'score' | 'date')}>
                <option value="score">Score</option>
                <option value="date">Date</option>
              </select>
            </label>
            <label className="jp-jobs__filter">
              Min score
              <input
                type="range"
                className="jp-slider"
                min={0}
                max={1}
                step={0.05}
                value={minScore}
                onChange={e => setMinScore(Number(e.target.value))}
              />
              <span className="jp-jobs__filter-value">{minScore.toFixed(2)}</span>
            </label>
          </>
        )}
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
        <label className="jp-jobs__filter">
          <input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />
          Mine only
        </label>
      </div>

      {!profileId && (
        <p className="jp-muted">
          No profile selected. Showing unscored list. Pick or create a profile to see scores and
          enable score-based sorting + filtering.
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
          {filtered.map(job => (
            <li key={job.id}>
              <JobCard job={job} showScore={!!profileId} onClick={() => onSelect(job.id)} />
            </li>
          ))}
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
