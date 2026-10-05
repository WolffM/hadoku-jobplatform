/** What the content script asks the background worker for. */
export type Request =
  | { type: 'packet'; jobId: string }
  | { type: 'pdf'; url: string }
  | { type: 'codes' }
  | { type: 'markSent'; applicationId: string }

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
