import { authHeaders, type Auth } from './auth'

const BASE_URL = '/jobplatform/api'

export interface ScoreBreakdown {
  title_match: number
  keyword_match: number
  seniority_match: number
  remote_match: number
  salary_match: number
}

/**
 * V2 triage states. 'new' surfaces on read when the authed caller hasn't
 * touched a job yet. Writeable values exclude 'new' (no row = 'new').
 */
export type JobStateRead = 'new' | 'interested' | 'dismissed' | 'saved' | 'applied'
export type JobStateWrite = 'interested' | 'dismissed' | 'saved' | 'applied'

export interface JobSummary {
  id: string
  title: string
  company: string
  location: string
  workplace_type: string
  salary_min: number | null
  salary_max: number | null
  source_site: string
  url: string
  posted_date: string | null
  scraped_at: string
  ats: string | null
  slug: string | null
  score: number
  score_breakdown: ScoreBreakdown
  // null when caller is unauthenticated (no per-user join). 'new' when
  // there's no job_states row for the authed user.
  state: JobStateRead | null
}

export interface JobDetail extends JobSummary {
  job_type: string
  description: string
  application_url: string | null
  department: string | null
  scraper_used: string | null
  run_id: string | null
  state_updated_at: string | null
}

export interface JobsListResponse {
  jobs: JobSummary[]
  total: number
  page: number
  limit: number
  has_more: boolean
}

export interface ListJobsOptions {
  profile_id?: string
  state?: JobStateRead
  hide_dismissed?: boolean
  page?: number
  limit?: number
  sort?: 'score' | 'date'
  min_score?: number
}

interface Wrapped<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export class JobsApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'JobsApiError'
  }
}

async function parseWrapped<T>(response: Response): Promise<T> {
  const body = (await response.json()) as Wrapped<T>
  if (!response.ok || !body.success || !body.data) {
    throw new JobsApiError(body.message ?? body.error ?? `HTTP ${response.status}`, response.status)
  }
  return body.data
}

export async function listJobs(opts: ListJobsOptions, auth?: Auth): Promise<JobsListResponse> {
  const params = new URLSearchParams()
  if (opts.profile_id) params.set('profile_id', opts.profile_id)
  if (opts.state) params.set('state', opts.state)
  if (opts.hide_dismissed) params.set('hide_dismissed', 'true')
  if (opts.page) params.set('page', String(opts.page))
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.sort) params.set('sort', opts.sort)
  if (opts.min_score !== undefined) params.set('min_score', String(opts.min_score))

  const url = `${BASE_URL}/jobs${params.toString() ? `?${params}` : ''}`
  const response = await fetch(url, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  return parseWrapped<JobsListResponse>(response)
}

export async function getJob(
  id: string,
  profileId: string | undefined,
  auth?: Auth
): Promise<JobDetail> {
  const params = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : ''
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}${params}`, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ job: JobDetail }>(response)
  return data.job
}

/**
 * PUT /jobs/:id/state — upsert the caller's triage state for one job.
 * Returns the new state + server-stamped updated_at.
 */
export async function setJobState(
  id: string,
  state: JobStateWrite,
  auth?: Auth
): Promise<{ job_id: string; state: JobStateRead; updated_at: string }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/state`, {
    method: 'PUT',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify({ state })
  })
  return parseWrapped<{ job_id: string; state: JobStateRead; updated_at: string }>(response)
}

/**
 * POST /jobs/:id/resume — generate a tailored resume for one job. jobplatform
 * proxies title/company/description to resume-api over a service binding.
 */
export async function generateResume(
  id: string,
  auth?: Auth,
  opts?: { profile_type?: string; tailor?: boolean }
): Promise<{ resume_markdown: string; blocks_used: string[]; cached: boolean }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(opts ?? {})
  })
  return parseWrapped<{ resume_markdown: string; blocks_used: string[]; cached: boolean }>(response)
}

/**
 * POST /jobs/:id/cover-letter — generate a cover letter for one job (same
 * binding path; uses the full resume rather than blocks).
 */
export async function generateCoverLetter(
  id: string,
  auth?: Auth,
  opts?: { tone?: 'formal' | 'conversational' }
): Promise<{ cover_letter_markdown: string; cached: boolean }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/cover-letter`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(opts ?? {})
  })
  return parseWrapped<{ cover_letter_markdown: string; cached: boolean }>(response)
}

/**
 * DELETE /jobs/:id/state — clear the caller's state for one job (returns to
 * implicit 'new'). Idempotent: safe to call when no state row exists.
 */
export async function clearJobState(
  id: string,
  auth?: Auth
): Promise<{ job_id: string; deleted: boolean }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/state`, {
    method: 'DELETE',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  return parseWrapped<{ job_id: string; deleted: boolean }>(response)
}
