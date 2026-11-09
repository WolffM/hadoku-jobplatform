import { useState } from 'react'
import { JobsApiError, type JobStateWrite } from '../api/jobs'
import { importPosting, type ImportedPosting, type ManualPosting } from '../api/pipeline'
import type { Auth } from '../api/auth'

type ImportState = Exclude<JobStateWrite, 'dismissed'>

const STATES: { value: ImportState; label: string }[] = [
  { value: 'saved', label: 'Saved' },
  { value: 'interested', label: 'Interested' },
  { value: 'applied', label: 'Applied' },
  { value: 'interviewing', label: 'Interviewing' }
]

const EMPTY_MANUAL: Required<ManualPosting> = {
  title: '',
  company: '',
  location: '',
  description: ''
}

/**
 * "Add a posting by URL": for the job found somewhere the scraper doesn't
 * look. The server reads the posting (Greenhouse, Lever and Ashby through
 * their APIs; other career sites from their structured data), stores it like
 * any scraped posting, and adds it to the pipeline.
 *
 * When the page can't be read (no structured data, a login wall, a posting
 * already taken down), the person can type it in instead. The URL and the
 * state they picked carry over; only title and company are required.
 */
export function ImportPosting({
  auth,
  onImported,
  onOpen
}: {
  auth: Auth
  onImported: () => void
  onOpen: (jobId: string) => void
}) {
  const [url, setUrl] = useState('')
  const [state, setState] = useState<ImportState>('saved')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<ImportedPosting | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState(EMPTY_MANUAL)

  const run = async (typed?: ManualPosting) => {
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await importPosting(url.trim(), state, auth, typed)
      setDone(res)
      setUrl('')
      setManual(EMPTY_MANUAL)
      setManualOpen(false)
      onImported()
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const setField = (key: keyof ManualPosting, value: string) =>
    setManual(m => ({ ...m, [key]: value }))

  return (
    <div className="jp-import" data-testid="import-posting">
      <form
        className="jp-import__form"
        onSubmit={e => {
          e.preventDefault()
          void run(manualOpen ? manual : undefined)
        }}
      >
        <input
          type="url"
          className="jp-jobs__search"
          placeholder="Add a posting by URL — Greenhouse, Lever, Ashby or a company careers page"
          value={url}
          onChange={e => setUrl(e.target.value)}
          aria-label="Posting URL"
          required
        />
        <select
          className="jp-import__state"
          value={state}
          onChange={e => setState(e.target.value as ImportState)}
          aria-label="Add it as"
        >
          {STATES.map(s => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {!manualOpen && (
          <button
            type="submit"
            className="jp-drawer__cta jp-drawer__cta--primary"
            disabled={busy || !url.trim()}
          >
            {busy ? 'Reading the posting…' : 'Add'}
          </button>
        )}
        {manualOpen && (
          <fieldset className="jp-import__manual" data-testid="import-manual">
            <legend>Type it in</legend>
            <label className="jp-import__field">
              <span>Title *</span>
              <input
                value={manual.title}
                onChange={e => setField('title', e.target.value)}
                required
                maxLength={300}
                data-testid="import-manual-title"
              />
            </label>
            <label className="jp-import__field">
              <span>Company *</span>
              <input
                value={manual.company}
                onChange={e => setField('company', e.target.value)}
                required
                maxLength={200}
                data-testid="import-manual-company"
              />
            </label>
            <label className="jp-import__field">
              <span>Location</span>
              <input
                value={manual.location}
                onChange={e => setField('location', e.target.value)}
                placeholder="Seattle, WA — or Remote"
                maxLength={200}
              />
            </label>
            <label className="jp-import__field jp-import__field--wide">
              <span>Notes or description</span>
              <textarea
                rows={4}
                value={manual.description}
                onChange={e => setField('description', e.target.value)}
                maxLength={20000}
                placeholder="Paste the posting, or what the recruiter told you"
              />
            </label>
            <p className="jp-muted jp-import__field--wide">
              Only people tracking it see a posting added by hand.
            </p>
            <div className="jp-import__actions jp-import__field--wide">
              <button
                type="submit"
                className="jp-drawer__cta jp-drawer__cta--primary"
                disabled={busy || !url.trim() || !manual.title.trim() || !manual.company.trim()}
              >
                {busy ? 'Adding…' : 'Add by hand'}
              </button>
              <button
                type="button"
                className="jp-drawer__link"
                onClick={() => setManualOpen(false)}
              >
                Cancel
              </button>
            </div>
          </fieldset>
        )}
      </form>
      {error && (
        <p className="jp-error" data-testid="import-error">
          {error}
          {!manualOpen && (
            <>
              {' '}
              <button
                type="button"
                className="jp-drawer__link"
                onClick={() => {
                  setManualOpen(true)
                  setError(null)
                }}
                data-testid="import-manual-open"
              >
                Add it by hand instead
              </button>
            </>
          )}
        </p>
      )}
      {!error && !manualOpen && !done && (
        <p className="jp-import__hint">
          <button
            type="button"
            className="jp-drawer__link"
            onClick={() => setManualOpen(true)}
            data-testid="import-manual-start"
          >
            Or type a posting in by hand
          </button>
        </p>
      )}
      {done && (
        <p className="jp-import__done" data-testid="import-result">
          {done.already_tracked
            ? `Already in your pipeline as ${done.state}: `
            : `Added as ${done.state}: `}
          <button type="button" className="jp-drawer__link" onClick={() => onOpen(done.job.id)}>
            {done.job.company} — {done.job.title}
          </button>
          {!done.created && !done.already_tracked && (
            <span className="jp-muted"> (it was already in the feed)</span>
          )}
        </p>
      )}
    </div>
  )
}
