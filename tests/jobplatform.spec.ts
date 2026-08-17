import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Real E2E against `pnpm dev` (which proxies to hadoku.me). No mocks.
 *
 * `process.env.FRIEND_KEY` is injected by dev-vault.mjs in the outer test:e2e
 * script (vault item `KEY_FRIEND_JOBPLATFORM_E2E`, registry name
 * `jobplatform-e2e`, tier friend). Skip the authed tests cleanly if the env
 * isn't set so a developer who runs `playwright test` without the wrapper
 * still gets useful smoke coverage — but hard-fail if the wrapper *did* run
 * and only this binding is missing, so a broken key can't produce a
 * green-but-empty suite.
 */

const FRIEND_KEY = process.env.FRIEND_KEY ?? ''

if (!FRIEND_KEY && process.env.HADOKU_DEV_VAULT_ACTIVE) {
  throw new Error(
    'FRIEND_KEY is empty but dev-vault ran — the .devvault.json binding for ' +
      'FRIEND_KEY is broken. Run ' +
      '`node ../hadoku_site/scripts/secrets/dev-vault.mjs --check`.'
  )
}
if (!FRIEND_KEY) {
  console.warn(
    '[e2e] FRIEND_KEY unset — skipping authed suite. Run `pnpm test:e2e` for full coverage.'
  )
}

const authedDescribe = FRIEND_KEY ? test.describe : test.describe.skip

async function gotoAuthed(page: Page, hashPath = '/') {
  // Encode the hash path so query stays separate from hash
  await page.goto(`/?apiKey=${encodeURIComponent(FRIEND_KEY)}#${hashPath}`)
  // Wait for the dev harness's /session/create roundtrip + the /jobs API
  await page.waitForResponse(r => r.url().includes('/session/create') && r.ok(), {
    timeout: 15_000
  })
}

test.describe('smoke', () => {
  test('app mounts and renders the header', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Job Platform', level: 1 })).toBeVisible()
    // Nav moved out of the header in d9bc0f2; the dashboard is the only route.
    // Sidebar + feed are what the shell actually renders.
    await expect(page.getByRole('heading', { name: 'Profiles', level: 2 })).toBeVisible()
    await expect(page.getByPlaceholder(/Search title/i)).toBeVisible()
  })

  test('public visitor sees the unscored-list hint', async ({ page }) => {
    await page.goto('/')
    // Anonymously there is no profile and none can be created, so the hint
    // explains the unscored ordering instead of pointing at profile creation.
    // (The "No profile selected" wording is the authed branch, which rarely
    // renders in practice — the sidebar auto-selects the default profile.)
    await expect(page.getByText(/Showing every job in the corpus/i)).toBeVisible({
      timeout: 10_000
    })
  })

  test('jobs API returns real data through the proxy', async ({ page }) => {
    await page.goto('/')
    const resp = await page.waitForResponse(
      r => r.url().includes('/jobplatform/api/jobs') && r.request().method() === 'GET',
      { timeout: 30_000 }
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
  // The gate itself, asserted directly against the API rather than through the
  // UI. This is the security-relevant half and must hold regardless of what the
  // client chooses to request.
  test('/profiles is friend-gated — 403 for an anonymous caller', async ({ request }) => {
    const res = await request.get('http://localhost:5173/jobplatform/api/profiles')
    expect(res.status()).toBe(403)
  })

  // ...and the client half: the anonymous UI must not fire that request at all.
  // It previously did, which put a 403 in the console on every public load.
  test('anonymous UI never requests /profiles', async ({ page }) => {
    const profileCalls: string[] = []
    page.on('request', r => {
      if (r.url().includes('/jobplatform/api/profiles')) profileCalls.push(r.url())
    })

    await page.goto('/')
    // Anchor on the feed having actually loaded, so this can't pass simply by
    // asserting before anything happened.
    await expect(page.locator('.jp-jobcard').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()

    expect(profileCalls).toEqual([])
  })

  test('anonymous load produces no failed API requests', async ({ page }) => {
    const failures: string[] = []
    page.on('response', r => {
      if (r.url().includes('/jobplatform/api/') && r.status() >= 400) {
        failures.push(`${r.status()} ${r.url()}`)
      }
    })

    await page.goto('/')
    await expect(page.locator('.jp-jobcard').first()).toBeVisible({ timeout: 30_000 })

    expect(failures).toEqual([])
  })
})

test.describe('public feed', () => {
  test('the corpus is browsable without signing in', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Job Platform', level: 1 })).toBeVisible()
    // Real cards, not an empty/demo shell.
    const cards = page.locator('.jp-jobcard')
    await expect(cards.first()).toBeVisible({ timeout: 30_000 })
    expect(await cards.count()).toBeGreaterThan(1)
    await expect(page.getByPlaceholder(/Search title/i)).toBeVisible()
  })

  test('sidebar offers sign-in that returns to the app', async ({ page }) => {
    await page.goto('/')
    const signIn = page.getByRole('link', { name: 'Sign in' })
    await expect(signIn).toBeVisible({ timeout: 30_000 })
    // The return param is what makes sign-in come back here instead of
    // dumping the user on the site root.
    const href = await signIn.getAttribute('href')
    expect(href).toMatch(/^\/auth\?return=/)
    expect(decodeURIComponent(href ?? '')).toContain('/')
  })

  test('per-user controls are absent anonymously', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.jp-jobcard').first()).toBeVisible({ timeout: 30_000 })
    // State filter and hide-dismissed are per-user; they need a session.
    await expect(page.getByText('Hide dismissed')).toBeHidden()
    await expect(page.locator('.jp-sidebar__new')).toHaveCount(0)
  })

  test('opening a job anonymously shows the sign-in prompt, not triage buttons', async ({
    page
  }) => {
    await page.goto('/')
    const firstCard = page.locator('.jp-jobcard').first()
    await expect(firstCard).toBeVisible({ timeout: 30_000 })
    await firstCard.click()

    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    // Applying is public — it is just a link to the ATS.
    await expect(drawer.getByRole('link', { name: /Apply on/ })).toBeVisible()
    // Triage is not: the buttons render but must be inert without a session.
    await expect(drawer.getByText(/Sign in to track your interest/i)).toBeVisible()
    await expect(drawer.getByTestId('state-action-interested')).toBeDisabled()
    await expect(drawer.getByTestId('prepare-application')).toBeDisabled()
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
    expect(body.userType).toBe('friend')
    expect(body.sessionId).toMatch(/^[a-f0-9]{32}$/)
  })
})

test.describe('job detail drawer', () => {
  test('clicking a job card opens the drawer', async ({ page }) => {
    await page.goto('/')
    // Wait for cards to render
    const firstCard = page.locator('.jp-jobcard').first()
    await expect(firstCard).toBeVisible({ timeout: 30_000 })
    await firstCard.click()
    // Drawer is a <aside role="dialog" aria-labelledby="jp-drawer-title">
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('h2#jp-drawer-title')).toBeVisible()
    // Apply CTA links to source site
    await expect(drawer.getByRole('link', { name: /Apply on/ })).toBeVisible()
  })

  test('plain-text description preserves \\n linebreaks (regression)', async ({
    page,
    request
  }) => {
    // JobDrawer picks its render branch from the description *content*
    // (`isHtml` regex), not the ATS — so find a job whose description has no
    // block markup. Probing detail is required: the list rows omit description.
    // (Don't key this on ats==='linkedin' — LinkedIn is no longer a source.)
    const list = await request.get('http://localhost:5173/jobplatform/api/jobs?limit=100')
    const data = (await list.json()) as { data: { jobs: Array<{ id: string }> } }

    let plainJobId: string | undefined
    for (const job of data.data.jobs.slice(0, 25)) {
      const detail = await request.get(
        `http://localhost:5173/jobplatform/api/jobs/${encodeURIComponent(job.id)}`
      )
      const desc =
        ((await detail.json()) as { data: { job: { description?: string } } }).data.job
          .description ?? ''
      if (desc && !/<(p|br|div|li|ul|ol|h[1-6])\b/i.test(desc)) {
        plainJobId = job.id
        break
      }
    }
    expect(plainJobId, 'should find at least one plain-text description').toBeDefined()

    await page.goto(`/#/jobs/${encodeURIComponent(plainJobId!)}`)
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

// The standalone /companies route is gone — companies became a per-profile
// slice inside ProfileEditorModal (20c3087, f6dbd88). What's left to route is
// the dashboard and the job drawer overlay.
test.describe('routing', () => {
  test('clicking a card deep-links to /jobs/:id and closing returns to the dashboard', async ({
    page
  }) => {
    await page.goto('/')
    const firstCard = page.locator('.jp-jobcard').first()
    await expect(firstCard).toBeVisible({ timeout: 30_000 })
    await firstCard.click()

    await expect(page).toHaveURL(/#\/jobs\/[^/]+/)
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page).toHaveURL(/#\/(\?|$)/)
  })

  test('unknown route redirects to the dashboard', async ({ page }) => {
    await page.goto('/#/nope/not-a-route')
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.getByRole('heading', { name: 'Profiles', level: 2 })).toBeVisible()
  })
})

test.describe('filters', () => {
  test('search filters the in-memory list client-side', async ({ page }) => {
    await page.goto('/')
    const firstCard = page.locator('.jp-jobcard').first()
    await expect(firstCard).toBeVisible({ timeout: 30_000 })

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

authedDescribe('triage state (V2)', () => {
  // The dev harness exchanges ?apiKey= for a sessionId on every page load,
  // and the worker resolves sessionId → friend key → user_id. Same user_id
  // each run, so cleanup is reliable.
  async function clearState(
    request: import('@playwright/test').APIRequestContext,
    jobId: string,
    sessionId: string
  ) {
    await request.delete(
      `http://localhost:5173/jobplatform/api/jobs/${encodeURIComponent(jobId)}/state`,
      {
        headers: { 'X-Session-Id': sessionId }
      }
    )
  }

  async function freshSessionId(
    request: import('@playwright/test').APIRequestContext
  ): Promise<string> {
    const r = await request.post('http://localhost:5173/session/create', {
      headers: { 'X-User-Key': FRIEND_KEY }
    })
    const body = (await r.json()) as { sessionId: string }
    return body.sessionId
  }

  // ProfileSidebar auto-selects profiles[0] as soon as the list loads, so the
  // feed the browser renders is ALWAYS profile-scoped. A job picked from the
  // unscoped /jobs feed may not exist in that profile's corpus at all — mark
  // it and it silently never shows up in the filtered list. Scope the pick to
  // the same profile the UI will land on.
  async function firstProfileId(
    request: import('@playwright/test').APIRequestContext
  ): Promise<string> {
    const r = await request.get('http://localhost:5173/jobplatform/api/profiles', {
      headers: { 'X-User-Key': FRIEND_KEY }
    })
    const body = (await r.json()) as { data: { profiles: Array<{ id: string }> } }
    expect(body.data.profiles.length, 'need at least one profile').toBeGreaterThan(0)
    return body.data.profiles[0].id
  }

  test('drawer shows the triage section with 4 state buttons when authed', async ({
    page,
    request
  }) => {
    const list = await request.get('http://localhost:5173/jobplatform/api/jobs?limit=10')
    const job = ((await list.json()) as { data: { jobs: Array<{ id: string }> } }).data.jobs[0]

    await gotoAuthed(page, `/jobs/${job.id}`)
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    for (const state of ['interested', 'saved', 'applied', 'dismissed']) {
      await expect(drawer.getByTestId(`state-action-${state}`)).toBeEnabled()
    }
  })

  test('clicking a state action persists + drawer + card reflect it; cleanup', async ({
    page,
    request
  }) => {
    const sessionId = await freshSessionId(request)
    const profileId = await firstProfileId(request)

    // Pick a job that doesn't currently have state — first card on page 1 of
    // the profile-scoped feed, which is what the browser will render.
    const list = await request.get(
      `http://localhost:5173/jobplatform/api/jobs?limit=10&profile_id=${encodeURIComponent(profileId)}`,
      { headers: { 'X-Session-Id': sessionId } }
    )
    const jobs = ((await list.json()) as { data: { jobs: Array<{ id: string; state: string }> } })
      .data.jobs
    const target = jobs.find(j => j.state === 'new') ?? jobs[0]
    expect(target).toBeDefined()

    // Make sure starting state is clean
    await clearState(request, target.id, sessionId)

    try {
      // Pin the profile explicitly rather than leaning on the sidebar's
      // auto-select, so the feed and the pick above stay in the same corpus.
      await gotoAuthed(page, `/jobs/${target.id}?profile=${encodeURIComponent(profileId)}`)
      const drawer = page.getByRole('dialog')
      await expect(drawer).toBeVisible({ timeout: 10_000 })

      // No badge before action (state = 'new' is implicit and not rendered)
      await expect(drawer.getByTestId('drawer-state-badge')).toHaveCount(0)

      // Click "Mark interested"
      const interestedBtn = drawer.getByTestId('state-action-interested')
      const setRespPromise = page.waitForResponse(
        r =>
          r.url().endsWith(`/jobs/${target.id}/state`) && r.request().method() === 'PUT' && r.ok()
      )
      await interestedBtn.click()
      const setResp = await setRespPromise
      const setBody = (await setResp.json()) as { data: { state: string; job_id: string } }
      expect(setBody.data.state).toBe('interested')
      expect(setBody.data.job_id).toBe(target.id)

      // Drawer reflects the new state via badge + active button
      await expect(drawer.getByTestId('drawer-state-badge')).toHaveText('interested')
      await expect(interestedBtn).toHaveAttribute('aria-pressed', 'true')

      // Close drawer; the list refresh fires; the card shows the badge
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()

      // Find the card by job id — easiest path is filter to interested only
      // (or by URL hash). Use the state filter dropdown.
      const stateSelect = page.getByLabel('State')
      await stateSelect.selectOption('interested')

      // Wait for the resulting GET /jobs to come back, then check the card
      // is in the list with the badge.
      await page.waitForResponse(
        r =>
          r.url().includes('/jobplatform/api/jobs') &&
          r.url().includes('state=interested') &&
          r.ok()
      )

      // Assert on the locator, not a one-shot count(): the response landing
      // does not mean React has re-rendered, and count() never retries.
      const interestedBadges = page
        .getByTestId('card-state-badge')
        .filter({ hasText: 'interested' })
      await expect(interestedBadges.first()).toBeVisible({ timeout: 10_000 })
    } finally {
      // Always clear state to keep prod tidy
      await clearState(request, target.id, sessionId)
    }
  })

  test('public visitor cannot see triage filters or PUT state', async ({ page, request }) => {
    test.setTimeout(60_000)
    await page.goto('/')
    await page.waitForResponse(r => r.url().includes('/jobplatform/api/jobs') && r.ok(), {
      timeout: 30_000
    })
    // State dropdown only renders when at least one returned job has a non-null
    // state field, which only happens when authed. Public sees no state field.
    await expect(page.getByLabel('State')).toHaveCount(0)
    await expect(page.getByText('Hide dismissed')).toHaveCount(0)

    // Direct PUT without auth → 403
    const list = await request.get('http://localhost:5173/jobplatform/api/jobs?limit=1')
    const job = ((await list.json()) as { data: { jobs: Array<{ id: string }> } }).data.jobs[0]
    const putResp = await request.put(
      `http://localhost:5173/jobplatform/api/jobs/${encodeURIComponent(job.id)}/state`,
      {
        data: { state: 'interested' },
        headers: { 'Content-Type': 'application/json' }
      }
    )
    expect(putResp.status()).toBe(403)
  })

  test('hide_dismissed=true excludes dismissed jobs from the list', async ({ request }) => {
    const sessionId = await freshSessionId(request)
    const list = await request.get('http://localhost:5173/jobplatform/api/jobs?limit=5', {
      headers: { 'X-Session-Id': sessionId }
    })
    const jobs = ((await list.json()) as { data: { jobs: Array<{ id: string }> } }).data.jobs
    const target = jobs[0]

    try {
      // Mark dismissed via API
      const putResp = await request.put(
        `http://localhost:5173/jobplatform/api/jobs/${encodeURIComponent(target.id)}/state`,
        {
          data: { state: 'dismissed' },
          headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId }
        }
      )
      expect(putResp.ok()).toBe(true)

      // Default hide_dismissed=true: target shouldn't appear.
      const hidden = await request.get(
        'http://localhost:5173/jobplatform/api/jobs?hide_dismissed=true&limit=100',
        { headers: { 'X-Session-Id': sessionId } }
      )
      const hiddenIds = (
        (await hidden.json()) as { data: { jobs: Array<{ id: string }> } }
      ).data.jobs.map(j => j.id)
      expect(hiddenIds).not.toContain(target.id)

      // Without hide_dismissed: target should appear (it's still on page 1).
      const visible = await request.get(
        'http://localhost:5173/jobplatform/api/jobs?state=dismissed&limit=100',
        { headers: { 'X-Session-Id': sessionId } }
      )
      const dismissedIds = (
        (await visible.json()) as { data: { jobs: Array<{ id: string; state: string }> } }
      ).data.jobs.map(j => j.id)
      expect(dismissedIds).toContain(target.id)
    } finally {
      await clearState(request, target.id, sessionId)
    }
  })
})
