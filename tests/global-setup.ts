import { request } from '@playwright/test'

/**
 * Warm up the dev proxy before tests run.
 *
 * The first request through `/jobplatform/api/*` does a cold TLS handshake
 * to hadoku.me and can take ~20s — long enough to blow past per-test
 * waitForResponse timeouts. Hitting `/jobs` once here primes the connection
 * pool so every test sees fast responses.
 *
 * Retries on ECONNRESET because the vite proxy occasionally drops the first
 * connection during its own initialisation, especially right after webServer
 * reports the URL is up.
 */
export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: 'http://localhost:5173' })
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const r = await ctx.get('/jobplatform/api/jobs?limit=1', { timeout: 60_000 })
        if (r.ok()) {
          if (attempt > 1) console.log(`[global-setup] warm-up succeeded on attempt ${attempt}`)
          return
        }
        console.warn(`[global-setup] warm-up attempt ${attempt}: status ${r.status()}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[global-setup] warm-up attempt ${attempt} failed: ${msg}`)
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    console.warn('[global-setup] gave up warming the proxy after 5 attempts; tests may flake')
  } finally {
    await ctx.dispose()
  }
}
