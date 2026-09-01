import { listPackets, JobsApiError, type PacketSummary } from '../api/jobs'
import { packetUrl } from '../api/packets'
import type { Auth } from '../api/auth'
import { useResource } from '../api/useResource'

interface Props {
  auth: Auth
  // Row click — opens the packet's split view (posting left, packet right).
  onSelect: (packet: PacketSummary) => void
}

function formatPrepared(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

/**
 * The Packets view: every application packet the owner has generated, findable
 * again. A reference list, not a workflow — each row names the job, shows its
 * triage state and prepared date, and opens the split view on click. The only
 * outbound link on a row is the public tailored-resume page; the PDF button
 * lives inside the split view (scratch #25).
 */
export function PacketsList({ auth, onSelect }: Props) {
  const { data, loading, error: loadError } = useResource('packets', () => listPackets(auth))

  const packets: PacketSummary[] = data ?? []
  const needsAuth = loadError instanceof JobsApiError && loadError.status === 403
  const error =
    loadError && !needsAuth
      ? loadError instanceof JobsApiError
        ? loadError.message
        : 'Failed to load packets'
      : null

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
            onClick={() => onSelect(p)}
            onKeyDown={e => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(p)
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
                Tailored resume
              </a>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
