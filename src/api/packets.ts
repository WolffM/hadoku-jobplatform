/**
 * The packet itself lives in resume-api, not here: the variant slug keys a
 * minted résumé (+ cover letter) whose public page, JSON and PDF are all
 * served from hadoku.me/resume. Absolute URLs because this dashboard is
 * mounted under /jobplatform; the JSON endpoint is public (same-origin in
 * production), so no auth headers.
 */

const RESUME_BASE = 'https://hadoku.me/resume'

/** Public packet page — what a recruiter sees when the link is shared. */
export function packetUrl(slug: string): string {
  return `${RESUME_BASE}?v=${encodeURIComponent(slug)}`
}

/** Server-rendered PDF of the same variant. */
export function packetPdfUrl(slug: string): string {
  return `${RESUME_BASE}/api/resume.pdf?v=${encodeURIComponent(slug)}`
}

/**
 * GET /resume/api/resume?v={slug} — raw JSON, not the jobplatform
 * success-wrapper. An unknown or expired slug doesn't 404: resume-api falls
 * back to the canonical résumé and omits `variant`, so its absence is the
 * "this packet has expired" signal.
 */
export interface PacketVariant {
  /** Tailored résumé markdown (or the canonical résumé on fallback). */
  content: string
  variant?: string
  label?: string | null
  cover_letter?: string | null
  company?: string | null
  job_title?: string | null
}

export async function getPacketVariant(slug: string): Promise<PacketVariant> {
  const response = await fetch(`${RESUME_BASE}/api/resume?v=${encodeURIComponent(slug)}`)
  if (!response.ok) throw new Error(`Failed to load packet (HTTP ${response.status})`)
  return (await response.json()) as PacketVariant
}
