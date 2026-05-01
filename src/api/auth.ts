/**
 * Auth credentials threaded from the parent app (hadoku_site) into the MFE.
 *
 * Single mode: the `sessionId` produced by `/session/create` and stored in
 * SESSIONS_KV. Sent as `X-Session-Id`; edge-router resolves it to the
 * underlying key and injects `X-User-Key` on the proxied request. Raw keys
 * never enter MFE storage.
 *
 * In production, mf-loader injects this prop after fetching `/session/whoami`.
 * In dev, `index.html` calls `/session/create` once with `?apiKey=…` from the
 * URL and threads the resulting sessionId here — see that file for details.
 *
 * `credentials: 'include'` is always set so the `hadoku_session` cookie can
 * also ride along when present (production same-origin path).
 */
export interface Auth {
  sessionId?: string
}

export function authHeaders(auth?: Auth, json = false): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (json) headers['Content-Type'] = 'application/json'
  if (auth?.sessionId) headers['X-Session-Id'] = auth.sessionId
  return headers
}
