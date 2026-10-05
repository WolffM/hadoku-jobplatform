/** Which board this page is, and which of our jobs it is the form for. */
export type Ats = 'greenhouse' | 'ashby' | 'lever'

export interface PageJob {
  ats: Ats
  /** The id jobplatform stores it under: `<ats>_<board's own id>`. */
  jobId: string
}

/**
 * Read off the URL, the same way the scraper builds ids at ingest:
 * greenhouse_<numeric id>, ashby_<uuid>, lever_<uuid>.
 */
export function pageJob(href: string): PageJob | null {
  const url = new URL(href)
  const host = url.hostname
  if (host.endsWith('greenhouse.io')) {
    const id = url.searchParams.get('token') ?? /\/jobs\/(\d+)/.exec(url.pathname)?.[1]
    return id ? { ats: 'greenhouse', jobId: `greenhouse_${id}` } : null
  }
  const uuid = /\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    url.pathname
  )?.[1]
  if (!uuid) return null
  if (host === 'jobs.ashbyhq.com') return { ats: 'ashby', jobId: `ashby_${uuid}` }
  if (host === 'jobs.lever.co') return { ats: 'lever', jobId: `lever_${uuid}` }
  return null
}
