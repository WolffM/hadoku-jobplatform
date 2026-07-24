/**
 * Thin fetch wrapper for the /jobplatform/api/companies routes.
 * Auth model: see `./auth.ts`.
 */

import { authHeaders, type Auth } from './auth'

const BASE_URL = '/jobplatform/api'

export interface UserCompany {
  id: string
  target_id: number
  ats: string
  slug: string
  display_name: string
  added_at: string
}

interface Wrapped<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

interface CreateCompanyResponse {
  companies: UserCompany[]
  skipped: { ats: string; slug: string }[]
  search_triggered: boolean
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

export async function listCompanies(auth?: Auth): Promise<UserCompany[]> {
  const response = await fetch(`${BASE_URL}/companies`, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ companies: UserCompany[] }>(response)
  return data.companies
}

export async function createCompany(
  displayName: string,
  auth?: Auth
): Promise<CreateCompanyResponse> {
  const response = await fetch(`${BASE_URL}/companies`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify({ display_name: displayName })
  })
  return parseWrapped<CreateCompanyResponse>(response)
}

/**
 * Probe explicit slugs (read-only) to preview what each provider returns before
 * locking a target in. Slugs are matched as-is, not resolved from a name.
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

/**
 * Name-driven prefetch: type company names, get the single best board each
 * (most open jobs) to confirm before locking. Read-only.
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
 * Lock in a confirmed (ats, slug) target with an operator-approved display name,
 * bypassing name resolution.
 */
export async function lockCompany(
  ats: string,
  slug: string,
  displayName: string,
  auth?: Auth
): Promise<CreateCompanyResponse> {
  const response = await fetch(`${BASE_URL}/companies`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify({ ats, slug, display_name: displayName })
  })
  return parseWrapped<CreateCompanyResponse>(response)
}

export async function deleteCompany(id: string, auth?: Auth): Promise<void> {
  const response = await fetch(`${BASE_URL}/companies/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  await parseWrapped<{ deleted: true; id: string }>(response)
}
