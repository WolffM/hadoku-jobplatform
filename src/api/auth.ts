/**
 * Auth credentials passed from the parent app (hadoku_site) into the MFE.
 *
 * Two modes during the auth-rework migration:
 * - `sessionId` (preferred): edge-router resolves this to the underlying key
 *   via SESSIONS_KV and injects `X-User-Key` on the proxied request. The raw
 *   key never leaves the parent app's localStorage.
 * - `apiKey` (legacy): raw key sent directly. Will be removed once mf-loader
 *   stops passing it (see auth-rework PR 3c).
 *
 * If both are provided, both headers are sent — edge-router's `injectSessionKey`
 * middleware overwrites X-User-Key from the session, so the session path wins.
 */
export interface Auth {
  apiKey?: string
  sessionId?: string
}

/**
 * Build request headers for an authed call. Always sets `Accept`. Optionally
 * sets `Content-Type: application/json` for write requests.
 */
export function authHeaders(auth?: Auth, json = false): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (json) headers['Content-Type'] = 'application/json'
  if (auth?.sessionId) headers['X-Session-Id'] = auth.sessionId
  if (auth?.apiKey) headers['X-User-Key'] = auth.apiKey
  return headers
}

/**
 * `same-origin` when we have explicit credentials (apiKey or sessionId);
 * `include` otherwise so the browser sends the hadoku_session cookie even
 * for cross-origin dev (e.g. localhost:5173 ↔ hadoku.me).
 */
export function authCreds(auth?: Auth): RequestCredentials {
  return auth?.apiKey || auth?.sessionId ? 'same-origin' : 'include'
}
