import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pageJob } from '../src/ats'

const here = dirname(fileURLToPath(import.meta.url))
const EXT = join(here, '..', 'dist')
const ASHBY_URL = 'https://jobs.ashbyhq.com/acme/021cca9c-f937-4d97-8be7-bc83af8307be/application'
const JOB = 'ashby_021cca9c-f937-4d97-8be7-bc83af8307be'

/** A synthetic owner — nothing here is anyone's real data. */
const PACKET = {
  job: { id: JOB, company: 'acme', title: 'Engineer', url: '' },
  application: { id: 'app-1', status: 'approved', variant_slug: '' },
  profile: {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    linkedin: 'https://linkedin.com/in/ada'
  },
  answers: { 'will you now or in the future require visa sponsorship': 'No' },
  options: {},
  multi: [],
  standing: { 'Current/Most Recent Company Name': 'Analytical Engines', Race: 'White' },
  resume_pdf_url: null
}

test('the URL names the job jobplatform stores', () => {
  expect(
    pageJob('https://job-boards.greenhouse.io/embed/job_app?for=instacart&token=8053797')
  ).toEqual({
    ats: 'greenhouse',
    jobId: 'greenhouse_8053797'
  })
  expect(pageJob('https://job-boards.greenhouse.io/toast/jobs/7735338')?.jobId).toBe(
    'greenhouse_7735338'
  )
  expect(pageJob(ASHBY_URL)?.jobId).toBe(JOB)
  expect(
    pageJob('https://jobs.lever.co/aledade/63db4a0e-53a1-4dcc-b846-55ec47bd38b4/apply')?.jobId
  ).toBe('lever_63db4a0e-53a1-4dcc-b846-55ec47bd38b4')
  expect(pageJob('https://jobs.ashbyhq.com/acme')).toBeNull()
})

test.describe('filling an Ashby form', () => {
  let server: Server
  let ctx: BrowserContext
  const posted: string[] = []

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': req.headers.origin ?? '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
      if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end()
      const send = (body: unknown) =>
        res
          .writeHead(200, { 'Content-Type': 'application/json', ...cors })
          .end(JSON.stringify(body))
      if (req.url?.includes('/fill-packet')) return send({ success: true, data: PACKET })
      if (req.url?.includes('/status')) posted.push(req.url)
      send({ success: true, data: {} })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'hadoku-fill-')), {
      // Full Chromium in headless mode: the headless shell cannot run extensions.
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    })
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
    await sw.evaluate(
      base => chrome.storage.local.set({ apiBase: base }),
      `http://127.0.0.1:${port}`
    )
  })

  test.afterAll(async () => {
    await ctx.close()
    server.close()
  })

  test('fills every answered question and reports the missing résumé', async () => {
    const page = await ctx.newPage()
    await page.route(ASHBY_URL, r =>
      r.fulfill({
        contentType: 'text/html',
        body: readFileSync(join(here, 'fixtures/ashby.html'), 'utf8')
      })
    )
    await page.goto(ASHBY_URL)
    const panel = page.locator('#hadoku-fill .panel')
    await expect(panel).toContainText('acme — Engineer · approved')
    await page.locator('#hadoku-fill button.primary').click()
    await expect(panel).toContainText('Filled (6)')

    expect(await page.inputValue('#_systemfield_name')).toBe('Ada Lovelace')
    expect(await page.inputValue('#_systemfield_email')).toBe('ada@example.test')
    expect(await page.inputValue('#li')).toBe('https://linkedin.com/in/ada')
    expect(await page.inputValue('#co')).toBe('Analytical Engines')
    await expect(page.locator('#sponsor button[data-option="no"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.locator('#r1')).toBeChecked() // "White" → "White (Not Hispanic or Latino)"
    await expect(panel).toContainText('no tailored résumé was made for this job')
    expect(posted, 'filling never marks anything sent').toEqual([])
  })
})
