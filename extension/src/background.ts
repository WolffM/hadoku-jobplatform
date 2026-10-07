/**
 * The one part of the extension that talks to hadoku.me.
 *
 * It runs with the browser's own session: `credentials: 'include'` sends the
 * hadoku_session cookie, so whoever is signed in to hadoku.me in this Chrome is
 * who the packet and the codes belong to. No key is stored by default.
 *
 * `apiBase` and `apiKey` in chrome.storage.local override that — the first so
 * tests can point at a local server, the second for a profile that is not
 * signed in to hadoku.me.
 */
import type { NextUp, Request, Response, Session } from './messages'

const DEFAULT_API = 'https://hadoku.me/jobplatform/api'

async function settings(): Promise<{ api: string; key: string | null }> {
  const s = await chrome.storage.local.get(['apiBase', 'apiKey'])
  return {
    api: typeof s.apiBase === 'string' && s.apiBase ? s.apiBase : DEFAULT_API,
    key: typeof s.apiKey === 'string' && s.apiKey ? s.apiKey : null
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { api: base, key } = await settings()
  const headers = new Headers(init.headers)
  if (key) headers.set('X-User-Key', key)
  if (init.body) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${base}${path}`, { ...init, headers, credentials: 'include' })
  const body = (await res.json().catch(() => null)) as {
    success?: boolean
    data?: T
    message?: string
  } | null
  if (!res.ok || !body?.success) {
    throw new Error(body?.message ?? `hadoku.me answered ${res.status}`)
  }
  return body.data as T
}

/** Messages carry JSON, so the PDF crosses as base64. */
async function pdf(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`résumé PDF answered ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

const NO_SESSION: Session = { active: false, current: null, sent: [], skipped: [] }

async function session(): Promise<Session> {
  const s = await chrome.storage.session.get('session')
  return (s.session as Session | undefined) ?? NO_SESSION
}

async function saveSession(s: Session): Promise<Session> {
  await chrome.storage.session.set({ session: s })
  return s
}

interface Listed {
  job_id: string
  status: string
  form_url: string
  company: string
  title: string
  updated_at: string
}

/**
 * The applications still to send, in the order a session takes them: the ones
 * the owner approved first, then ones the runner filled and nobody has looked
 * at yet — the session's own review covers those. Oldest first, so nothing
 * waits behind newer work. Anything sent or skipped this session is done.
 */
async function ready(s: Session): Promise<Listed[]> {
  const { applications } = await api<{ applications: Listed[] }>('/applications')
  const rank = (st: string) => (st === 'approved' ? 0 : st === 'filled' ? 1 : -1)
  return applications
    .filter(a => rank(a.status) >= 0 && !s.sent.includes(a.job_id) && !s.skipped.includes(a.job_id))
    .sort((a, b) => rank(a.status) - rank(b.status) || a.updated_at.localeCompare(b.updated_at))
}

async function next(done: 'sent' | 'skipped'): Promise<NextUp | null> {
  const s = await session()
  if (s.current) (done === 'sent' ? s.sent : s.skipped).push(s.current)
  const queue = (await ready(s)).filter(a => a.job_id !== s.current)
  const up = queue[0]
  await saveSession({ ...s, current: up?.job_id ?? null, active: !!up })
  return up
    ? {
        job_id: up.job_id,
        form_url: up.form_url,
        company: up.company,
        title: up.title,
        remaining: queue.length - 1
      }
    : null
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'packet':
      return api(`/jobs/${encodeURIComponent(req.jobId)}/fill-packet`)
    case 'pdf':
      return pdf(req.url)
    case 'codes':
      return (await api<{ codes: unknown[] }>('/verification-codes')).codes
    case 'markSent':
      return api(`/applications/${encodeURIComponent(req.applicationId)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'submitted' })
      })
    case 'sessionStart':
      return saveSession({ active: true, current: req.jobId, sent: [], skipped: [] })
    case 'sessionState': {
      const s = await session()
      return {
        ...s,
        remaining: s.active ? (await ready(s)).filter(a => a.job_id !== s.current).length : 0
      }
    }
    case 'sessionStop':
      return saveSession(NO_SESSION)
    case 'sessionNext':
      return next(req.done)
  }
}

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse) => {
  handle(req).then(
    data => sendResponse({ ok: true, data } satisfies Response<unknown>),
    (err: unknown) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      } satisfies Response<unknown>)
  )
  return true
})
