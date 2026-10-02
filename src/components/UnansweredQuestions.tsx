import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  forgetAnswer,
  listAnswers,
  listUnansweredQuestions,
  saveAnswer,
  JobsApiError,
  type SimilarAnswer,
  type StandingAnswer,
  type UnansweredQuestion
} from '../api/jobs'
import type { Auth } from '../api/auth'
import { matchOption } from './matchOption'

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
/**
 * Answered questions that look like this one, and how they differ.
 *
 * Deliberately NOT a pre-filled answer. The runner's own matcher refuses to
 * transfer between these wordings, because the words that differ are usually
 * the whole question — "authorized to work in the United States" and the same
 * sentence ending "in Canada" share everything that is not the answer. Four
 * real false statements about legal work authorization came from overlap
 * scoring before that rule existed.
 *
 * So this shows the difference and offers to COPY the old answer into the box,
 * where it still has to be read and saved. One click of typing saved; no
 * clicks of judgement skipped.
 */
function DuplicateFlags({
  similar,
  onCopy
}: {
  similar: SimilarAnswer[]
  onCopy: (answer: string) => void
}) {
  if (similar.length === 0) return null
  return (
    <details className="jp-questions__dupes">
      <summary>{similar.length} similar answered</summary>
      <ul>
        {similar.map(s => (
          <li key={s.question_key} className="jp-questions__dupe">
            <p className="jp-questions__dupe-q">{s.question}</p>
            <p className="jp-questions__dupe-a">
              <strong>{s.answer || <em>(blank)</em>}</strong>
            </p>
            {s.polarity_differs && (
              <p className="jp-questions__dupe-warn">
                Opposite phrasing — copying would state the reverse.
              </p>
            )}
            {/*
              The difference, spelled out. `only_in_pending` is what the new
              question asks that the old answer never covered — the half that
              actually decides whether it transfers.
            */}
            {s.only_in_pending.length > 0 && (
              <p className="jp-questions__dupe-diff">
                also asks: <code>{s.only_in_pending.join(', ')}</code>
              </p>
            )}
            {s.only_in_answered.length > 0 && (
              <p className="jp-questions__dupe-diff">
                yours was about: <code>{s.only_in_answered.join(', ')}</code>
              </p>
            )}
            {s.runner_would_match && (
              <p className="jp-questions__dupe-diff">covers this one already</p>
            )}
            <button
              type="button"
              className="jp-questions__dupe-copy"
              onClick={() => onCopy(s.answer)}
            >
              Use this answer
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * One personal fact, every employer's wording of it, confirmed together.
 *
 * The runner will not carry an answer across wordings on its own, because the
 * words that differ are sometimes the whole question ("…in Canada"). That is
 * right, and it made the owner type "No" to sponsorship nine times. A family
 * is the narrow set of facts that do not vary by employer
 * (worker/src/questionFamily.ts); here every wording is listed, each with its
 * own picker pre-filled from what the owner said before, and nothing is saved
 * until they press the button. A wording whose options do not clearly match
 * starts unticked and blank — the owner picks it, never us.
 */
function FamilyCard({
  label,
  members,
  prior,
  saving,
  onSave
}: {
  label: string
  members: UnansweredQuestion[]
  prior: string[]
  saving: boolean
  onSave: (entries: { question: UnansweredQuestion; answer: string }[]) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(members.map(m => [m.question_key, m.suggested ?? '']))
  )
  const [chosen, setChosen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(members.map(m => [m.question_key, m.suggested !== null]))
  )
  const [shared, setShared] = useState(prior[0] ?? '')

  /** One answer, matched to each board's own option text — or left to the owner. */
  function applyToAll() {
    const nextValues = { ...values }
    const nextChosen = { ...chosen }
    for (const m of members) {
      const hit = matchOption(shared, m.options)
      nextValues[m.question_key] = hit ?? ''
      nextChosen[m.question_key] = hit !== null
    }
    setValues(nextValues)
    setChosen(nextChosen)
  }

  const ready = members.filter(
    m => chosen[m.question_key] && (values[m.question_key] ?? '').trim() !== ''
  )
  const blocking = members.reduce((n, m) => n + m.blocking, 0)

  return (
    <li className="jp-questions__row jp-family">
      <p className="jp-questions__q">{label}</p>
      <p className="jp-questions__meta">
        {blocking > 0 && (
          <strong>
            blocking {blocking} application{blocking === 1 ? '' : 's'} ·{' '}
          </strong>
        )}
        asked {members.length} way{members.length === 1 ? '' : 's'}
      </p>
      {prior.length > 0 && (
        <p className="jp-family__prior">
          You&apos;ve answered this as{' '}
          {prior.map((a, i) => (
            <span key={a}>
              {i > 0 && ' · '}
              <strong>{a}</strong>
            </span>
          ))}
        </p>
      )}
      <div className="jp-questions__answer">
        <input
          type="text"
          value={shared}
          placeholder="Your answer"
          onChange={e => setShared(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') applyToAll()
          }}
        />
        <button type="button" className="jp-drawer__cta" onClick={applyToAll}>
          Apply to all
        </button>
      </div>

      <ul className="jp-family__members">
        {members.map(m => (
          <li key={m.question_key} className="jp-family__member">
            <label className="jp-family__pick">
              <input
                type="checkbox"
                checked={!!chosen[m.question_key]}
                onChange={e => setChosen(c => ({ ...c, [m.question_key]: e.target.checked }))}
              />
              <span>
                <span className="jp-family__q">{m.question}</span>
                {m.companies.length > 0 && (
                  <span className="jp-family__who">{m.companies.join(', ')}</span>
                )}
              </span>
            </label>
            {m.saved_answer !== null && (
              <p className="jp-family__rejected">
                Your saved answer “{m.saved_answer}” isn&apos;t one of this board&apos;s options.
              </p>
            )}
            {m.options.length > 0 ? (
              <select
                value={values[m.question_key] ?? ''}
                onChange={e => {
                  const v = e.target.value
                  setValues(d => ({ ...d, [m.question_key]: v }))
                  setChosen(c => ({ ...c, [m.question_key]: v !== '' }))
                }}
              >
                <option value="">Pick an answer…</option>
                {m.options.map(opt => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={values[m.question_key] ?? ''}
                placeholder="Answer"
                onChange={e => setValues(d => ({ ...d, [m.question_key]: e.target.value }))}
              />
            )}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="jp-drawer__cta jp-drawer__cta--primary jp-family__save"
        disabled={saving || ready.length === 0}
        onClick={() =>
          onSave(ready.map(m => ({ question: m, answer: values[m.question_key] ?? '' })))
        }
      >
        {saving ? 'Saving…' : `Save ${ready.length} answer${ready.length === 1 ? '' : 's'}`}
      </button>
    </li>
  )
}

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

  /**
   * The queue as the owner works it: each family once, everything else on its
   * own, ordered by what it is costing. A family's cost is all its wordings
   * together — answering it once clears every one of them.
   */
  const units = useMemo(() => {
    type Unit =
      | {
          kind: 'family'
          id: string
          label: string
          members: UnansweredQuestion[]
          prior: string[]
          cost: number
          seen: number
        }
      | { kind: 'single'; q: UnansweredQuestion; cost: number; seen: number }
    const families = new Map<string, Extract<Unit, { kind: 'family' }>>()
    const out: Unit[] = []
    for (const q of questions) {
      if (q.family) {
        const fam =
          families.get(q.family) ??
          ({
            kind: 'family',
            id: q.family,
            label: q.family_label ?? q.family,
            members: [],
            prior: q.family_answers,
            cost: 0,
            seen: 0
          } as const satisfies Unit)
        const next = {
          ...fam,
          members: [...fam.members, q],
          cost: fam.cost + q.blocking,
          seen: fam.seen + q.applications
        }
        families.set(q.family, next)
      } else {
        out.push({ kind: 'single', q, cost: q.blocking, seen: q.applications })
      }
    }
    out.push(...families.values())
    return out.sort((a, b) => b.cost - a.cost || b.seen - a.seen)
  }, [questions])

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
      const saved = await saveAnswer(
        question.question,
        drafts[question.question_key] ?? question.suggested ?? '',
        auth
      )
      setAnswers(prev => [saved, ...prev.filter(a => a.question_key !== saved.question_key)])
      setQuestions(prev => prev.filter(q => q.question_key !== question.question_key))
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to save')
    } finally {
      setSaving(null)
    }
  }

  /** Save every confirmed wording of one family. Each is its own stored answer. */
  async function handleSaveMany(
    familyId: string,
    entries: { question: UnansweredQuestion; answer: string }[]
  ) {
    setSaving(`family:${familyId}`)
    setError(null)
    const saved: StandingAnswer[] = []
    try {
      for (const { question, answer } of entries) {
        saved.push(await saveAnswer(question.question, answer, auth))
      }
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Failed to save')
    } finally {
      // Whatever landed is kept, even if a later one failed: each is stored
      // independently, so a partial save is a real partial save, not a rollback.
      if (saved.length) {
        const keys = new Set(saved.map(a => a.question_key))
        setAnswers(prev => [...saved, ...prev.filter(a => !keys.has(a.question_key))])
        setQuestions(prev => prev.filter(q => !keys.has(q.question_key)))
      }
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
          {units.map(u =>
            u.kind === 'family' ? (
              <FamilyCard
                key={`family:${u.id}`}
                label={u.label}
                members={u.members}
                prior={u.prior}
                saving={saving === `family:${u.id}`}
                onSave={entries => void handleSaveMany(u.id, entries)}
              />
            ) : (
              <li key={u.q.question_key} className="jp-questions__row">
                <p className="jp-questions__q">{u.q.question}</p>
                {u.q.companies.length > 0 && (
                  <p className="jp-questions__meta">
                    {u.q.blocking > 0 && (
                      <strong>
                        blocking {u.q.blocking} application{u.q.blocking === 1 ? '' : 's'} ·{' '}
                      </strong>
                    )}
                    {u.q.companies.join(', ')}
                  </p>
                )}
                {u.q.saved_answer !== null && (
                  <p className="jp-family__rejected">
                    Your saved answer “{u.q.saved_answer}” isn&apos;t one of this board&apos;s
                    options.
                  </p>
                )}
                <div className="jp-questions__answer">
                  {u.q.options.length > 0 ? (
                    /* Never a text box for a question with choices: the answer
                     has to match the board's option text verbatim to land, so
                     typing "No" where the option reads "No, I am not a current
                     or former Government Official" does nothing at all. */
                    <select
                      value={drafts[u.q.question_key] ?? u.q.suggested ?? ''}
                      onChange={e => setDrafts(d => ({ ...d, [u.q.question_key]: e.target.value }))}
                    >
                      <option value="">Pick an answer…</option>
                      {u.q.options.map(opt => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={drafts[u.q.question_key] ?? u.q.suggested ?? ''}
                      placeholder="Answer"
                      onChange={e => setDrafts(d => ({ ...d, [u.q.question_key]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void handleSave(u.q)
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="jp-drawer__cta jp-drawer__cta--primary"
                    onClick={() => void handleSave(u.q)}
                    disabled={saving === u.q.question_key}
                  >
                    {saving === u.q.question_key ? 'Saving…' : 'Save'}
                  </button>
                </div>
                <DuplicateFlags
                  similar={u.q.similar ?? []}
                  onCopy={answer => setDrafts(d => ({ ...d, [u.q.question_key]: answer }))}
                />
              </li>
            )
          )}
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
