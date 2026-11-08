/**
 * The person's own settings, as opposed to a scoring profile: the applicant
 * profile the Fill extension and the clipboard palette read, and the
 * companies they have hidden from their feed.
 */
import type { Auth } from './auth'
import { call, jsonBody } from './http'

export interface WorkExperience {
  company: string
  title?: string
  current?: boolean
  start_month?: string | number
  start_year?: string | number
  end_month?: string | number
  end_year?: string | number
}

export interface Education {
  school: string
  degree?: string
  discipline?: string
  start_year?: string | number
  end_year?: string | number
}

/**
 * The applicant profile (GET/PUT /applicant-profile). The server checks only
 * name and email; the rest is the document the Fill extension reads. Keys this
 * type does not name (the runner's `canned`, say) are carried through a save
 * untouched — the editor merges into what it read, never replaces it.
 */
export interface ApplicantProfile {
  name: string
  email: string
  phone?: string
  location?: string
  headline?: string
  summary?: string
  linkedin?: string
  github?: string
  portfolio?: string
  work_experience?: WorkExperience[]
  education?: Education[]
  [other: string]: unknown
}

export async function getApplicantProfile(auth?: Auth): Promise<ApplicantProfile | null> {
  const data = await call<{ profile: ApplicantProfile | null }>('/applicant-profile', auth)
  return data.profile
}

export async function saveApplicantProfile(
  profile: ApplicantProfile,
  auth?: Auth
): Promise<string> {
  const data = await call<{ updated_at: string }>(
    '/applicant-profile',
    auth,
    jsonBody('PUT', { profile }),
    true
  )
  return data.updated_at
}

export interface BlockedCompany {
  company: string
  company_key: string
  created_at: string
}

export async function listBlockedCompanies(auth?: Auth): Promise<BlockedCompany[]> {
  const data = await call<{ companies: BlockedCompany[] }>('/blocked-companies', auth)
  return data.companies
}

export async function blockCompany(company: string, auth?: Auth): Promise<BlockedCompany> {
  const data = await call<{ company: BlockedCompany }>(
    '/blocked-companies',
    auth,
    jsonBody('PUT', { company }),
    true
  )
  return data.company
}

export async function unblockCompany(company: string, auth?: Auth): Promise<void> {
  await call<{ deleted: boolean }>(
    `/blocked-companies?company=${encodeURIComponent(company)}`,
    auth,
    { method: 'DELETE' }
  )
}

/** A place the feed's near= filter knows (GET /locations). */
export interface KnownPlace {
  key: string
  label: string
}

export async function searchLocations(q: string, auth?: Auth): Promise<KnownPlace[]> {
  const data = await call<{ locations: KnownPlace[] }>(
    `/locations?q=${encodeURIComponent(q)}&limit=8`,
    auth
  )
  return data.locations
}

export interface Insights {
  states: Record<string, number>
  reached: { applied: number; responded: number; interviewed: number; offered: number }
  rates: { response: number | null; interview: number | null; offer: number | null }
  weekly_applied: { week: string; count: number }[]
  workplace: { workplace_type: string; count: number }[]
  skills: { skill: string; postings: number; in_stack: boolean }[]
  skill_postings: number
}

export async function getInsights(auth?: Auth): Promise<Insights> {
  return call<Insights>('/insights', auth)
}
