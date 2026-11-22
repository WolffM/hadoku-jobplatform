import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/**
 * src/api/applyQueue.ts's prepare sequence in a real browser, against stubbed
 * routes: it asks resume-api for the application kit ONCE and hands that kit
 * (or why it failed) back. The drawer used to ask a second time for the same
 * kit, which doubled every Prepare's LLM spend and every failure (issue #30).
 */

let bundle = ''

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../../src/api/applyQueue.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'ApplyQueue',
    define: { 'import.meta.env.DEV': 'false' }
  })
  bundle = out.outputFiles[0].text
})

const ORIGIN = 'https://hadoku.test'
const KIT = {
  cover_letter_markdown: 'Dear team',
  intro_email: 'Hi',
  why_hook: 'Because',
  screening_answers: [],
  salary_line: '',
  linkedin_note: '',
  talking_points: [],
  standard_fields: '',
  cached: false
}

async function open(page: Page, extras: 'ok' | 'fail'): Promise<Record<string, number>> {
  const calls: Record<string, number> = {}
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1)
  await page.route(`${ORIGIN}/jobplatform/api/telemetry`, route =>
    route.fulfill({ status: 202, json: { success: true, data: { accepted: 1 } } })
  )
  await page.route(`${ORIGIN}/jobplatform/api/jobs/j1/resume`, route => {
    count('resume')
    return route.fulfill({ json: { success: true, data: { resume_markdown: '# Me' } } })
  })
  await page.route(`${ORIGIN}/jobplatform/api/jobs/j1/application-extras`, route => {
    count('extras')
    return extras === 'ok'
      ? route.fulfill({ json: { success: true, data: KIT } })
      : route.fulfill({
          status: 502,
          json: { success: false, error: 'Upstream error', message: 'resume-api 500' }
        })
  })
  await page.route(`${ORIGIN}/jobplatform/api/jobs/j1/cover-letter`, route => {
    count('cover-letter')
    return route.fulfill({ json: { success: true, data: { cover_letter_markdown: 'Dear' } } })
  })
  await page.route(`${ORIGIN}/jobplatform/api/jobs/j1/packet-link`, route => {
    count('packet-link')
    return route.fulfill({
      json: { success: true, data: { slug: 's1', url: 'https://hadoku.me/resume?v=s1' } }
    })
  })
  await page.route(`${ORIGIN}/jobplatform/`, route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' })
  )
  await page.goto(`${ORIGIN}/jobplatform/`)
  await page.addScriptTag({ content: bundle })
  return calls
}

test('prepare asks for the kit once and returns it', async ({ page }) => {
  const calls = await open(page, 'ok')
  const built = await page.evaluate(() =>
    (
      window as unknown as {
        ApplyQueue: { prepareApplicationPacket: (id: string, a: object) => Promise<unknown> }
      }
    ).ApplyQueue.prepareApplicationPacket('j1', { signedIn: true })
  )
  expect(built).toMatchObject({
    slug: 's1',
    resume: '# Me',
    coverLetter: 'Dear team',
    kit: { intro_email: 'Hi' },
    kitError: null
  })
  expect(calls).toEqual({ resume: 1, extras: 1, 'packet-link': 1 })
})

test('a failed kit is reported, not retried, and the packet still mints', async ({ page }) => {
  const calls = await open(page, 'fail')
  const built = await page.evaluate(() =>
    (
      window as unknown as {
        ApplyQueue: { prepareApplicationPacket: (id: string, a: object) => Promise<unknown> }
      }
    ).ApplyQueue.prepareApplicationPacket('j1', { signedIn: true })
  )
  expect(built).toMatchObject({
    slug: 's1',
    coverLetter: '',
    kit: null,
    kitError: 'resume-api 500'
  })
  expect(calls).toEqual({ resume: 1, extras: 1, 'packet-link': 1 })
})
