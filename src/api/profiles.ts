const BASE_URL = '/jobplatform/api'

export type RemotePref = 'remote' | 'hybrid' | 'onsite' | 'any'

export interface JobProfile {
  id: string
  name: string
  keywords: string[]
  role_types: string[]
  min_salary: number | null
  remote_pref: RemotePref
  experience_levels: string[]
  created_at: string
  /** True for the shared default profile. */
  is_default: boolean
}

export interface ProfileInput {
  name: string
  keywords: string[]
  role_types: string[]
  min_salary: number | null
  remote_pref: RemotePref
  experience_levels: string[]
}

/** A company that belongs to a profile's slice. */
export interface ProfileCompany {
  id: string
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

export class ProfilesApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'ProfilesApiError'
  }
}

import { authHeaders, type Auth } from './auth'

async function parseWrapped<T>(response: Response): Promise<T> {
  const body = (await response.json()) as Wrapped<T>
  if (!response.ok || !body.success || !body.data) {
    throw new ProfilesApiError(
      body.message ?? body.error ?? `HTTP ${response.status}`,
      response.status
    )
  }
  return body.data
}

export async function listProfiles(auth?: Auth): Promise<JobProfile[]> {
  const response = await fetch(`${BASE_URL}/profiles`, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ profiles: JobProfile[] }>(response)
  return data.profiles
}

export async function createProfile(input: ProfileInput, auth?: Auth): Promise<JobProfile> {
  const response = await fetch(`${BASE_URL}/profiles`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(input)
  })
  const data = await parseWrapped<{ profile: JobProfile }>(response)
  return data.profile
}

export async function updateProfile(
  id: string,
  input: Partial<ProfileInput>,
  auth?: Auth
): Promise<JobProfile> {
  const response = await fetch(`${BASE_URL}/profiles/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(input)
  })
  const data = await parseWrapped<{ profile: JobProfile }>(response)
  return data.profile
}

export async function deleteProfile(id: string, auth?: Auth): Promise<void> {
  const response = await fetch(`${BASE_URL}/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  await parseWrapped<{ deleted: true; id: string }>(response)
}

// ── a profile's companies ───────────────────────────────────────────────────

export async function listProfileCompanies(
  profileId: string,
  auth?: Auth
): Promise<ProfileCompany[]> {
  const response = await fetch(`${BASE_URL}/profiles/${encodeURIComponent(profileId)}/companies`, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ companies: ProfileCompany[] }>(response)
  return data.companies
}

export async function addProfileCompany(
  profileId: string,
  company: { ats: string; slug: string; display_name: string },
  auth?: Auth
): Promise<{ company: ProfileCompany; search_triggered: boolean }> {
  const response = await fetch(`${BASE_URL}/profiles/${encodeURIComponent(profileId)}/companies`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(company)
  })
  return parseWrapped<{ company: ProfileCompany; search_triggered: boolean }>(response)
}

export async function removeProfileCompany(
  profileId: string,
  companyId: string,
  auth?: Auth
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/profiles/${encodeURIComponent(profileId)}/companies/${encodeURIComponent(companyId)}`,
    { method: 'DELETE', headers: authHeaders(auth), credentials: 'include' }
  )
  await parseWrapped<{ deleted: true; id: string }>(response)
}
