/**
 * Company lookups behind the profile "add company" flow.
 * Subscriptions themselves live per-profile — see api/profiles.ts.
 * Auth model: see `./auth.ts`.
 */

import { authHeaders, type Auth } from './auth'

const BASE_URL = '/jobplatform/api'

interface Wrapped<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface ProviderHit {
  ats: string
  company_name: string | null
  n_jobs: number
  sample_titles: string[]
}

export interface SlugProbeResult {
  slug: string
  hits: ProviderHit[]
}

export interface CompanyMatch {
  query: string
  matched: boolean
  ats: string | null
  slug: string | null
  company_name: string | null
  n_jobs: number
  sample_titles: string[]
  domain: string | null
}

export class CompaniesApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'CompaniesApiError'
  }
}

async function parseWrapped<T>(response: Response): Promise<T> {
  const body = (await response.json()) as Wrapped<T>
  if (!response.ok || !body.success || !body.data) {
    throw new CompaniesApiError(
      body.message ?? body.error ?? `HTTP ${response.status}`,
      response.status
    )
  }
  return body.data
}

/**
 * Name-driven prefetch: type company names, get the single best board each
 * (most open jobs) to confirm before adding to a profile. Read-only.
 */
export async function matchCompanies(names: string[], auth?: Auth): Promise<CompanyMatch[]> {
  const response = await fetch(`${BASE_URL}/companies/match`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify({ names })
  })
  const data = await parseWrapped<{ results: CompanyMatch[] }>(response)
  return data.results
}

/**
 * Probe explicit slugs (read-only) to preview what each provider returns.
 * Slugs are matched as-is, not resolved from a name.
 */
export async function probeSlugs(
  slugs: string[],
  providers: string[] | undefined,
  auth?: Auth
): Promise<SlugProbeResult[]> {
  const response = await fetch(`${BASE_URL}/companies/probe`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(providers ? { slugs, providers } : { slugs })
  })
  const data = await parseWrapped<{ results: SlugProbeResult[] }>(response)
  return data.results
}
