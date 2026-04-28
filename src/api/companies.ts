/**
 * Thin fetch wrapper for the /jobplatform/api/companies routes.
 *
 * Auth model: see `./auth.ts`. Either `sessionId` or `apiKey` (legacy);
 * the helper sends X-Session-Id and/or X-User-Key. Edge-router injects
 * X-User-Key on the proxied request when X-Session-Id is present.
 */

import { authHeaders, authCreds, type Auth } from './auth'

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
    credentials: authCreds(auth)
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
    credentials: authCreds(auth),
    body: JSON.stringify({ display_name: displayName })
  })
  return parseWrapped<CreateCompanyResponse>(response)
}

export async function deleteCompany(id: string, auth?: Auth): Promise<void> {
  const response = await fetch(`${BASE_URL}/companies/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(auth),
    credentials: authCreds(auth)
  })
  await parseWrapped<{ deleted: true; id: string }>(response)
}
