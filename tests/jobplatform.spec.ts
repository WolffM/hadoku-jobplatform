import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Real E2E against `pnpm dev` (which proxies to hadoku.me). No mocks.
 *
 * `process.env.ADMIN_KEY` is injected by dev-vault.mjs in the outer test:e2e
 * script. Skip the authed tests cleanly if the env isn't set so a developer
 * who runs `playwright test` without the wrapper still gets useful smoke
 * coverage.
 */

const ADMIN_KEY = process.env.ADMIN_KEY ?? ''
const authedDescribe = ADMIN_KEY ? test.describe : test.describe.skip

async function gotoAuthed(page: Page, hashPath = '/') {
  // Encode the hash path so query stays separate from hash
  await page.goto(`/?apiKey=${encodeURIComponent(ADMIN_KEY)}#${hashPath}`)
  // Wait for the dev harness's /session/create roundtrip + the /jobs API
  await page.waitForResponse(r => r.url().includes('/session/create') && r.ok(), {
    timeout: 15_000
  })
}

test.describe('smoke', () => {
  test('app mounts and renders the header', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Job Platform', level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Jobs' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Companies' })).toBeVisible()
  })

  test('public visitor sees the unscored-list hint', async ({ page }) => {
    await page.goto('/')
    // No profile selected (and public can't list any anyway). The list view
    // surfaces a hint pointing the user at profile creation.
    await expect(page.getByText(/No profile selected/i)).toBeVisible({ timeout: 10_000 })
  })

  test('jobs API returns real data through the proxy', async ({ page }) => {
    await page.goto('/')
    const resp = await page.waitForResponse(
      r => r.url().includes('/jobplatform/api/jobs') && r.request().method() === 'GET'
    )
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data?.jobs)).toBe(true)
    expect(body.data.jobs.length).toBeGreaterThan(0)
    expect(body.data.total).toBeGreaterThan(100) // prod has 3k+
  })
})

test.describe('auth gate', () => {
  test('public visitor gets 403 on /profiles', async ({ page }) => {
    let profilesStatus: number | null = null
    page.on('response', r => {
      if (r.url().endsWith('/jobplatform/api/profiles')) profilesStatus = r.status()
    })
    await page.goto('/')
    // Wait for the sidebar's profile-list call to go through
    await page.waitForResponse(r => r.url().endsWith('/jobplatform/api/profiles'), {
      timeout: 10_000
    })
    expect(profilesStatus).toBe(403)
  })
})

authedDescribe('authed flows', () => {
  test('?apiKey= → /session/create → authed /profiles 200', async ({ page }) => {
    let profilesStatus: number | null = null
    page.on('response', r => {
      if (r.url().endsWith('/jobplatform/api/profiles')) profilesStatus = r.status()
    })
    await gotoAuthed(page)
    await page.waitForResponse(
      r => r.url().endsWith('/jobplatform/api/profiles') && r.request().method() === 'GET',
      { timeout: 10_000 }
    )
    expect(profilesStatus).toBe(200)
  })

  test('whoami chain: dev harness creates a real session', async ({ page }) => {
    const resp = await new Promise<{ ok: boolean; body: unknown }>(resolve => {
      page.on('response', async r => {
        if (r.url().includes('/session/create') && r.request().method() === 'POST') {
          resolve({ ok: r.ok(), body: await r.json().catch(() => null) })
        }
      })
      void gotoAuthed(page)
    })
    expect(resp.ok).toBe(true)
    const body = resp.body as { valid: boolean; userType: string; sessionId: string }
    expect(body.valid).toBe(true)
    expect(body.userType).toBe('admin')
    expect(body.sessionId).toMatch(/^[a-f0-9]{32}$/)
  })
})

test.describe('job detail drawer', () => {
  test('clicking a job card opens the drawer', async ({ page }) => {
    await page.goto('/')
    // Wait for cards to render
    const firstCard = page.locator('.jp-jobcard').first()
    await expect(firstCard).toBeVisible({ timeout: 10_000 })
    await firstCard.click()
    // Drawer is a <aside role="dialog" aria-labelledby="jp-drawer-title">
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('h2#jp-drawer-title')).toBeVisible()
    // Apply CTA links to source site
    await expect(drawer.getByRole('link', { name: /Apply on/ })).toBeVisible()
  })

  test('LinkedIn description preserves \\n linebreaks (regression)', async ({ page, request }) => {
    // Find a LinkedIn job that actually has a description, by hitting the API
    // through the same vite proxy the page uses.
    const list = await request.get('http://localhost:5173/jobplatform/api/jobs?limit=100')
    const data = (await list.json()) as { data: { jobs: Array<{ id: string; ats: string }> } }
    const linkedinJob = data.data.jobs.find(j => j.ats === 'linkedin')
    expect(linkedinJob, 'should find at least one linkedin job').toBeDefined()

    await page.goto(`/#/jobs/${encodeURIComponent(linkedinJob!.id)}`)
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    // The plain-text rendering branch applies `.jp-drawer__description--plain`
    // (white-space: pre-wrap). HTML rendering branch would apply only
    // `.jp-drawer__description` without the modifier. Verify the modifier
    // class is present — that's what makes \n actually render as a line.
    const desc = drawer.locator('.jp-drawer__description')
    await expect(desc).toBeVisible()
    await expect(desc).toHaveClass(/jp-drawer__description--plain/)
    // Sanity: pre-wrap is the computed white-space rule
    await expect(desc).toHaveCSS('white-space', 'pre-wrap')
  })

  test('Esc closes the drawer', async ({ page, request }) => {
    const list = await request.get('http://localhost:5173/jobplatform/api/jobs?limit=10')
    const job = ((await list.json()) as { data: { jobs: Array<{ id: string }> } }).data.jobs[0]
    await page.goto(`/#/jobs/${encodeURIComponent(job.id)}`)
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
  })
})

test.describe('routing', () => {
  test('Companies link navigates to /companies', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Companies' }).click()
    await expect(page).toHaveURL(/#\/companies$/)
    // The companies page wraps CompaniesManager which has this title.
    await expect(page.getByRole('heading', { name: 'Subscribed Companies' })).toBeVisible()
  })

  test('Back link returns to dashboard', async ({ page }) => {
    await page.goto('/#/companies')
    await page.getByRole('link', { name: '← Back to jobs' }).click()
    await expect(page).toHaveURL(/#\/$|\/$/)
  })
})

test.describe('filters', () => {
  test('search filters the in-memory list client-side', async ({ page }) => {
    await page.goto('/')
    const firstCard = page.locator('.jp-jobcard').first()
    await expect(firstCard).toBeVisible({ timeout: 10_000 })

    const initialCount = await page.locator('.jp-jobcard').count()
    expect(initialCount).toBeGreaterThan(1)

    // Pick a token from the first card's title to use as a search seed
    const title = await firstCard.locator('.jp-jobcard__title').textContent()
    const token = title?.split(/\s+/)[0]?.slice(0, 4) ?? 'engineer'

    const search = page.getByPlaceholder(/Search title/i)
    await search.fill(token)

    // Filtered count should be > 0 and ≤ initial
    const filteredCount = await page.locator('.jp-jobcard').count()
    expect(filteredCount).toBeGreaterThan(0)
    expect(filteredCount).toBeLessThanOrEqual(initialCount)
  })
})
