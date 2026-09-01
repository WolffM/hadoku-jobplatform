import { useEffect, useMemo, useState } from 'react'
import {
  listJobs,
  JobsApiError,
  type JobStateRead,
  type FeedbackReason,
  type JobSort,
  type VoteValue
} from '../api/jobs'
import type { Auth } from '../api/auth'
import { useResource } from '../api/useResource'
import { JobCard } from './JobCard'

interface Props {
  auth: Auth
  profileId: string | null
  onSelect: (jobId: string, vote: VoteValue | null) => void
  // Bumped when something re-scores the feed (a profile edit, a company added).
  // It keys the cache rather than triggering a refetch, so a bump misses every
  // cached page at once. Triage does NOT bump it — see stateOverrides.
  refreshKey?: number
  // This-session vote overrides (card thumbs + drawer), keyed by job id.
  // They shadow the fetched feed value so a vote never forces a refetch —
  // the feed only re-ranks on the next natural load.
  voteOverrides: Record<string, { vote: VoteValue | null; reasons: FeedbackReason[] }>
  onVote: (jobId: string, vote: VoteValue | null, reasons: FeedbackReason[]) => void
  // Same idea for triage: the drawer writes the new state through here and the
  // card reflects it immediately, instead of the feed re-ranking 30k rows to
  // learn that one badge changed.
  stateOverrides: Record<string, JobStateRead>
  // Hold the request while the sidebar is still resolving which profile is
  // selected. Without it the feed fires an unscored request on mount and
  // discards the answer a moment later, when the sidebar picks a profile.
  awaitingProfile?: boolean
}

const STATE_FILTERS: { value: '' | JobStateRead; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'interested', label: 'Interested' },
  { value: 'saved', label: 'Saved' },
  { value: 'applied', label: 'Applied' },
  { value: 'dismissed', label: 'Dismissed' }
]

export function JobsList({
  auth,
  profileId,
  onSelect,
  refreshKey,
  voteOverrides,
  onVote,
  stateOverrides,
  awaitingProfile
}: Props) {
  const [page, setPage] = useState(1)

  const [sort, setSort] = useState<JobSort>('score')
  // Salary is a view control, not a profile criterion — it narrows what you're
  // looking at right now without changing how anything scores.
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<'' | JobStateRead>('')
  const [hideDismissed, setHideDismissed] = useState(true)
  const [workplace, setWorkplace] = useState<'' | 'remote' | 'hybrid' | 'onsite'>('')

  const limit = 25

  // hide_dismissed only matters when no specific state filter is active.
  // When the user picks state='dismissed' explicitly, we want them to see them.
  const effectiveHideDismissed = hideDismissed && stateFilter === ''

  // Without a profile nothing is scored, so "score" isn't an option the select
  // offers — fall back to date rather than rendering a blank selection.
  const effectiveSort: JobSort = !profileId && sort === 'score' ? 'date' : sort

  const query = useMemo(
    () => ({
      profile_id: profileId ?? undefined,
      state: stateFilter || undefined,
      page,
      limit,
      sort: effectiveSort,
      workplace: workplace || undefined
    }),
    [profileId, stateFilter, page, limit, effectiveSort, workplace]
  )

  // refreshKey is in the cache key rather than a refetch trigger: bumping it
  // (a profile edit re-scores the feed) misses every previously cached page at
  // once, which is exactly the invalidation this needs.
  const {
    data,
    loading,
    refreshing,
    error: loadError
  } = useResource(`jobs:${refreshKey ?? 0}:${JSON.stringify(query)}`, () => listJobs(query, auth), {
    enabled: !awaitingProfile
  })

  const jobs = useMemo(() => data?.jobs ?? [], [data])
  const total = data?.total ?? 0
  const error = loadError
    ? loadError instanceof JobsApiError
      ? loadError.message
      : 'Failed to load jobs'
    : null

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1)
  }, [profileId, effectiveSort, stateFilter, workplace])

  // Triage the drawer applied this session, laid over the fetched rows. It has
  // to happen before the view filters so that dismissing a job from the drawer
  // drops it from a hide-dismissed feed without a refetch.
  const patched = useMemo(
    () => jobs.map(j => (stateOverrides[j.id] ? { ...j, state: stateOverrides[j.id] } : j)),
    [jobs, stateOverrides]
  )

  const filtered = useMemo(() => {
    // Hide-dismissed is a VIEW filter over the already-loaded page — toggling
    // it must never refetch (a feed reload re-scores the corpus, seconds).
    let list = effectiveHideDismissed ? patched.filter(j => j.state !== 'dismissed') : patched
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        j =>
          j.title.toLowerCase().includes(q) ||
          j.company.toLowerCase().includes(q) ||
          j.location.toLowerCase().includes(q)
      )
    }
    return list
  }, [patched, search, effectiveHideDismissed])

  const totalPages = Math.max(1, Math.ceil(total / limit))
  // Auth-gated filters: the API requires admin/friend for state=.
  // We don't pre-flight whoami here — instead, rely on a real state value in the
  // response. Both null (authed-but-no-row) and undefined (older worker without
  // the field) mean "not authed enough to surface the filters".
  const seemsAuthed = patched.some(j => j.state !== null && j.state !== undefined)

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
            {profileId && <option value="comp">Comp lens</option>}
            {profileId && <option value="interest">Interest lens</option>}
            {profileId && <option value="relevance">Relevance lens</option>}
            <option value="date">Date</option>
            <option value="salary">Salary</option>
          </select>
        </label>
        <label className="jp-jobs__filter">
          Workplace
          <select
            value={workplace}
            onChange={e => setWorkplace(e.target.value as '' | 'remote' | 'hybrid' | 'onsite')}
          >
            <option value="">All</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">Onsite</option>
          </select>
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
        <ul className="jp-jobs__list" data-refreshing={refreshing ? 'true' : undefined}>
          {filtered.map(job => {
            const ov = voteOverrides[job.id]
            const vote = ov ? ov.vote : (job.vote ?? null)
            const voteReasons = ov ? ov.reasons : ((job.vote_reasons ?? []) as FeedbackReason[])
            return (
              <li key={job.id}>
                <JobCard
                  job={job}
                  showScore={!!profileId}
                  auth={auth}
                  vote={vote}
                  voteReasons={voteReasons}
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
