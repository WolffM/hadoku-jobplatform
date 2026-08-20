import { useEffect, useState } from 'react'
import { listPackets, JobsApiError, type PacketSummary } from '../api/jobs'
import type { Auth } from '../api/auth'

interface Props {
  auth: Auth
  // Row click — opens the job in the existing drawer route.
  onSelect: (jobId: string) => void
}

// The packet lives in resume-api, not here: the slug keys a minted variant
// whose public page and PDF are served from hadoku.me/resume. Absolute URLs
// because this dashboard is mounted under /jobplatform.
function packetUrl(slug: string): string {
  return `https://hadoku.me/resume?v=${encodeURIComponent(slug)}`
}

function packetPdfUrl(slug: string): string {
  return `https://hadoku.me/resume/api/resume.pdf?v=${encodeURIComponent(slug)}`
}

function formatPrepared(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

/**
 * The Packets view: every application packet the owner has generated, findable
 * again. A reference list, not a workflow — each row names the job, shows its
 * triage state and prepared date, and links back to the packet page + PDF.
 */
export function PacketsList({ auth, onSelect }: Props) {
  const [packets, setPackets] = useState<PacketSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needsAuth, setNeedsAuth] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listPackets(auth)
      .then(rows => {
        if (!cancelled) setPackets(rows)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof JobsApiError && err.status === 403) {
          setNeedsAuth(true)
        } else {
          setError(err instanceof JobsApiError ? err.message : 'Failed to load packets')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [auth])

  if (loading) return <p className="jp-muted">Loading packets…</p>
  if (needsAuth) return <p className="jp-muted">Packets are per-account — sign in to see yours.</p>
  if (error) return <p className="jp-error">{error}</p>
  if (packets.length === 0)
    return (
      <p className="jp-muted">
        No packets yet. Prepare an application from a job’s drawer and create its link — it will
        show up here.
      </p>
    )

  return (
    <ul className="jp-packets">
      {packets.map(p => (
        <li key={`${p.job_id}:${p.variant_slug}`}>
          {/* Not a <button>: the packet links live inside the row and buttons
              can't nest. Same role+tabIndex pattern as JobCard. */}
          <div
            role="button"
            tabIndex={0}
            className="jp-packet"
            onClick={() => onSelect(p.job_id)}
            onKeyDown={e => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(p.job_id)
              }
            }}
          >
            <div className="jp-packet__main">
              <span className="jp-packet__job">
                <span className="jp-packet__company">{p.company}</span>
                <span className="jp-jobcard__sep"> — </span>
                {p.title}
              </span>
              <span className="jp-packet__meta">Prepared {formatPrepared(p.updated_at)}</span>
            </div>
            {/* Reuses the jobcard state badge palette — same states, same look. */}
            <span className={`jp-jobcard__state jp-jobcard__state--${p.state}`}>{p.state}</span>
            <div className="jp-packet__links">
              <a
                href={packetUrl(p.variant_slug)}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
              >
                View packet
              </a>
              <a
                href={packetPdfUrl(p.variant_slug)}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
              >
                PDF
              </a>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
