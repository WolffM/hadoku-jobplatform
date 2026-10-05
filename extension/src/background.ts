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
import type { Request, Response } from './messages'

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
