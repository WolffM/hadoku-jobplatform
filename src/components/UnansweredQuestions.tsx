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
  const [newQuestion, setNewQuestion] = useState('')
  const [newAnswer, setNewAnswer] = useState('')
  const [adding, setAdding] = useState(false)

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

  /**
   * Answer a question before the runner has ever met it.
   *
   * Without this the store could only be filled by first FAILING an
   * application: a question had to block a fill before there was anywhere to
   * put its answer. That is backwards whenever the owner already knows what a
   * board is going to ask — which is most of the time, since the compliance and
   * demographic blocks are near-identical across employers.
   */
  async function handleAdd() {
    if (!newQuestion.trim()) return
    setAdding(true)
    setError(null)
    try {
      const saved = await saveAnswer(newQuestion, newAnswer, auth)
      setAnswers(prev => [saved, ...prev.filter(a => a.question_key !== saved.question_key)])
      setQuestions(prev => prev.filter(q => q.question_key !== saved.question_key))
      setNewQuestion('')
      setNewAnswer('')
      setShowAnswered(true)
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to save')
    } finally {
      setAdding(false)
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

  // Nothing to answer means nothing to show. An empty panel explaining that it
  // is empty is noise above the queue the owner actually came for.
  if (loading || (!questions.length && !answers.length)) return null

  return (
    <section className="jp-questions">
      <div className="jp-questions__head">
        <h3>Unanswered questions</h3>
        {answers.length > 0 && (
          <button
            type="button"
            className="jp-questions__toggle"
            onClick={() => setShowAnswered(v => !v)}
          >
            {showAnswered ? 'Hide' : 'Show'} saved answers ({answers.length})
          </button>
        )}
      </div>
      {error && <p className="jp-error">{error}</p>}

      {questions.length > 0 && (
        <ul className="jp-questions__list">
          {questions.map(q => (
            <li key={q.question_key} className="jp-questions__row">
              <p className="jp-questions__q">{q.question}</p>
              {q.companies.length > 0 && (
                <p className="jp-questions__meta">
                  {q.blocking > 0 && (
                    <strong>
                      blocking {q.blocking} application{q.blocking === 1 ? '' : 's'} ·{' '}
                    </strong>
                  )}
                  {q.companies.join(', ')}
                </p>
              )}
              <div className="jp-questions__answer">
                <input
                  type="text"
                  value={drafts[q.question_key] ?? ''}
                  placeholder="Answer"
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

      <details className="jp-questions__add">
        <summary>Add another question</summary>
        <input
          type="text"
          value={newQuestion}
          placeholder="Question, e.g. Are you at least 18 years of age?"
          onChange={e => setNewQuestion(e.target.value)}
        />
        <div className="jp-questions__answer">
          <input
            type="text"
            value={newAnswer}
            placeholder="Answer"
            onChange={e => setNewAnswer(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleAdd()
            }}
          />
          <button
            type="button"
            className="jp-drawer__cta"
            onClick={() => void handleAdd()}
            disabled={adding || !newQuestion.trim()}
          >
            {adding ? 'Saving…' : 'Save'}
          </button>
        </div>
      </details>

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
        </ul>
      )}
    </section>
  )
}
