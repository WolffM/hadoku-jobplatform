import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  matchCompanies,
  probeSlugs,
  CompaniesApiError,
  type CompanyMatch,
  type SlugProbeResult
} from '../api/companies'
import {
  listProfileCompanies,
  addProfileCompany,
  removeProfileCompany,
  ProfilesApiError,
  type ProfileCompany
} from '../api/profiles'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
  profileId: string | null
  /** Bumped by the parent when companies change, so the job feed can refetch. */
  onCompaniesChanged?: () => void
}

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

export function CompaniesManager({ auth, profileId, onCompaniesChanged }: Props) {
  const [companies, setCompanies] = useState<ProfileCompany[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [nameInput, setNameInput] = useState('')
  const [matching, setMatching] = useState(false)
  const [matches, setMatches] = useState<CompanyMatch[] | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)
  const [addingKey, setAddingKey] = useState<string | null>(null)

  const [slugsInput, setSlugsInput] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeResults, setProbeResults] = useState<SlugProbeResult[] | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [lockNames, setLockNames] = useState<Record<string, string>>({})
  const [lockingKey, setLockingKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!profileId) {
      setCompanies([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setCompanies(await listProfileCompanies(profileId, auth))
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to load companies')
    } finally {
      setLoading(false)
    }
  }, [auth, profileId])

  useEffect(() => {
    void refresh()
    setMatches(null)
    setProbeResults(null)
  }, [refresh])

  const subscribedKey = (ats: string, slug: string) => `${ats}:${slug}`
  const subscribed = new Set(companies.map(c => subscribedKey(c.ats, c.slug)))

  const add = async (ats: string, slug: string, displayName: string) => {
    if (!profileId || addingKey || lockingKey) return
    setError(null)
    setMatchError(null)
    setProbeError(null)
    try {
      await addProfileCompany(
        profileId,
        { ats, slug, display_name: displayName.trim() || slug },
        auth
      )
      await refresh()
      onCompaniesChanged?.()
    } catch (err) {
      const msg =
        err instanceof CompaniesApiError || err instanceof ProfilesApiError
          ? err.message
          : 'Failed to add company'
      setMatchError(msg)
      throw err
    }
  }

  const handleFind = async (e: FormEvent) => {
    e.preventDefault()
    const names = parseNames(nameInput)
    if (names.length === 0 || matching) return
    setMatching(true)
    setMatchError(null)
    setMatches(null)
    try {
      setMatches(await matchCompanies(names, auth))
    } catch (err) {
      setMatchError(err instanceof CompaniesApiError ? err.message : 'Failed to look up company')
    } finally {
      setMatching(false)
    }
  }

  const handleAdd = async (m: CompanyMatch) => {
    if (!m.matched || !m.ats || !m.slug) return
    const key = subscribedKey(m.ats, m.slug)
    setAddingKey(key)
    try {
      await add(m.ats, m.slug, m.company_name ?? m.query)
    } catch {
      /* surfaced via matchError */
    } finally {
      setAddingKey(null)
    }
  }

  const handleProbe = async (e: FormEvent) => {
    e.preventDefault()
    const slugs = parseSlugs(slugsInput)
    if (slugs.length === 0 || probing) return
    setProbing(true)
    setProbeError(null)
    setProbeResults(null)
    try {
      const results = await probeSlugs(slugs, undefined, auth)
      setProbeResults(results)
      const names: Record<string, string> = {}
      for (const r of results)
        for (const hit of r.hits) names[`${r.slug}:${hit.ats}`] = hit.company_name ?? r.slug
      setLockNames(names)
    } catch (err) {
      setProbeError(err instanceof CompaniesApiError ? err.message : 'Failed to probe slugs')
    } finally {
      setProbing(false)
    }
  }

  const handleLock = async (slug: string, ats: string) => {
    const key = `${slug}:${ats}`
    setLockingKey(key)
    try {
      await add(ats, slug, lockNames[key] ?? slug)
    } catch {
      setProbeError(matchError ?? 'Failed to add company')
    } finally {
      setLockingKey(null)
    }
  }

  const handleRemove = async (companyId: string) => {
    if (!profileId) return
    setError(null)
    try {
      await removeProfileCompany(profileId, companyId, auth)
      await refresh()
      onCompaniesChanged?.()
    } catch (err) {
      setError(err instanceof ProfilesApiError ? err.message : 'Failed to remove company')
    }
  }

  if (!profileId) {
    return (
      <p className="job-platform__companies-empty">
        Select or create a profile to choose the companies in its slice.
      </p>
    )
  }

  return (
    <div className="job-platform__companies">
      <form className="job-platform__companies-form" onSubmit={e => void handleFind(e)}>
        <input
          type="text"
          placeholder="Add a company by name (e.g. Scale AI, OpenAI, Ramp)"
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
            const key = m.ats && m.slug ? subscribedKey(m.ats, m.slug) : m.query
            const already = m.ats && m.slug ? subscribed.has(key) : false
            const fav = faviconUrl(m.domain)
            const zeroJobs = m.matched && m.n_jobs === 0
            if (!m.matched) {
              return (
                <div
                  key={m.query}
                  className="job-platform__match-card job-platform__match-card--empty"
                >
                  No board found for <strong>{m.query}</strong> on greenhouse, lever, or ashby — it
                  may use an ATS we don’t scrape yet (e.g. Workday) or a different slug.
                </div>
              )
            }
            return (
              <div
                key={key}
                className={
                  zeroJobs
                    ? 'job-platform__match-card job-platform__match-card--warn'
                    : 'job-platform__match-card'
                }
              >
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
                {zeroJobs && (
                  <p className="job-platform__match-warn">
                    ⚠ 0 open roles — can’t confirm this is the right company (the board may be stale
                    or a different one on {m.ats}). Add anyway if you’re sure.
                  </p>
                )}
                <button
                  type="button"
                  className="job-platform__match-confirm"
                  onClick={() => void handleAdd(m)}
                  disabled={already || addingKey !== null}
                >
                  {already
                    ? 'Added ✓'
                    : addingKey === key
                      ? 'Adding…'
                      : zeroJobs
                        ? 'Add anyway'
                        : 'Confirm & add'}
                </button>
              </div>
            )
          })}
        </div>
      )}

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
                    const already = subscribed.has(subscribedKey(hit.ats, r.slug))
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
                            disabled={already || lockingKey === key}
                            aria-label={`Display name for ${r.slug} on ${hit.ats}`}
                          />
                          <button
                            type="button"
                            onClick={() => void handleLock(r.slug, hit.ats)}
                            disabled={already || lockingKey !== null}
                          >
                            {already ? 'Added ✓' : lockingKey === key ? 'Adding…' : 'Add'}
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
          No companies yet. Add one above to fill this profile’s feed.
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
                onClick={() => void handleRemove(c.id)}
                aria-label={`Remove ${c.display_name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="job-platform__companies-error">{error}</p>}
    </div>
  )
}
