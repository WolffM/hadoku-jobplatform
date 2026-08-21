import { useEffect, useState } from 'react'
import { getJob, JobsApiError, type JobDetail } from '../api/jobs'
import { getPacketVariant, packetPdfUrl, packetUrl, type PacketVariant } from '../api/packets'
import type { Auth } from '../api/auth'
import { Description } from './JobDrawer'

interface Props {
  auth: Auth
  jobId: string
  slug: string
  // Back to the packets list (also bound to Escape).
  onClose: () => void
}

/**
 * The packet split view (scratch #25): a two-column reading page inside the
 * packets route — posting on the left, packet on the right — instead of
 * bouncing back to the feed's drawer. Header carries the public "Tailored
 * resume" link and the PDF button; the row itself no longer links to either.
 */
export function PacketDetail({ auth, jobId, slug, onClose }: Props) {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  const [variant, setVariant] = useState<PacketVariant | null>(null)
  const [packetError, setPacketError] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setJob(null)
    setJobError(null)
    getJob(jobId, undefined, auth)
      .then(result => {
        if (!cancelled) setJob(result)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setJobError(err instanceof JobsApiError ? err.message : 'Failed to load the posting')
      })
    return () => {
      cancelled = true
    }
  }, [auth, jobId])

  useEffect(() => {
    let cancelled = false
    setVariant(null)
    setPacketError(null)
    getPacketVariant(slug)
      .then(result => {
        if (!cancelled) setVariant(result)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setPacketError(err instanceof Error ? err.message : 'Failed to load the packet')
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  // The posting fetch can lag (or fail for a culled job) — the variant carries
  // enough to head the page on its own.
  const title = job?.title ?? variant?.job_title ?? 'Packet'
  const company = job?.company ?? variant?.company ?? null

  return (
    <section className="jp-packet-detail">
      <header className="jp-packet-detail__header">
        <button type="button" className="jp-packet-detail__back" onClick={onClose}>
          ← Packets
        </button>
        <div className="jp-packet-detail__heading">
          <h2 className="jp-packet-detail__title">{title}</h2>
          {company && <p className="jp-packet-detail__company">{company}</p>}
        </div>
        <div className="jp-packet-detail__links">
          <a
            className="jp-drawer__cta"
            href={packetUrl(slug)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Tailored resume
          </a>
          <a
            className="jp-drawer__cta jp-drawer__cta--primary"
            href={packetPdfUrl(slug)}
            target="_blank"
            rel="noopener noreferrer"
          >
            PDF
          </a>
        </div>
      </header>

      <div className="jp-packet-detail__columns">
        <article className="jp-packet-detail__col" aria-label="Job posting">
          <h3 className="jp-packet-detail__col-title">Posting</h3>
          {jobError && <p className="jp-error">{jobError}</p>}
          {!job && !jobError && <p className="jp-muted">Loading posting…</p>}
          {job && (
            <>
              <p className="jp-packet-detail__job-line">
                {job.company} · {job.location || 'location unknown'}
                {job.workplace_type &&
                  job.workplace_type !== 'unknown' &&
                  ` · ${job.workplace_type}`}
              </p>
              <div className="jp-drawer__facts">
                <span>{job.source_site}</span>
                {job.job_type && job.job_type !== 'unknown' && <span>{job.job_type}</span>}
                {(job.salary_min || job.salary_max) && (
                  <span>
                    ${job.salary_min ?? '?'} – ${job.salary_max ?? '?'}
                  </span>
                )}
                {job.posted_date && <span>Posted {job.posted_date}</span>}
                {job.state && job.state !== 'new' && (
                  <span className={`jp-drawer__facts-state jp-drawer__facts-state--${job.state}`}>
                    {job.state}
                  </span>
                )}
              </div>
              <Description text={job.description} />
            </>
          )}
        </article>

        <article className="jp-packet-detail__col" aria-label="Application packet">
          <h3 className="jp-packet-detail__col-title">Packet</h3>
          {packetError && <p className="jp-error">{packetError}</p>}
          {!variant && !packetError && <p className="jp-muted">Loading packet…</p>}
          {variant && (
            <>
              {/* resume-api never 404s a slug — it falls back to the canonical
                  résumé and omits `variant`, so its absence means expired. */}
              {!variant.variant && (
                <p className="jp-muted">
                  This packet link has expired — showing the canonical résumé it now serves.
                </p>
              )}
              <div className="jp-packet-detail__doc">{variant.content}</div>
              {variant.cover_letter && (
                <>
                  <h4 className="jp-packet-detail__doc-title">Cover letter</h4>
                  <div className="jp-packet-detail__doc">{variant.cover_letter}</div>
                </>
              )}
            </>
          )}
        </article>
      </div>
    </section>
  )
}
