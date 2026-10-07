/** What the content script asks the background worker for. */
export type Request =
  | { type: 'packet'; jobId: string }
  | { type: 'pdf'; url: string }
  | { type: 'codes' }
  | { type: 'markSent'; applicationId: string }
  /** Begin a send session at this job (the page opened with #hadoku-session). */
  | { type: 'sessionStart'; jobId: string }
  | { type: 'sessionState' }
  | { type: 'sessionStop' }
  /** The next ready application, after marking the current one sent or skipped. */
  | { type: 'sessionNext'; done: 'sent' | 'skipped' }

export type Response<T> = { ok: true; data: T } | { ok: false; error: string }

export interface Profile {
  name: string
  email: string
  phone?: string
  location?: string
  linkedin?: string
  github?: string
  education?: {
    school: string
    degree?: string
    discipline?: string
    start_year?: string | number
    end_year?: string | number
  }[]
  work_experience?: {
    company: string
    title?: string
    current?: boolean
    start_month?: string | number
    start_year?: string | number
    end_month?: string | number
    end_year?: string | number
  }[]
}

export interface Packet {
  job: { id: string; company: string; title: string; url: string }
  application: { id: string; status: string; variant_slug: string } | null
  profile: Profile | null
  answers: Record<string, string>
  options: Record<string, string[]>
  multi: string[]
  standing: Record<string, string>
  resume_pdf_url: string | null
}

/** A send session: the owner submitting their ready applications one by one. */
export interface Session {
  active: boolean
  /** The job whose form is open now. */
  current: string | null
  sent: string[]
  skipped: string[]
}

export interface NextUp {
  job_id: string
  form_url: string
  company: string
  title: string
  /** Ready applications after this one. */
  remaining: number
}

export interface Code {
  id: string
  company: string | null
  received_at: string
  code: string | null
  text: string | null
}

export function ask<T>(req: Request): Promise<Response<T>> {
  return chrome.runtime.sendMessage(req)
}
