import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { JobsApiError, setJobState, type JobStateWrite } from '../api/jobs'
import { getPipeline, type PipelineItem } from '../api/pipeline'
import type { Auth } from '../api/auth'
import { invalidateResource } from '../api/resource'
import { useResource } from '../api/useResource'

interface Props {
  auth: Auth
  onSelect: (jobId: string) => void
  /** Bumped by the drawer when it changed something the board shows. */
  reloadKey: number
}

/**
 * The columns, in the order an application moves through them. Dismissed is
 * not one: GET /pipeline leaves it out, and a dismissed posting is the feed's
 * business (its state filter still finds them).
 */
export const PIPELINE_COLUMNS: { state: JobStateWrite; label: string }[] = [
  { state: 'interested', label: 'Interested' },
  { state: 'saved', label: 'Saved' },
  { state: 'applied', label: 'Applied' },
  { state: 'interviewing', label: 'Interviewing' },
  { state: 'offered', label: 'Offered' },
  { state: 'rejected', label: 'Rejected' }
]

const PRIORITY_LABEL = { 1: 'High', 3: 'Low' } as const

/** Today as YYYY-MM-DD in the viewer's own calendar — follow-ups are calendar dates. */
function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shortDate(isoOrDate: string): string {
  // A bare date is a calendar day: parse it as local midnight, not UTC, or it
  // renders as the day before everywhere west of Greenwich.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)
    ? new Date(`${isoOrDate}T00:00:00`)
    : new Date(isoOrDate)
  return Number.isNaN(d.getTime())
    ? isoOrDate
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** High first, unset counts as normal; then the nearest follow-up; then most recently moved. */
function byUrgency(a: PipelineItem, b: PipelineItem): number {
  const pa = a.tracking.priority ?? 2
  const pb = b.tracking.priority ?? 2
  if (pa !== pb) return pa - pb
  const fa = a.tracking.follow_up_at ?? '9999'
  const fb = b.tracking.follow_up_at ?? '9999'
  if (fa !== fb) return fa < fb ? -1 : 1
  return a.updated_at < b.updated_at ? 1 : -1
}

function FollowUpChip({ date, today }: { date: string; today: string }) {
  const when = date < today ? 'overdue' : date === today ? 'today' : 'upcoming'
  const text =
    when === 'overdue'
      ? `Follow up — was ${shortDate(date)}`
      : when === 'today'
        ? 'Follow up today'
        : `Follow up ${shortDate(date)}`
  return (
    <span className={`jp-pipe-chip jp-pipe-chip--${when}`} data-testid="pipe-follow-up">
      {text}
    </span>
  )
}

function PipelineCard({
  item,
  today,
  onSelect,
  onMove,
  moving
}: {
  item: PipelineItem
  today: string
  onSelect: (jobId: string) => void
  onMove: (jobId: string, state: JobStateWrite) => void
  moving: boolean
}) {
  const priority = item.tracking.priority
  const priorityLabel = priority === 1 || priority === 3 ? PRIORITY_LABEL[priority] : null
  return (
    <li
      className={`jp-pipe-card${moving ? ' jp-pipe-card--moving' : ''}`}
      draggable={!moving}
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', item.job_id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      data-testid="pipe-card"
      data-job-id={item.job_id}
    >
      {/* Same role+tabIndex pattern as JobCard: the move control lives in the
          card, and a <select> cannot sit inside a <button>. */}
      <div
        role="button"
        tabIndex={0}
        className="jp-pipe-card__open"
        onClick={() => onSelect(item.job_id)}
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(item.job_id)
          }
        }}
      >
        <div className="jp-pipe-card__head">
          <span className="jp-pipe-card__company">{item.company}</span>
          {priorityLabel && (
            <span className={`jp-pipe-chip jp-pipe-chip--priority-${priority}`}>
              {priorityLabel}
            </span>
          )}
        </div>
        <span className="jp-pipe-card__title">{item.title}</span>
        <span className="jp-pipe-card__meta">
          {item.applied_at
            ? `Applied ${shortDate(item.applied_at)}`
            : `Updated ${shortDate(item.updated_at)}`}
          {item.location && ` · ${item.location}`}
        </span>
        {(item.tracking.follow_up_at ?? item.application_status ?? item.tracking.contact_name) && (
          <div className="jp-pipe-card__chips">
            {item.tracking.follow_up_at && (
              <FollowUpChip date={item.tracking.follow_up_at} today={today} />
            )}
            {item.application_status && (
              <span className="jp-pipe-chip jp-pipe-chip--neutral" title="Apply queue status">
                Runner: {item.application_status.replace('_', ' ')}
              </span>
            )}
            {item.tracking.contact_name && (
              <span className="jp-pipe-chip jp-pipe-chip--neutral">
                {item.tracking.contact_name}
              </span>
            )}
          </div>
        )}
      </div>
      <select
        className="jp-pipe-card__move"
        aria-label={`Move ${item.company} — ${item.title}`}
        value={item.state}
        disabled={moving}
        onChange={e => onMove(item.job_id, e.target.value as JobStateWrite)}
      >
        {PIPELINE_COLUMNS.map(c => (
          <option key={c.state} value={c.state}>
            {c.label}
          </option>
        ))}
        <option value="dismissed">Dismiss</option>
      </select>
    </li>
  )
}

/**
 * The V5 board: every posting the caller has a state for, one column per
 * state. Moving a card is a PUT /jobs/:id/state, so the server writes the
 * timeline row exactly as the drawer's buttons do — the board is another way
 * to press them, not a second source of truth.
 *
 * Moves are optimistic and shadow the fetched list until the next read lands;
 * a failed move drops its shadow, so the card returns to where the server says
 * it is.
 */
export function PipelineBoard({ auth, onSelect, reloadKey }: Props) {
  const {
    data,
    loading,
    error: loadError,
    reload
  } = useResource('pipeline', () => getPipeline(auth))
  const [moves, setMoves] = useState<Record<string, JobStateWrite>>({})
  const [moving, setMoving] = useState<Set<string>>(new Set())
  const [moveError, setMoveError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [dropTarget, setDropTarget] = useState<JobStateWrite | null>(null)
  const today = localToday()

  useEffect(() => {
    if (reloadKey === 0) return
    invalidateResource('pipeline')
    reload()
    // reload is a fresh closure each render; reloadKey is what asks for it.
  }, [reloadKey])

  // A fresh read is the server's word on every card, so the shadows go.
  useEffect(() => setMoves({}), [data])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? [])
      .map(i => (moves[i.job_id] ? { ...i, state: moves[i.job_id] } : i))
      .filter(i => i.state !== 'dismissed')
      .filter(i => !q || i.company.toLowerCase().includes(q) || i.title.toLowerCase().includes(q))
  }, [data, moves, query])

  const due = items.filter(i => i.tracking.follow_up_at && i.tracking.follow_up_at <= today)

  const move = async (jobId: string, state: JobStateWrite) => {
    const current = items.find(i => i.job_id === jobId)
    if (!current || current.state === state || moving.has(jobId)) return
    setMoveError(null)
    setMoves(m => ({ ...m, [jobId]: state }))
    setMoving(s => new Set(s).add(jobId))
    try {
      await setJobState(jobId, state, auth)
      // The drawer and the feed both cache this posting's state.
      invalidateResource(`job:${jobId}:`)
      invalidateResource('jobs:')
      invalidateResource('pipeline')
      reload()
    } catch (err) {
      setMoves(m => {
        const next = { ...m }
        delete next[jobId]
        return next
      })
      setMoveError(
        `Could not move ${current.company}: ${err instanceof JobsApiError ? err.message : 'request failed'}`
      )
    } finally {
      setMoving(s => {
        const next = new Set(s)
        next.delete(jobId)
        return next
      })
    }
  }

  const onDrop = (state: JobStateWrite) => (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setDropTarget(null)
    const jobId = e.dataTransfer.getData('text/plain')
    if (jobId) void move(jobId, state)
  }

  const needsAuth = loadError instanceof JobsApiError && loadError.status === 403
  if (loading) return <p className="jp-muted">Loading your pipeline…</p>
  if (needsAuth)
    return <p className="jp-muted">The pipeline is per-account — sign in to see yours.</p>
  if (loadError)
    return (
      <p className="jp-error">
        {loadError instanceof JobsApiError ? loadError.message : 'Failed to load the pipeline'}
      </p>
    )

  if ((data ?? []).length === 0)
    return (
      <p className="jp-muted">
        Nothing in your pipeline yet. Mark a posting interested, save it or apply from the feed, and
        it lands here.
      </p>
    )

  return (
    <div className="jp-pipe">
      <div className="jp-pipe__toolbar">
        <input
          type="search"
          className="jp-jobs__search"
          placeholder="Filter by company or title"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Filter the pipeline"
        />
        <span className="jp-pipe__summary" data-testid="pipe-summary">
          {items.length} in play
          {due.length > 0 && (
            <>
              {' · '}
              <strong>
                {due.length} follow-up{due.length === 1 ? '' : 's'} due
              </strong>
            </>
          )}
        </span>
      </div>
      {moveError && <p className="jp-error">{moveError}</p>}
      <div className="jp-pipe__board">
        {PIPELINE_COLUMNS.map(col => {
          const cards = items.filter(i => i.state === col.state).sort(byUrgency)
          return (
            <section
              key={col.state}
              className={`jp-pipe__col jp-pipe__col--${col.state}${
                dropTarget === col.state ? ' jp-pipe__col--drop' : ''
              }`}
              aria-label={col.label}
              data-testid={`pipe-col-${col.state}`}
              onDragOver={e => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropTarget !== col.state) setDropTarget(col.state)
              }}
              onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
              }}
              onDrop={onDrop(col.state)}
            >
              <h3 className="jp-pipe__col-head">
                <span className={`jp-jobcard__state jp-jobcard__state--${col.state}`}>
                  {col.label}
                </span>
                <span className="jp-pipe__count">{cards.length}</span>
              </h3>
              <ul className="jp-pipe__cards">
                {cards.map(item => (
                  <PipelineCard
                    key={item.job_id}
                    item={item}
                    today={today}
                    onSelect={onSelect}
                    onMove={(id, s) => void move(id, s)}
                    moving={moving.has(item.job_id)}
                  />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
