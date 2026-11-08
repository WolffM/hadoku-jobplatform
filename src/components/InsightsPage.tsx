import { getInsights, type Insights } from '../api/me'
import { JobsApiError } from '../api/jobs'
import type { Auth } from '../api/auth'
import { useResource } from '../api/useResource'

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`)

function shortWeek(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** A headline number. Rates are tiles, not charts: there is one value each. */
function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="jp-ins__stat">
      <span className="jp-ins__stat-label">{label}</span>
      <span className="jp-ins__stat-value">{value}</span>
      <span className="jp-ins__stat-detail">{detail}</span>
    </div>
  )
}

/**
 * One series of horizontal bars with the value written beside each, so the
 * numbers are readable without hovering and the list doubles as the table.
 */
function Bars({
  rows,
  label
}: {
  rows: { name: string; value: number; marked?: boolean; note?: string }[]
  label: string
}) {
  const max = Math.max(1, ...rows.map(r => r.value))
  return (
    <ul className="jp-ins__bars" aria-label={label}>
      {rows.map(r => (
        <li key={r.name} className="jp-ins__bar-row" title={`${r.name}: ${r.value}`}>
          <span className="jp-ins__bar-name">
            {r.name}
            {r.note && <span className="jp-ins__bar-note"> {r.note}</span>}
          </span>
          <span className="jp-ins__bar-track">
            <span
              className={`jp-ins__bar${r.marked ? ' jp-ins__bar--marked' : ''}`}
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="jp-ins__bar-value">{r.value}</span>
        </li>
      ))}
    </ul>
  )
}

/** Applications per week: columns, the peak and the latest labelled, every week on hover. */
function Weekly({ weeks }: { weeks: Insights['weekly_applied'] }) {
  const max = Math.max(1, ...weeks.map(w => w.count))
  const peak = weeks.reduce((best, w, i) => (w.count > weeks[best].count ? i : best), 0)
  const total = weeks.reduce((n, w) => n + w.count, 0)
  return (
    <figure className="jp-ins__weekly">
      <div className="jp-ins__cols" role="list" aria-label="Applications per week">
        {weeks.map((w, i) => {
          const showValue = w.count > 0 && (i === peak || i === weeks.length - 1)
          return (
            <div
              key={w.week}
              className="jp-ins__col"
              role="listitem"
              aria-label={`Week of ${shortWeek(w.week)}: ${w.count}`}
              tabIndex={0}
            >
              <span className="jp-ins__col-tip">
                Week of {shortWeek(w.week)}: <strong>{w.count}</strong>
              </span>
              {showValue && <span className="jp-ins__col-value">{w.count}</span>}
              <span className="jp-ins__col-bar" style={{ height: `${(w.count / max) * 100}%` }} />
            </div>
          )
        })}
      </div>
      <div className="jp-ins__axis" aria-hidden="true">
        {weeks.map((w, i) => (
          <span key={w.week}>{i % 3 === 0 || i === weeks.length - 1 ? shortWeek(w.week) : ''}</span>
        ))}
      </div>
      <figcaption className="jp-muted">
        {total} in the last {weeks.length} weeks
      </figcaption>
    </figure>
  )
}

const WORKPLACE_LABEL: Record<string, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  unknown: 'Not stated'
}

/**
 * The Insights tab: the person's search, summarised from what the app already
 * records — the timeline, the apply queue and their pipeline's postings.
 */
export function InsightsPage({ auth }: { auth: Auth }) {
  const { data, loading, error } = useResource('insights', () => getInsights(auth))

  if (!auth.signedIn) return <p className="jp-muted">Insights are per-account — sign in.</p>
  if (loading) return <p className="jp-muted">Loading insights…</p>
  if (error || !data)
    return (
      <p className="jp-error">
        {error instanceof JobsApiError ? error.message : 'Failed to load insights'}
      </p>
    )

  const { reached, rates } = data
  const tracked = Object.values(data.states).reduce((n, c) => n + c, 0)
  if (tracked === 0 && reached.applied === 0) {
    return (
      <p className="jp-muted" data-testid="insights-empty">
        Nothing to summarise yet. Save, apply to and track postings, and this page fills in.
      </p>
    )
  }

  return (
    <div className="jp-ins" data-testid="insights">
      <div className="jp-ins__stats">
        <Stat label="Applied" value={String(reached.applied)} detail="postings, ever" />
        <Stat
          label="Response rate"
          value={pct(rates.response)}
          detail={`${reached.responded} heard back`}
        />
        <Stat
          label="Interview rate"
          value={pct(rates.interview)}
          detail={`${reached.interviewed} interviewed`}
        />
        <Stat
          label="Offer rate"
          value={pct(rates.offer)}
          detail={`${reached.offered} offer${reached.offered === 1 ? '' : 's'}`}
        />
      </div>

      <section className="jp-ins__panel">
        <h3>Funnel</h3>
        <Bars
          label="Postings that reached each stage"
          rows={[
            { name: 'Applied', value: reached.applied },
            { name: 'Heard back', value: reached.responded },
            { name: 'Interviewed', value: reached.interviewed },
            { name: 'Offered', value: reached.offered }
          ]}
        />
      </section>

      <section className="jp-ins__panel">
        <h3>Weekly pace</h3>
        <Weekly weeks={data.weekly_applied} />
      </section>

      {data.workplace.length > 0 && (
        <section className="jp-ins__panel">
          <h3>Where you applied</h3>
          <Bars
            label="Applications by workplace type"
            rows={data.workplace.map(w => ({
              name: WORKPLACE_LABEL[w.workplace_type] ?? w.workplace_type,
              value: w.count
            }))}
          />
        </section>
      )}

      {data.skills.length > 0 && (
        <section className="jp-ins__panel jp-ins__panel--wide">
          <h3>What your pipeline asks for</h3>
          <p className="jp-muted">
            Across {data.skill_postings} posting{data.skill_postings === 1 ? '' : 's'} you are
            tracking.
          </p>
          <div className="jp-ins__legend" aria-hidden="true">
            <span>
              <span className="jp-ins__swatch jp-ins__swatch--marked" /> In your stack
            </span>
            <span>
              <span className="jp-ins__swatch" /> Not in any profile&apos;s stack
            </span>
          </div>
          <Bars
            label="Skills by how many tracked postings name them"
            rows={data.skills.map(s => ({
              name: s.skill,
              value: s.postings,
              marked: s.in_stack,
              note: s.in_stack ? '✓' : undefined
            }))}
          />
        </section>
      )}
    </div>
  )
}
