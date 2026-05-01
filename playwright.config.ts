import { defineConfig, devices } from '@playwright/test'

/**
 * E2E tests against a real `pnpm dev` server, which proxies to production
 * hadoku.me for both `/jobplatform/api` and `/session`. No mocks: tests
 * exercise the actual edge-router auth, real D1 jobs, and the live MFE bundle.
 *
 * Auth: `process.env.ADMIN_KEY` is provided by the outer `dev-vault.mjs`
 * wrapper (see `package.json#scripts.test:e2e`). Tests that need an authed
 * session pass it as `?apiKey=` to the dev harness, which exchanges it for a
 * sessionId via `/session/create` — same code path as production mf-loader
 * receiving sessionId from `/session/whoami`.
 *
 * The webServer block starts `pnpm dev` (which also goes through dev-vault).
 * `reuseExistingServer: true` lets a pre-running dev server be reused for
 * faster local iteration.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './tests/global-setup.ts',
  fullyParallel: false, // dev server is single-tenant; serialize for clarity
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe'
  }
})
