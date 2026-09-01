import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { matchCompanies, CompaniesApiError, type CompanyMatch } from '../api/companies'
import {
  listProfileCompanies,
  addProfileCompany,
  removeProfileCompany,
  ProfilesApiError,
  type ProfileCompany
} from '../api/profiles'
import type { Auth } from '../api/auth'
import { invalidateResource } from '../api/resource'
import { useResource } from '../api/useResource'

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

function faviconUrl(domain: string | null): string | null {
  return domain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
    : null
}

export function CompaniesManager({ auth, profileId, onCompaniesChanged }: Props) {
  const [actionError, setActionError] = useState<string | null>(null)

  const [nameInput, setNameInput] = useState('')
  const [matching, setMatching] = useState(false)
  const [matches, setMatches] = useState<CompanyMatch[] | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)
  const [addingKey, setAddingKey] = useState<string | null>(null)

  const {
    data,
    loading,
    error: loadError,
    reload
  } = useResource<ProfileCompany[]>(
    `profile-companies:${profileId ?? ''}`,
    () => listProfileCompanies(profileId ?? '', auth),
    { enabled: Boolean(profileId) }
  )

  const companies: ProfileCompany[] = profileId ? (data ?? []) : []
  const error =
    actionError ??
    (loadError
      ? loadError instanceof ProfilesApiError
        ? loadError.message
        : 'Failed to load companies'
      : null)

  // A write changed the slice, so the cached list is wrong — drop it and re-read.
  const refresh = useCallback(() => {
    invalidateResource(`profile-companies:${profileId ?? ''}`)
    reload()
  }, [profileId, reload])

  useEffect(() => {
    setMatches(null)
  }, [profileId])

  const subscribedKey = (ats: string, slug: string) => `${ats}:${slug}`
  const subscribed = new Set(companies.map(c => subscribedKey(c.ats, c.slug)))

  const add = async (ats: string, slug: string, displayName: string) => {
    if (!profileId || addingKey) return
    setActionError(null)
    setMatchError(null)
    try {
      await addProfileCompany(
        profileId,
        { ats, slug, display_name: displayName.trim() || slug },
        auth
      )
      refresh()
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

  const handleRemove = async (companyId: string) => {
    if (!profileId) return
    setActionError(null)
    try {
      await removeProfileCompany(profileId, companyId, auth)
      refresh()
      onCompaniesChanged?.()
    } catch (err) {
      setActionError(err instanceof ProfilesApiError ? err.message : 'Failed to remove company')
    }
  }

  if (!profileId) {
    return (
      <p className="job-platform__companies-empty">
        Save the profile first, then add the companies it should track.
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

      {loading ? (
        <p className="job-platform__companies-empty">Loading…</p>
      ) : companies.length === 0 ? (
        <p className="job-platform__companies-empty">
          No companies yet. This profile scores the whole corpus until you add some.
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
