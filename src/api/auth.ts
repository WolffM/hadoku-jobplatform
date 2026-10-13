/**
 * Who the parent app (hadoku_site) says is looking at this MFE.
 *
 * The credential never enters the bundle. A same-origin `fetch` carries the
 * HttpOnly `hadoku_session` cookie on its own, and edge-router resolves it
 * into `X-User-Key` for the worker. The session id used to arrive here as a
 * prop and go out as `X-Session-Id`, which let page JavaScript read a 30-day
 * bearer credential (hadoku_site#459) — so all this carries is whether anyone
 * is signed in, from mf-loader's `userType` prop.
 */
export interface Auth {
  signedIn: boolean
}

export function authHeaders(_auth?: Auth, json = false): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}
