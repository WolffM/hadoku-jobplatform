import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  listCompanies,
  createCompany,
  deleteCompany,
  probeSlugs,
  lockCompany,
  CompaniesApiError,
  type UserCompany,
  type SlugProbeResult
} from '../api/companies'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
}

/** Split a free-text slug list on commas, whitespace, and newlines. */
function parseSlugs(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tok of raw.split(/[\s,]+/)) {
    const s = tok.trim().toLowerCase()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

export function CompaniesManager({ auth }: Props) {
  const [companies, setCompanies] = useState<UserCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [lastAddNote, setLastAddNote] = useState<string | null>(null)

  // Verify-and-lock state
  const [slugsInput, setSlugsInput] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeResults, setProbeResults] = useState<SlugProbeResult[] | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [lockNames, setLockNames] = useState<Record<string, string>>({})
  const [lockingKey, setLockingKey] = useState<string | null>(null)
  const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listCompanies(auth)
      setCompanies(rows)
    } catch (err) {
      const msg = err instanceof CompaniesApiError ? err.message : 'Failed to load companies'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [auth])

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
      const result = await createCompany(displayName, auth)
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

  const handleProbe = async (e: FormEvent) => {
    e.preventDefault()
    const slugs = parseSlugs(slugsInput)
    if (slugs.length === 0 || probing) return
    setProbing(true)
    setProbeError(null)
    setProbeResults(null)
    setLockedKeys(new Set())
    try {
      const results = await probeSlugs(slugs, undefined, auth)
      setProbeResults(results)
      // Prefill each hit's editable display name with the reported company name
      // (greenhouse) or the slug itself (ashby/lever, which expose no name).
      const names: Record<string, string> = {}
      for (const r of results) {
        for (const hit of r.hits) {
          names[`${r.slug}:${hit.ats}`] = hit.company_name ?? r.slug
        }
      }
      setLockNames(names)
    } catch (err) {
      const msg = err instanceof CompaniesApiError ? err.message : 'Failed to probe slugs'
      setProbeError(msg)
    } finally {
      setProbing(false)
    }
  }

  const handleLock = async (slug: string, ats: string) => {
    const key = `${slug}:${ats}`
    const displayName = (lockNames[key] ?? slug).trim()
    if (!displayName || lockingKey) return
    setLockingKey(key)
    setProbeError(null)
    try {
      await lockCompany(ats, slug, displayName, auth)
      setLockedKeys(prev => new Set(prev).add(key))
      await refresh()
    } catch (err) {
      const msg = err instanceof CompaniesApiError ? err.message : 'Failed to lock company'
      setProbeError(msg)
    } finally {
      setLockingKey(null)
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      await deleteCompany(id, auth)
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

      {/* Verify-and-lock: probe explicit slugs, confirm the right board, lock it in. */}
      <details className="job-platform__probe">
        <summary className="job-platform__probe-summary">
          Not sure of the slug? Verify before subscribing
        </summary>

        <form className="job-platform__companies-form" onSubmit={e => void handleProbe(e)}>
          <input
            type="text"
            placeholder="Slugs to probe (e.g. anthropic, scale, ramp)"
            value={slugsInput}
            onChange={e => setSlugsInput(e.target.value)}
            disabled={probing}
            aria-label="Slugs to probe"
          />
          <button type="submit" disabled={probing || parseSlugs(slugsInput).length === 0}>
            {probing ? 'Probing…' : 'Probe'}
          </button>
        </form>

        {probeError && <p className="job-platform__companies-error">{probeError}</p>}

        {probeResults && (
          <div className="job-platform__probe-results">
            {probeResults.map(r => (
              <div key={r.slug} className="job-platform__probe-slug">
                <div className="job-platform__probe-slug-name">
                  <code>{r.slug}</code>
                </div>
                {r.hits.length === 0 ? (
                  <p className="job-platform__probe-none">
                    No live board found on greenhouse, lever, or ashby.
                  </p>
                ) : (
                  r.hits.map(hit => {
                    const key = `${r.slug}:${hit.ats}`
                    const locked = lockedKeys.has(key)
                    return (
                      <div key={key} className="job-platform__probe-hit">
                        <div className="job-platform__probe-hit-head">
                          <span className="job-platform__probe-ats">{hit.ats}</span>
                          <span className="job-platform__probe-count">
                            {hit.n_jobs} job{hit.n_jobs === 1 ? '' : 's'}
                          </span>
                          {hit.company_name && (
                            <span className="job-platform__probe-company">{hit.company_name}</span>
                          )}
                        </div>
                        {hit.sample_titles.length > 0 && (
                          <p className="job-platform__probe-titles">
                            {hit.sample_titles.slice(0, 5).join(' · ')}
                          </p>
                        )}
                        <div className="job-platform__probe-lock">
                          <input
                            type="text"
                            value={lockNames[key] ?? r.slug}
                            onChange={e =>
                              setLockNames(prev => ({ ...prev, [key]: e.target.value }))
                            }
                            disabled={locked || lockingKey === key}
                            aria-label={`Display name for ${r.slug} on ${hit.ats}`}
                          />
                          <button
                            type="button"
                            onClick={() => void handleLock(r.slug, hit.ats)}
                            disabled={locked || lockingKey !== null}
                          >
                            {locked ? 'Locked ✓' : lockingKey === key ? 'Locking…' : 'Lock in'}
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            ))}
          </div>
        )}
      </details>

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
