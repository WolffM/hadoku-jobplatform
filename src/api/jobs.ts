import { authHeaders, type Auth } from './auth'
import type { ProfileTrack, RoleLevel } from './profiles'

const BASE_URL = '/jobplatform/api'

export interface ScoreBreakdown {
  relevance: number
  level_match: number
  geo_fit: number
  comp_fit: number
  stack_fit: number
  domain_interest: number
  discipline_factor: number
}

/** As classified at ingest. 'unknown' only for a blank title. */
export type RoleTrack = 'ic' | 'manager' | 'unknown'

/**
 * V2 triage states. 'new' surfaces on read when the authed caller hasn't
 * touched a job yet. Writeable values exclude 'new' (no row = 'new').
 */
export type JobStateRead = 'new' | 'interested' | 'dismissed' | 'saved' | 'applied'
export type JobStateWrite = 'interested' | 'dismissed' | 'saved' | 'applied'

/** A curation vote on a posting: thumbs up or thumbs down. */
export type VoteValue = 1 | -1

/** Mirrors FEEDBACK_REASONS in worker/src/schemas.ts — one axis per vote. */
export type FeedbackReason =
  | 'pay'
  | 'location'
  | 'stack'
  | 'domain'
  | 'level'
  | 'company'
  | 'comp'
  | 'fit'
  | 'other'

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
  /**
   * Whether the form runner has an adapter for this posting. A PREDICTION read
   * off the URL — nothing has been opened, so it must not be worded as if we
   * had checked.
   */
  apply_tier: 'supported' | 'embedded' | 'unsupported' | 'unknown'
  /** The runner has actually filled a form on this board. Evidence. */
  apply_verified: boolean
  role_track: RoleTrack
  role_level: RoleLevel | null
  score: number
  score_breakdown: ScoreBreakdown
  // null when caller is unauthenticated (no per-user join). 'new' when
  // there's no job_states row for the authed user.
  state: JobStateRead | null
  // The caller's curation vote, when authenticated. Only the feed populates
  // it — the detail endpoint doesn't — so undefined means "unknown", not
  // "unvoted".
  vote?: VoteValue | null
  vote_reasons?: string[]
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
  sort?: JobSort
  min_score?: number
  /** View filter only — never a profile criterion. Jobs with no listed salary survive it. */
  min_salary?: number
  workplace?: 'remote' | 'hybrid' | 'onsite'
}

export type JobSort = 'score' | 'date' | 'salary' | 'comp' | 'interest' | 'relevance'

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
  if (opts.min_salary !== undefined) params.set('min_salary', String(opts.min_salary))

  const url = `${BASE_URL}/jobs${params.toString() ? `?${params}` : ''}`
  const response = await fetch(url, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  return parseWrapped<JobsListResponse>(response)
}

/**
 * GET /jobs/preflight — how many corpus jobs match a keyword, track and/or
 * level. Powers the editor's per-field probes ("312 matching jobs"). The track
 * and level probes read the same classified columns the feed filters on, so the
 * count is exactly the population the selection would produce. Read-only.
 */
export async function preflightCount(
  probe: { keyword?: string; track?: Exclude<ProfileTrack, 'either'>; level?: RoleLevel },
  auth?: Auth
): Promise<number> {
  const params = new URLSearchParams()
  if (probe.keyword) params.set('keyword', probe.keyword)
  if (probe.track) params.set('track', probe.track)
  if (probe.level) params.set('level', probe.level)
  const response = await fetch(`${BASE_URL}/jobs/preflight?${params}`, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ count: number }>(response)
  return data.count
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
 * Returns the new state + server-stamped updated_at. Pass variant_slug when
 * marking applied with a prepared packet, so the row remembers what was sent.
 */
export async function setJobState(
  id: string,
  state: JobStateWrite,
  auth?: Auth,
  variantSlug?: string
): Promise<{ job_id: string; state: JobStateRead; updated_at: string }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/state`, {
    method: 'PUT',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(variantSlug ? { state, variant_slug: variantSlug } : { state })
  })
  return parseWrapped<{ job_id: string; state: JobStateRead; updated_at: string }>(response)
}

/**
 * PUT /jobs/:id/feedback — upsert the caller's vote on one posting: +1/-1
 * plus multi-select axis-aligned reasons. Same session auth as the state calls.
 */
export async function setJobFeedback(
  id: string,
  vote: VoteValue,
  reasons: FeedbackReason[],
  auth?: Auth
): Promise<{ job_id: string; vote: VoteValue | null; reasons: string[]; updated_at: string }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/feedback`, {
    method: 'PUT',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify({ vote, reasons })
  })
  return parseWrapped<{
    job_id: string
    vote: VoteValue | null
    reasons: string[]
    updated_at: string
  }>(response)
}

/**
 * DELETE /jobs/:id/feedback — clear the caller's vote on one posting.
 * Idempotent: safe to call when no vote exists.
 */
export async function clearJobFeedback(
  id: string,
  auth?: Auth
): Promise<{ job_id: string; vote: VoteValue | null; reasons: string[]; updated_at: string }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/feedback`, {
    method: 'DELETE',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  return parseWrapped<{
    job_id: string
    vote: VoteValue | null
    reasons: string[]
    updated_at: string
  }>(response)
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
 * POST /jobs/:id/packet-link — mint a shareable packet link from an
 * already-generated résumé + cover letter. jobplatform mints a resume-api
 * variant with the pre-rendered markdown (instant) and returns the public
 * hadoku.me/resume?v={slug} URL.
 */
export async function mintPacketLink(
  id: string,
  body: { resume_markdown: string; cover_letter_markdown?: string; ttl_days?: number },
  auth?: Auth
): Promise<{ slug: string; url: string }> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/packet-link`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(body)
  })
  return parseWrapped<{ slug: string; url: string }>(response)
}

export interface ScreeningAnswer {
  q: string
  a: string
}

/**
 * The non-résumé half of an application kit — generated by resume-api and
 * proxied through jobplatform. Everything a form/email needs besides the
 * tailored résumé and cover letter.
 */
export interface ApplicationExtras {
  /** Cover letter, produced in the same call as the rest of the kit. */
  cover_letter_markdown: string
  intro_email: string
  why_hook: string
  screening_answers: ScreeningAnswer[]
  salary_line: string
  linkedin_note: string
  talking_points: string[]
  /** Deterministic copy-paste block for the boring repeated form fields. */
  standard_fields: string
  cached: boolean
}

/**
 * POST /jobs/:id/application-extras — generate the application extras from an
 * already-generated tailored résumé. jobplatform proxies the résumé +
 * title/company/description to resume-api over the service binding.
 */
export async function generateApplicationExtras(
  id: string,
  body: { resume_markdown: string },
  auth?: Auth
): Promise<ApplicationExtras> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/application-extras`, {
    method: 'POST',
    headers: authHeaders(auth, true),
    credentials: 'include',
    body: JSON.stringify(body)
  })
  return parseWrapped<ApplicationExtras>(response)
}

/**
 * One generated application packet: a job_states row carrying the resume-api
 * variant slug minted for it, joined with the job. The slug keys both the
 * public packet page (hadoku.me/resume?v={slug}) and its PDF.
 */
export interface PacketSummary {
  job_id: string
  title: string
  company: string
  location: string
  state: JobStateRead
  variant_slug: string
  updated_at: string
}

/**
 * GET /jobs/packets — every packet the caller has generated, newest first.
 * Friend-gated: packets are per-user, so this 403s without auth.
 */
export async function listPackets(auth?: Auth): Promise<PacketSummary[]> {
  const response = await fetch(`${BASE_URL}/jobs/packets`, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ packets: PacketSummary[] }>(response)
  return data.packets
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

// ============================================================================
// Approve-to-apply queue (issue #15)
// ============================================================================

export type ApplicationStatus =
  | 'queued'
  | 'filled'
  | 'approved'
  | 'submitted'
  | 'needs_manual'
  | 'failed'
  | 'job_closed'

export interface ApplicationSummary {
  id: string
  job_id: string
  variant_slug: string
  mode: 'review' | 'auto'
  status: ApplicationStatus
  error: string | null
  evidence: Record<string, unknown> | null
  /**
   * Digest of the fill this approval refers to, copied off `evidence` when the
   * owner approves. The runner refuses to submit unless the application it
   * re-fills matches, so a `filled` row without one cannot be approved.
   */
  approved_fingerprint: string | null
  created_at: string
  updated_at: string
  title: string
  company: string
  location: string
}

/**
 * POST /jobs/:id/apply — queue one application for the PC-side form runner.
 *
 * This click IS the consent step: the runner only ever drains this queue and
 * never picks jobs itself. Requires a minted packet, because the variant_slug
 * is copied onto the row at queue time so a later re-tailor cannot silently
 * change what an in-flight application sends.
 */
export async function queueApplication(
  id: string,
  mode: 'review' | 'auto' = 'review',
  auth?: Auth
): Promise<ApplicationSummary> {
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(auth) },
    credentials: 'include',
    body: JSON.stringify({ mode })
  })
  const data = await parseWrapped<{ application: ApplicationSummary }>(response)
  return data.application
}

/** GET /applications — the caller's queue, newest first. Friend-gated. */
export async function listApplications(
  status?: ApplicationStatus,
  auth?: Auth
): Promise<ApplicationSummary[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  const response = await fetch(`${BASE_URL}/applications${query}`, {
    method: 'GET',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ applications: ApplicationSummary[] }>(response)
  return data.applications
}

/**
 * POST /applications/:id/approve — release a filled application for submission.
 *
 * Review mode's whole point: the runner pauses at `filled` with a screenshot,
 * and nothing is sent until a human has looked at it and called this.
 */
export async function approveApplication(id: string, auth?: Auth): Promise<ApplicationSummary> {
  const response = await fetch(`${BASE_URL}/applications/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    headers: authHeaders(auth),
    credentials: 'include'
  })
  const data = await parseWrapped<{ application: ApplicationSummary }>(response)
  return data.application
}
