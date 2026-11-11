/**
 * The worker's wrapped-response fetch, for the API modules written after
 * jobs.ts (which keeps its own parseWrapped). Same contract: `{ success,
 * data }` on success, a JobsApiError carrying the server's message otherwise.
 */
import { authHeaders, type Auth } from './auth'
import { JobsApiError } from './jobs'
import { trackedFetch } from '../telemetry'

export const BASE_URL = '/jobplatform/api'

interface Wrapped<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export async function call<T>(
  path: string,
  auth: Auth | undefined,
  init: RequestInit = {},
  json = false
): Promise<T> {
  const response = await trackedFetch(`${BASE_URL}${path}`, {
    ...init,
    headers: authHeaders(auth, json),
    credentials: 'include'
  })
  const body = (await response.json()) as Wrapped<T>
  if (!response.ok || !body.success || !body.data) {
    throw new JobsApiError(body.message ?? body.error ?? `HTTP ${response.status}`, response.status)
  }
  return body.data
}

/** A JSON body for `call`. */
export function jsonBody(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) }
}
