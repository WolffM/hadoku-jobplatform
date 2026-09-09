import { useState } from 'react'
import {
  approveApplication,
  listApplications,
  JobsApiError,
  type ApplicationStatus,
  type ApplicationSummary
} from '../api/jobs'
import type { Auth } from '../api/auth'
import { useResource } from '../api/useResource'
import { UnansweredQuestions } from './UnansweredQuestions'

interface Props {
  auth: Auth
}

/** What each status means to the person reading the list. */
const STATUS_COPY: Record<ApplicationStatus, string> = {
  queued: 'waiting for the runner',
  filled: 'filled — review the screenshot, then approve',
  approved: 'approved — the runner will submit it on its next run with --submit',
  submitted: 'submitted',
  needs_manual: 'needs you: the runner stopped rather than guess',
  failed: 'failed',
  job_closed: 'the posting was taken down before this could be sent'
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * The screenshot the runner stored for this row, if it left one.
 *
 * It is a path on the RUNNER'S machine (`data/apply/shots/<id>/filled.png`),
 * not a URL — nothing serves it, so it cannot be linked or rendered here. It is
 * shown as a path, labelled as one, because a browser that silently fails to
 * load an image reads as "there was no screenshot" rather than "it is over
 * there". The answers table below is what actually makes this row reviewable.
 */
function evidenceShot(app: ApplicationSummary): string | null {
  const shot = app.evidence?.screenshot
  return typeof shot === 'string' && shot ? shot : null
}

/**
 * What the runner actually entered, question by question.
 *
 * This is the review material. It arrives only from runners at or past the
 * scraper's `9bd3593`; before that the dashboard got the fingerprint — a digest
 * of these values — without the values, so Approve was a gate over content it
 * could not display. An older row therefore has a digest and no table, and
 * saying so is better than rendering an empty panel that looks like an
 * application with nothing in it.
 */
function filledAnswers(app: ApplicationSummary): [string, string][] {
  const a = app.evidence?.answers
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return []
  return Object.entries(a as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .sort(([x], [y]) => x.localeCompare(y))
}

/** Questions the fill left blank — part of what an approval covers. */
function blankQuestions(app: ApplicationSummary): string[] {
  const u = app.evidence?.unmatched
  return Array.isArray(u) ? u.filter((q): q is string => typeof q === 'string') : []
}

/**
 * The digest of the fill on screen — what an approval would actually bind to.
 *
 * A `filled` row without one cannot be approved: the runner would have nothing
 * to check its re-fill against and would send whatever a fresh LLM draft
 * produced, which is not what the screenshot shows.
 */
function fillDigest(app: ApplicationSummary): string | null {
  const fp = app.evidence?.fingerprint
  return typeof fp === 'string' && fp ? fp : null
}

/**
 * The Applications view: the approve-to-apply queue (issue #15).
 *
 * This is a workflow, not a reference list — the one action it offers is
 * Approve, and only on `filled` rows. That is the review-mode contract: the
 * runner fills the form and stops with a screenshot, and nothing reaches an
 * employer until a human has looked at that screenshot and said yes here.
 */
export function ApplicationsList({ auth }: Props) {
  const [approving, setApproving] = useState<string | null>(null)
  const [approveError, setApproveError] = useState<string | null>(null)
  // Approvals land here so a row reflects its new status without refetching
  // the queue; the cache keeps the rest of the list as it was.
  const [approved, setApproved] = useState<Record<string, ApplicationSummary>>({})

  const {
    data,
    loading,
    error: loadError
  } = useResource<ApplicationSummary[]>('applications', () => listApplications(undefined, auth))

  const needsAuth = loadError instanceof JobsApiError && loadError.status === 403
  const apps: ApplicationSummary[] = (data ?? []).map(a => approved[a.id] ?? a)
  const error =
    approveError ??
    (loadError && !needsAuth
      ? loadError instanceof JobsApiError
        ? loadError.message
        : 'Failed to load applications'
      : null)

  async function handleApprove(app: ApplicationSummary) {
    setApproving(app.id)
    setApproveError(null)
    try {
      const updated = await approveApplication(app.id, auth)
      setApproved(prev => ({ ...prev, [updated.id]: updated }))
    } catch (err) {
      setApproveError(err instanceof JobsApiError ? err.message : 'Failed to approve')
    } finally {
      setApproving(null)
    }
  }

  if (needsAuth) return <p className="jp-muted">Sign in to see your applications.</p>
  if (loading) return <p className="jp-muted">Loading applications…</p>

  // The questions section sits ABOVE the queue and outside the empty-state
  // early return. An unanswered question is usually WHY the rows below are
  // stuck, so it is the thing to act on first — and with an empty queue it is
  // still the only way to reach saved answers.
  if (!apps.length) {
    return (
      <div className="jp-applications">
        <UnansweredQuestions auth={auth} />
        <p className="jp-muted">No applications queued.</p>
      </div>
    )
  }

  return (
    <div className="jp-applications">
      <UnansweredQuestions auth={auth} />
      {error && <p className="jp-error">{error}</p>}
      <ul className="jp-applications__list">
        {apps.map(app => {
          const shot = evidenceShot(app)
          const digest = fillDigest(app) ?? app.approved_fingerprint
          const answers = filledAnswers(app)
          const blanks = blankQuestions(app)
          const answeredSince = app.answered_since ?? []
          const overridden = app.overridden ?? []
          // Fall back to the raw blob only when the worker predates
          // reconciliation, so an older deployment still lists what is owed.
          const stillUnanswered = app.still_unanswered ?? (app.answered_since ? [] : blanks)
          return (
            <li key={app.id} className={`jp-applications__row jp-applications__row--${app.status}`}>
              <div className="jp-applications__head">
                <span className="jp-applications__title">{app.title}</span>
                <span className="jp-applications__company">{app.company}</span>
                <span className={`jp-applications__status jp-applications__status--${app.status}`}>
                  {app.status}
                </span>
              </div>
              <p className="jp-applications__meta">
                {STATUS_COPY[app.status]} · {app.mode} mode · updated {formatWhen(app.updated_at)}
              </p>
              {app.error && <p className="jp-error">{app.error}</p>}
              {shot && (
                <p className="jp-applications__evidence">
                  Screenshot (on the runner&rsquo;s machine, not served): <code>{shot}</code>
                </p>
              )}
              {/*
                The fill itself. Open by default on a row awaiting approval,
                because that is the one moment the contents matter, and collapsed
                once the decision is made.
              */}
              {(answers.length > 0 || blanks.length > 0) && (
                <details className="jp-applications__fill" open={app.status === 'filled'}>
                  <summary>
                    Review what was filled ({answers.length} answered
                    {blanks.length > 0 && `, ${blanks.length} left blank`})
                  </summary>
                  {answers.length > 0 && (
                    <table className="jp-applications__answers">
                      <tbody>
                        {answers.map(([q, a]) => (
                          <tr key={q}>
                            <th scope="row">{q}</th>
                            <td>{a}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {blanks.length > 0 && (
                    <>
                      <p className="jp-applications__blank-head">
                        Left blank &mdash; approving covers these too:
                      </p>
                      <ul className="jp-applications__blanks">
                        {blanks.map(q => (
                          <li key={q}>{q}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </details>
              )}
              {/*
                What has changed since the photograph was taken. The stored
                evidence is left exactly as the runner wrote it — an approval
                refers to it — so this is the only place that says the snapshot
                has gone out of date.
              */}
              {overridden.length > 0 && (
                <div className="jp-applications__override">
                  <p className="jp-applications__override-head">
                    {overridden.length} answer{overridden.length === 1 ? ' was' : 's were'} filled
                    with something other than what you have saved. The runner&rsquo;s local profile
                    wins over the dashboard, so this is what the form actually says:
                  </p>
                  <ul>
                    {overridden.map(o => (
                      <li key={o.question}>
                        <span className="jp-applications__override-q">{o.question}</span>
                        <br />
                        on the form: <strong>{o.filled}</strong>
                        <br />
                        you saved: <span className="jp-muted">{o.stored}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {answeredSince.length > 0 && (
                <div className="jp-applications__resolved">
                  <p>
                    {answeredSince.length} question{answeredSince.length === 1 ? '' : 's'} this fill
                    could not answer {answeredSince.length === 1 ? 'has' : 'have'} been answered
                    since. Re-queue to apply {answeredSince.length === 1 ? 'it' : 'them'}:
                  </p>
                  <ul>
                    {answeredSince.map(a => (
                      <li key={a.question}>
                        {a.question} &rarr; <strong>{a.answer}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {stillUnanswered.length > 0 && (
                <div className="jp-applications__owed">
                  <p>
                    Still unanswered &mdash; answer {stillUnanswered.length === 1 ? 'it' : 'these'}{' '}
                    under Unanswered questions, then re-queue:
                  </p>
                  <ul>
                    {stillUnanswered.map(q => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              {answers.length === 0 && digest && app.status === 'filled' && (
                <p className="jp-applications__evidence jp-applications__evidence--warn">
                  This fill was recorded before the runner sent its answers, so there is nothing to
                  review here &mdash; only the screenshot on the runner&rsquo;s machine. Re-run the
                  fill to get a reviewable record.
                </p>
              )}
              {digest && (
                <p className="jp-applications__evidence">
                  {app.approved_fingerprint ? 'Approved fill' : 'This fill'}:{' '}
                  <code>{digest.slice(0, 12)}</code>
                </p>
              )}
              {app.status === 'filled' &&
                (digest ? (
                  <button
                    type="button"
                    className="jp-drawer__cta jp-drawer__cta--primary"
                    onClick={() => void handleApprove(app)}
                    disabled={approving === app.id}
                  >
                    {approving === app.id ? 'Approving…' : 'Approve for submission'}
                  </button>
                ) : (
                  <p className="jp-muted">
                    Filled by a runner that did not record what it filled, so there is nothing to
                    approve against. Re-run the fill.
                  </p>
                ))}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
