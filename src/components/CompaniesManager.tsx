import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  listCompanies,
  deleteCompany,
  probeSlugs,
  matchCompanies,
  lockCompany,
  CompaniesApiError,
  type UserCompany,
  type SlugProbeResult,
  type CompanyMatch
} from '../api/companies'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
}

/** Split free text into distinct company names on commas/newlines (case kept). */
function parseNames(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tok of raw.split(/[,\n]+/)) {
    const s = tok.trim()
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase())
      out.push(s)
    }
  }
  return out
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

function faviconUrl(domain: string | null): string | null {
  return domain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
    : null
}

export function CompaniesManager({ auth }: Props) {
  const [companies, setCompanies] = useState<UserCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Name-driven prefetch (primary flow)
  const [nameInput, setNameInput] = useState('')
  const [matching, setMatching] = useState(false)
  const [matches, setMatches] = useState<CompanyMatch[] | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)
  const [subscribingKey, setSubscribingKey] = useState<string | null>(null)
  const [subscribedKeys, setSubscribedKeys] = useState<Set<string>>(new Set())

  // Advanced: probe explicit slugs
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

  const handleFind = async (e: FormEvent) => {
    e.preventDefault()
    const names = parseNames(nameInput)
    if (names.length === 0 || matching) return
    setMatching(true)
    setMatchError(null)
    setMatches(null)
    setSubscribedKeys(new Set())
    try {
      const results = await matchCompanies(names, auth)
      setMatches(results)
    } catch (err) {
      setMatchError(err instanceof CompaniesApiError ? err.message : 'Failed to look up company')
    } finally {
      setMatching(false)
    }
  }

  const handleSubscribe = async (m: CompanyMatch) => {
    if (!m.matched || !m.ats || !m.slug || subscribingKey) return
    const key = `${m.ats}:${m.slug}`
    setSubscribingKey(key)
    setMatchError(null)
    try {
      await lockCompany(m.ats, m.slug, m.company_name ?? m.query, auth)
      setSubscribedKeys(prev => new Set(prev).add(key))
      await refresh()
    } catch (err) {
      setMatchError(err instanceof CompaniesApiError ? err.message : 'Failed to subscribe')
    } finally {
      setSubscribingKey(null)
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

      {/* Name-driven prefetch: type a company, we find the right board to confirm. */}
      <form className="job-platform__companies-form" onSubmit={e => void handleFind(e)}>
        <input
          type="text"
          placeholder="Company name (e.g. Scale AI, OpenAI, Ramp)"
          value={nameInput}
          onChange={e => setNameInput(e.target.value)}
          disabled={matching}
          aria-label="Company name"
        />
        <button type="submit" disabled={matching || parseNames(nameInput).length === 0}>
          {matching ? 'Finding…' : 'Find'}
        </button>
      </form>

      {matchError && <p className="job-platform__companies-error">{matchError}</p>}

      {matches && (
        <div className="job-platform__match-results">
          {matches.map(m => {
            const key = m.ats && m.slug ? `${m.ats}:${m.slug}` : m.query
            const subscribed = subscribedKeys.has(key)
            const fav = faviconUrl(m.domain)
            if (!m.matched) {
              return (
                <div
                  key={m.query}
                  className="job-platform__match-card job-platform__match-card--empty"
                >
                  No board found for <strong>{m.query}</strong> on greenhouse, lever, or ashby.
                </div>
              )
            }
            return (
              <div key={key} className="job-platform__match-card">
                <div className="job-platform__match-head">
                  {fav && (
                    <img
                      className="job-platform__match-favicon"
                      src={fav}
                      alt=""
                      width={20}
                      height={20}
                      onError={e => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  )}
                  <strong className="job-platform__match-name">{m.company_name}</strong>
                  <span className="job-platform__probe-ats">{m.ats}</span>
                  <span className="job-platform__match-meta">
                    {m.slug} · {m.n_jobs} job{m.n_jobs === 1 ? '' : 's'}
                  </span>
                </div>
                {m.sample_titles.length > 0 && (
                  <p className="job-platform__probe-titles">
                    {m.sample_titles.slice(0, 5).join(' · ')}
                  </p>
                )}
                <button
                  type="button"
                  className="job-platform__match-confirm"
                  onClick={() => void handleSubscribe(m)}
                  disabled={subscribed || subscribingKey !== null}
                >
                  {subscribed
                    ? 'Subscribed ✓'
                    : subscribingKey === key
                      ? 'Subscribing…'
                      : 'Confirm & subscribe'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {error && <p className="job-platform__companies-error">{error}</p>}

      {/* Advanced: probe explicit slugs when you already know them. */}
      <details className="job-platform__probe">
        <summary className="job-platform__probe-summary">
          Know the exact slug? Probe it directly
        </summary>

        <form className="job-platform__companies-form" onSubmit={e => void handleProbe(e)}>
          <input
            type="text"
            placeholder="Slugs to probe (e.g. anthropic, scaleai, ramp)"
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
          No subscriptions yet. Find a company above to start receiving jobs.
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
