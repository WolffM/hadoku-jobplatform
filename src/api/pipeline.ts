/**
 * V5 — what happens to an application after it is sent. Mirrors
 * worker/src/routes/jobs/pipeline.ts: a posting is in the caller's pipeline
 * exactly when it has a triage state, and the tracking fields and timeline
 * hang off that state.
 */
import type { Auth } from './auth'
import { call, jsonBody } from './http'
import type { ApplicationStatus, JobStateWrite } from './jobs'

export type Priority = 1 | 2 | 3

export interface Tracking {
  notes: string | null
  priority: Priority | null
  /** YYYY-MM-DD. */
  follow_up_at: string | null
  contact_name: string | null
  contact_email: string | null
}

export interface PipelineItem {
  job_id: string
  title: string
  company: string
  location: string
  workplace_type: string
  salary_min: number | null
  salary_max: number | null
  url: string
  posted_date: string | null
  state: JobStateWrite
  updated_at: string
  tracking: Tracking
  variant_slug: string | null
  application_status: ApplicationStatus | null
  /** First move to 'applied', from the timeline. */
  applied_at: string | null
  /** Newest timeline row of any kind. */
  last_event_at: string | null
}

/** The kinds a person logs; 'state' rows are written by the server on a transition. */
export type PersonEventKind = 'note' | 'interview' | 'contact' | 'follow_up'

export interface JobEvent {
  id: number
  job_id: string
  kind: 'state' | PersonEventKind
  from_state: JobStateWrite | null
  to_state: JobStateWrite | null
  note: string | null
  occurred_at: string
  created_at: string
}

const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`

/** GET /pipeline — dismissed postings are left out. */
export async function getPipeline(auth?: Auth): Promise<PipelineItem[]> {
  const data = await call<{ items: PipelineItem[] }>('/pipeline', auth)
  return data.items
}

/** PATCH /jobs/:id/tracking — only the fields given change; null clears one. */
export async function setTracking(
  id: string,
  patch: Partial<Tracking>,
  auth?: Auth
): Promise<Tracking> {
  const data = await call<{ tracking: Tracking }>(
    `${jobPath(id)}/tracking`,
    auth,
    { method: 'PATCH', body: JSON.stringify(patch) },
    true
  )
  return data.tracking
}

/** GET /jobs/:id/events — oldest first. */
export async function listJobEvents(id: string, auth?: Auth): Promise<JobEvent[]> {
  const data = await call<{ events: JobEvent[] }>(`${jobPath(id)}/events`, auth)
  return data.events
}

/** POST /jobs/:id/events — `occurred_at` is a date or ISO timestamp; omitted = now. */
export async function addJobEvent(
  id: string,
  event: { kind: PersonEventKind; note: string; occurred_at?: string },
  auth?: Auth
): Promise<JobEvent> {
  const data = await call<{ event: JobEvent }>(
    `${jobPath(id)}/events`,
    auth,
    { method: 'POST', body: JSON.stringify(event) },
    true
  )
  return data.event
}

/** DELETE /jobs/:id/events/:eventId — person-logged rows only. */
export async function deleteJobEvent(id: string, eventId: number, auth?: Auth): Promise<void> {
  await call<{ deleted: boolean }>(`${jobPath(id)}/events/${eventId}`, auth, {
    method: 'DELETE'
  })
}

export interface ImportedPosting {
  job: { id: string; title: string; company: string; location: string; url: string }
  /** New to the corpus (false: someone, or the nightly scrape, already had it). */
  created: boolean
  state: JobStateWrite
  /** The caller already tracked it, so its state was left as it was. */
  already_tracked: boolean
}

/**
 * POST /jobs/import — read a posting from its URL (the scraper does the
 * reading) and add it to the pipeline. The server's error messages are
 * written for the person ("LinkedIn postings can't be imported…").
 */
export async function importPosting(
  url: string,
  state: Exclude<JobStateWrite, 'dismissed'>,
  auth?: Auth
): Promise<ImportedPosting> {
  return call<ImportedPosting>('/jobs/import', auth, jsonBody('POST', { url, state }), true)
}
