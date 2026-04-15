import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  listCompanies,
  createCompany,
  deleteCompany,
  CompaniesApiError,
  type UserCompany
} from '../api/companies'

interface Props {
  apiKey?: string
}

export function CompaniesManager({ apiKey }: Props) {
  const [companies, setCompanies] = useState<UserCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [lastAddNote, setLastAddNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listCompanies(apiKey)
      setCompanies(rows)
    } catch (err) {
      const msg = err instanceof CompaniesApiError ? err.message : 'Failed to load companies'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [apiKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault()
    const displayName = input.trim()
    if (!displayName || submitting) return
    setSubmitting(true)
    setError(null)
    setLastAddNote(null)
    try {
      const result = await createCompany(displayName, apiKey)
      const added = result.companies.length
      const searchNote = result.search_triggered ? 'scrape triggered' : 'scrape NOT triggered'
      setLastAddNote(
        added === 0
          ? `No targets resolved for "${displayName}".`
          : `Added ${added} target${added === 1 ? '' : 's'} for "${displayName}" (${searchNote}). Jobs will appear shortly.`
      )
      setInput('')
      await refresh()
    } catch (err) {
      const msg = err instanceof CompaniesApiError ? err.message : 'Failed to add company'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      await deleteCompany(id, apiKey)
      await refresh()
    } catch (err) {
      const msg = err instanceof CompaniesApiError ? err.message : 'Failed to remove company'
      setError(msg)
    }
  }

  return (
    <div className="job-platform__companies">
      <h2 className="job-platform__companies-title">Subscribed Companies</h2>

      <form className="job-platform__companies-form" onSubmit={e => void handleAdd(e)}>
        <input
          type="text"
          placeholder="Company name (e.g. Stripe, Mistral)"
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={submitting}
          aria-label="Company display name"
        />
        <button type="submit" disabled={submitting || input.trim().length === 0}>
          {submitting ? 'Adding…' : 'Subscribe'}
        </button>
      </form>

      {lastAddNote && <p className="job-platform__companies-note">{lastAddNote}</p>}
      {error && <p className="job-platform__companies-error">{error}</p>}

      {loading ? (
        <p className="job-platform__companies-empty">Loading…</p>
      ) : companies.length === 0 ? (
        <p className="job-platform__companies-empty">
          No subscriptions yet. Add a company above to start receiving jobs.
        </p>
      ) : (
        <ul className="job-platform__companies-list">
          {companies.map(c => (
            <li key={c.id} className="job-platform__companies-item">
              <div className="job-platform__companies-item-main">
                <strong>{c.display_name}</strong>
                <span className="job-platform__companies-item-meta">
                  {c.ats} · {c.slug}
                </span>
              </div>
              <button
                type="button"
                className="job-platform__companies-item-remove"
                onClick={() => void handleDelete(c.id)}
                aria-label={`Remove ${c.display_name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
