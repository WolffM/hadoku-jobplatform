const BASE_URL = '/jobplatform/api'

export type RemotePref = 'remote' | 'hybrid' | 'onsite' | 'any'

/**
 * The two orthogonal axes of "what kind of role". `track` answers "does it have
 * direct reports?" and is applied server-side as a hard filter; `levels` are
 * rungs on that track's ladder and are scored by distance.
 *
 * They replaced a single flat `role_types` list that mixed the two — where
 * 'senior' and 'manager' were alternatives to each other, so the only
 * expressible query was "any of these words is in the title".
 */
export type ProfileTrack = 'ic' | 'manager' | 'either'

export const IC_LEVELS = ['junior', 'mid', 'senior', 'staff', 'principal', 'fellow'] as const
export const MANAGER_LEVELS = ['manager', 'senior_manager', 'director', 'vp', 'cxo'] as const

export type IcLevel = (typeof IC_LEVELS)[number]
export type ManagerLevel = (typeof MANAGER_LEVELS)[number]
export type RoleLevel = IcLevel | ManagerLevel

/** Ladder rungs are stored snake_case; these are what the user reads. */
export const LEVEL_LABELS: Record<RoleLevel, string> = {
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  staff: 'Staff',
  principal: 'Principal',
  fellow: 'Distinguished / Fellow',
  manager: 'Manager',
  senior_manager: 'Senior Manager',
  director: 'Director',
  vp: 'VP / Head of',
  cxo: 'C-level'
}

export interface JobProfile {
  id: string
  name: string
  keywords: string[]
  track: ProfileTrack
  levels: RoleLevel[]
  remote_pref: RemotePref
  created_at: string
  /** True for the shared default profile. */
  is_default: boolean
}

export interface ProfileInput {
  name: string
  keywords: string[]
  track: ProfileTrack
  levels: RoleLevel[]
  remote_pref: RemotePref
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
