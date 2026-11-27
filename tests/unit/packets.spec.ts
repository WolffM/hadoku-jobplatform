import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/**
 * src/api/packets.ts's getPacketVariant in a real browser, against stubbed
 * routes. A packet minted for a user other than the site owner answers 404
 * VARIANT_GONE once it expires or is deleted (resume-api never serves the
 * owner's résumé in its place); the packet page must say the packet is gone,
 * not show a bare HTTP error.
 */

let bundle = ''

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../../src/api/packets.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'Packets',
    define: { 'import.meta.env.DEV': 'false' }
  })
  bundle = out.outputFiles[0].text
})

const ORIGIN = 'https://hadoku.me'

async function open(page: Page) {
  await page.route(`${ORIGIN}/jobplatform/api/telemetry`, route =>
    route.fulfill({ status: 202, json: { success: true, data: { accepted: 1 } } })
  )
  await page.route(`${ORIGIN}/resume/api/resume?v=*`, route => {
    const v = new URL(route.request().url()).searchParams.get('v')
    if (v === 'gone')
      return route.fulfill({
        status: 404,
        json: { error: 'This application packet has expired or was removed.', code: 'VARIANT_GONE' }
      })
    if (v === 'broken') return route.fulfill({ status: 500, json: { error: 'boom' } })
    return route.fulfill({ json: { content: '# Robin', variant: v } })
  })
  await page.route(`${ORIGIN}/jobplatform/`, route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' })
  )
  await page.goto(`${ORIGIN}/jobplatform/`)
  await page.addScriptTag({ content: bundle })
}

function load(page: Page, slug: string) {
  return page.evaluate(
    s =>
      (
        window as unknown as {
          Packets: { getPacketVariant: (slug: string) => Promise<unknown> }
        }
      ).Packets.getPacketVariant(s).then(
        v => ({ ok: v }),
        (e: Error) => ({ error: e.message })
      ),
    slug
  )
}

test('a live packet loads', async ({ page }) => {
  await open(page)
  expect(await load(page, 'live')).toEqual({ ok: { content: '# Robin', variant: 'live' } })
})

test('a gone packet says it expired or was removed', async ({ page }) => {
  await open(page)
  expect(await load(page, 'gone')).toEqual({
    error:
      'This packet link has expired or was removed. Prepare the application again for a new one.'
  })
})

test('any other failure is still an HTTP error', async ({ page }) => {
  await open(page)
  expect(await load(page, 'broken')).toEqual({ error: 'Failed to load packet (HTTP 500)' })
})
