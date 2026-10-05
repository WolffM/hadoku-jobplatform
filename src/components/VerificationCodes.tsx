import { useEffect, useState } from 'react'
import { JobsApiError, listVerificationCodes, type VerificationCode } from '../api/jobs'
import type { Auth } from '../api/auth'

/** Codes expire within minutes; poll while the page is open and visible. */
const POLL_MS = 10_000
/** Past this a code has very likely expired; it stays listed, marked so. */
const STALE_MS = 15 * 60_000

function age(iso: string, now: number): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.round(mins / 60)} h ago`
}

/**
 * The codes Greenhouse emails at submit, read from the hadoku.me mail feed so
 * the owner types them into the form without opening an inbox.
 *
 * Renders nothing for anyone but the mailbox owner (the route 403s them) and
 * nothing when there are no recent codes.
 */
export function VerificationCodes({ auth }: { auth: Auth }) {
  const [codes, setCodes] = useState<VerificationCode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    async function poll() {
      if (document.visibilityState !== 'visible') return
      try {
        const next = await listVerificationCodes(auth)
        if (cancelled) return
        setCodes(next)
        setError(null)
        setNow(Date.now())
      } catch (err) {
        if (cancelled) return
        if (err instanceof JobsApiError && err.status === 403) setHidden(true)
        else setError(err instanceof JobsApiError ? err.message : 'Could not read the mail feed')
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [auth])

  async function copy(code: VerificationCode) {
    if (!code.code) return
    try {
      await navigator.clipboard.writeText(code.code)
      setCopied(code.id)
    } catch {
      setError('Copy failed — select the code and copy it by hand')
    }
  }

  if (hidden || (!codes.length && !error)) return null

  return (
    <section className="jp-codes" aria-live="polite">
      <h3>Verification codes</h3>
      {error && <p className="jp-error">{error}</p>}
      <ul className="jp-codes__list">
        {codes.map(c => {
          const stale = now - new Date(c.received_at).getTime() > STALE_MS
          return (
            <li key={c.id} className={`jp-codes__row${stale ? ' jp-codes__row--stale' : ''}`}>
              <span className="jp-codes__company">{c.company ?? c.subject}</span>
              {c.code ? (
                <button
                  type="button"
                  className="jp-codes__code"
                  onClick={() => void copy(c)}
                  title="Copy"
                >
                  {c.code}
                </button>
              ) : (
                <pre className="jp-codes__text">{c.text}</pre>
              )}
              <span className="jp-codes__meta">
                {copied === c.id ? 'copied · ' : ''}
                {age(c.received_at, now)}
                {stale ? ' · probably expired' : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
