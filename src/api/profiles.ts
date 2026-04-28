const BASE_URL = '/jobplatform/api'

export type RemotePref = 'remote' | 'hybrid' | 'onsite' | 'any'

export interface JobProfile {
  id: string
  name: string
  keywords: string[]
  target_companies: string[]
  role_types: string[]
  min_salary: number | null
  remote_pref: RemotePref
  experience_levels: string[]
  created_at: string
}

export interface ProfileInput {
  name: string
  keywords: string[]
  target_companies: string[]
  role_types: string[]
  min_salary: number | null
  remote_pref: RemotePref
  experience_levels: string[]
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

import { authHeaders, authCreds, type Auth } from './auth'

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
    credentials: authCreds(auth)
  })
  const data = await parseWrapped<{ profiles: JobProfile[] }>(response)
  return data.profiles
}

export async function createProfile(input: ProfileInput, auth?: Auth): Promise<JobProfile> {
  const response = await fetch(`${BASE_URL}/profiles`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: authCreds(auth),
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
    credentials: authCreds(auth),
    body: JSON.stringify(input)
  })
  const data = await parseWrapped<{ profile: JobProfile }>(response)
  return data.profile
}

export async function deleteProfile(id: string, auth?: Auth): Promise<void> {
  const response = await fetch(`${BASE_URL}/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(auth),
    credentials: authCreds(auth)
  })
  await parseWrapped<{ deleted: true; id: string }>(response)
}
