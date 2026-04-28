const BASE_URL = '/jobplatform/api'

export interface ScoreBreakdown {
  title_match: number
  keyword_match: number
  company_boost: number
  seniority_match: number
  remote_match: number
  salary_match: number
}

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
}

export interface JobDetail extends JobSummary {
  job_type: string
  description: string
  application_url: string | null
  department: string | null
  scraper_used: string | null
  run_id: string | null
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
  mine?: boolean
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

import { authHeaders, authCreds, type Auth } from './auth'

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
  if (opts.mine) params.set('mine', 'true')
  if (opts.page) params.set('page', String(opts.page))
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.sort) params.set('sort', opts.sort)
  if (opts.min_score !== undefined) params.set('min_score', String(opts.min_score))

  const url = `${BASE_URL}/jobs${params.toString() ? `?${params}` : ''}`
  const response = await fetch(url, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: authCreds(auth)
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
    credentials: authCreds(auth)
  })
  const data = await parseWrapped<{ job: JobDetail }>(response)
  return data.job
}
