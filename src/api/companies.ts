/**
 * Thin fetch wrapper for the /jobplatform/api/companies routes.
 *
 * Auth model: if `apiKey` is provided, it's sent as `X-User-Key`. Otherwise
 * the request goes with `credentials: 'include'` so the hadoku_site
 * edge-router can inject auth from the user's session cookie.
 */

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

export class CompaniesApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'CompaniesApiError'
  }
}

function authHeaders(apiKey?: string): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers['X-User-Key'] = apiKey
  return headers
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

export async function listCompanies(apiKey?: string): Promise<UserCompany[]> {
  const response = await fetch(`${BASE_URL}/companies`, {
    method: 'GET',
    headers: authHeaders(apiKey),
    credentials: apiKey ? 'same-origin' : 'include'
  })
  const data = await parseWrapped<{ companies: UserCompany[] }>(response)
  return data.companies
}

export async function createCompany(
  displayName: string,
  apiKey?: string
): Promise<CreateCompanyResponse> {
  const response = await fetch(`${BASE_URL}/companies`, {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': 'application/json'
    },
    credentials: apiKey ? 'same-origin' : 'include',
    body: JSON.stringify({ display_name: displayName })
  })
  return parseWrapped<CreateCompanyResponse>(response)
}

export async function deleteCompany(id: string, apiKey?: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/companies/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
    credentials: apiKey ? 'same-origin' : 'include'
  })
  await parseWrapped<{ deleted: true; id: string }>(response)
}
