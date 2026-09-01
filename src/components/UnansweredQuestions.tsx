import { useCallback, useEffect, useState } from 'react'
import {
  forgetAnswer,
  listAnswers,
  listUnansweredQuestions,
  saveAnswer,
  JobsApiError,
  type StandingAnswer,
  type UnansweredQuestion
} from '../api/jobs'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
  /** Bumped by the parent after a run, so the queue reflects the latest fills. */
  refreshKey?: number
}

/**
 * The questions the runner met and could not answer, and the answers that
 * retire them.
 *
 * Every fill already reports what it could not answer; that used to dead-end in
 * a CLI listing and a JSON file edited by hand on the runner's machine, so the
 * same question blocked application after application. Answering here stores it
 * once, keyed on the normalized question, and the next board that words it
 * differently gets the same answer.
 *
 * The queue is ordered by what each question is COSTING — how many applications
 * it actually stopped — rather than by when it was seen, because it is a work
 * list and the expensive ones should be at the top.
 */
export function UnansweredQuestions({ auth, refreshKey = 0 }: Props) {
  const [questions, setQuestions] = useState<UnansweredQuestion[]>([])
  const [answers, setAnswers] = useState<StandingAnswer[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAnswered, setShowAnswered] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([listUnansweredQuestions(auth), listAnswers(auth)])
      .then(([q, a]) => {
        setQuestions(q)
        setAnswers(a)
        setError(null)
      })
      .catch((err: unknown) => {
        setError(err instanceof JobsApiError ? err.message : 'Failed to load questions')
      })
      .finally(() => setLoading(false))
  }, [auth])

  useEffect(load, [load, refreshKey])

  async function handleSave(question: UnansweredQuestion) {
    setSaving(question.question_key)
    setError(null)
    try {
      // An empty draft is saved deliberately: "" means "leave this blank on the
      // form", which is a real answer and the only way to retire a question the
      // owner wants skipped.
      const saved = await saveAnswer(question.question, drafts[question.question_key] ?? '', auth)
      setAnswers(prev => [saved, ...prev.filter(a => a.question_key !== saved.question_key)])
      setQuestions(prev => prev.filter(q => q.question_key !== question.question_key))
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to save')
    } finally {
      setSaving(null)
    }
  }

  async function handleForget(key: string) {
    setError(null)
    try {
      setAnswers(await forgetAnswer(key, auth))
      // The question may be owed again now, so re-read rather than guessing.
      setQuestions(await listUnansweredQuestions(auth))
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to forget')
    }
  }

  if (loading) return <p className="jp-muted">Loading questions…</p>

  return (
    <section className="jp-questions">
      <div className="jp-questions__head">
        <h3>Unanswered questions</h3>
        <button
          type="button"
          className="jp-questions__toggle"
          onClick={() => setShowAnswered(v => !v)}
        >
          {showAnswered ? 'Hide' : 'Show'} saved answers ({answers.length})
        </button>
      </div>
      {error && <p className="jp-error">{error}</p>}

      {!questions.length ? (
        <p className="jp-muted">
          Nothing outstanding. Questions the runner cannot answer show up here after a fill.
        </p>
      ) : (
        <ul className="jp-questions__list">
          {questions.map(q => (
            <li key={q.question_key} className="jp-questions__row">
              <p className="jp-questions__q">{q.question}</p>
              <p className="jp-questions__meta">
                {q.blocking > 0 ? (
                  <strong>
                    blocking {q.blocking} application{q.blocking === 1 ? '' : 's'}
                  </strong>
                ) : (
                  'not blocking anything yet'
                )}{' '}
                · asked by {q.companies.join(', ')}
              </p>
              <div className="jp-questions__answer">
                <input
                  type="text"
                  value={drafts[q.question_key] ?? ''}
                  placeholder="Your answer — must match the form's option text exactly"
                  onChange={e => setDrafts(d => ({ ...d, [q.question_key]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void handleSave(q)
                  }}
                />
                <button
                  type="button"
                  className="jp-drawer__cta jp-drawer__cta--primary"
                  onClick={() => void handleSave(q)}
                  disabled={saving === q.question_key}
                >
                  {saving === q.question_key ? 'Saving…' : 'Save'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showAnswered && (
        <ul className="jp-questions__saved">
          {answers.map(a => (
            <li key={a.question_key}>
              <span className="jp-questions__q">{a.question}</span>
              <span className="jp-questions__saved-value">
                {a.answer === '' ? <em>(left blank)</em> : a.answer}
              </span>
              <button
                type="button"
                className="jp-questions__forget"
                onClick={() => void handleForget(a.question_key)}
              >
                Forget
              </button>
            </li>
          ))}
          {!answers.length && <li className="jp-muted">No saved answers yet.</li>}
        </ul>
      )}
    </section>
  )
}
