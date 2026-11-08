import { useState } from 'react'
import { JobsApiError, type JobStateWrite } from '../api/jobs'
import { importPosting, type ImportedPosting } from '../api/pipeline'
import type { Auth } from '../api/auth'

type ImportState = Exclude<JobStateWrite, 'dismissed'>

const STATES: { value: ImportState; label: string }[] = [
  { value: 'saved', label: 'Saved' },
  { value: 'interested', label: 'Interested' },
  { value: 'applied', label: 'Applied' },
  { value: 'interviewing', label: 'Interviewing' }
]

/**
 * "Add a posting by URL": for the job found somewhere the scraper doesn't
 * look. The server reads the posting (Greenhouse, Lever and Ashby through
 * their APIs; other career sites from their structured data), stores it like
 * any scraped posting, and adds it to the pipeline.
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

  const submit = async () => {
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await importPosting(url.trim(), state, auth)
      setDone(res)
      setUrl('')
      onImported()
    } catch (err) {
      setError(err instanceof JobsApiError ? err.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="jp-import" data-testid="import-posting">
      <form
        className="jp-import__form"
        onSubmit={e => {
          e.preventDefault()
          void submit()
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
        <button
          type="submit"
          className="jp-drawer__cta jp-drawer__cta--primary"
          disabled={busy || !url.trim()}
        >
          {busy ? 'Reading the posting…' : 'Add'}
        </button>
      </form>
      {error && <p className="jp-error">{error}</p>}
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
