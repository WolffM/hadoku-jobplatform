import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/**
 * src/telemetry.ts in a real browser: one delegated listener records every
 * control, never what is typed, and the batch reaches the relay in the shape
 * worker/src/routes/telemetry.ts accepts.
 */

let bundle = ''

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../../src/telemetry.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'Telemetry',
    define: { 'import.meta.env.DEV': 'false' }
  })
  bundle = out.outputFiles[0].text
})

interface Batch {
  app: string
  session: string
  events: { event: string; level: string; at: number; props: Record<string, unknown> }[]
}

const ORIGIN = 'https://hadoku.test'

async function open(page: Page): Promise<Batch[]> {
  const batches: Batch[] = []
  await page.route(`${ORIGIN}/jobplatform/api/telemetry`, async route => {
    batches.push(route.request().postDataJSON() as Batch)
    await route.fulfill({ status: 202, json: { success: true, data: { accepted: 1 } } })
  })
  await page.route(`${ORIGIN}/jobplatform/api/jobs/broken*`, route =>
    route.fulfill({ status: 503, json: { success: false } })
  )
  await page.route(`${ORIGIN}/jobplatform/api/jobs/offline`, route => route.abort('failed'))
  await page.route(`${ORIGIN}/jobplatform/`, route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body>
        <div id="outside"><button>Not ours</button></div>
        <div id="root">
          <button id="save"><svg></svg> <span>Save</span></button>
          <button id="icon" aria-label="Close drawer">×</button>
          <a id="link" href="#/pipeline">Pipeline</a>
          <label><input id="remote" type="checkbox" name="remote"> Remote only</label>
          <select id="sort" aria-label="Sort"><option value="score">Best match</option><option value="new">Newest</option></select>
          <input id="search" type="text" aria-label="Search">
          <form id="f" aria-label="Import posting"><input name="url"><button id="go">Import</button></form>
          <div id="backdrop" data-telemetry="Close drawer (backdrop)" style="width:40px;height:40px"></div>
        </div></body>`
    })
  )
  await page.goto(`${ORIGIN}/jobplatform/#/feed`)
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => {
    const w = window as unknown as {
      Telemetry: { startTelemetry: (el: HTMLElement, o: { app: string }) => () => void }
      stop: () => void
    }
    w.stop = w.Telemetry.startTelemetry(document.getElementById('root')!, { app: 'jobplatform' })
    document.getElementById('f')!.addEventListener('submit', e => e.preventDefault())
  })
  return batches
}

async function sent(page: Page, batches: Batch[]) {
  await page.evaluate(() =>
    (window as unknown as { Telemetry: { flush: () => void } }).Telemetry.flush()
  )
  await expect.poll(() => batches.length).toBeGreaterThan(0)
  return batches.flatMap(b => b.events)
}

test('records every control inside the app, by the name a person would use', async ({ page }) => {
  const batches = await open(page)
  await page.click('#save span')
  await page.click('#icon')
  await page.click('#link')
  await page.click('#remote')
  await page.selectOption('#sort', 'new')
  await page.fill('#search', 'my secret search')
  await page.click('#outside button')
  await page.click('#backdrop')
  await page.click('#go')

  const events = await sent(page, batches)
  const clicks = events.filter(e => e.event === 'ui.click').map(e => e.props.label)
  expect(clicks).toEqual([
    'Save',
    'Close drawer',
    'Pipeline',
    'Remote only',
    'Close drawer (backdrop)',
    'Import'
  ])

  const link = events.find(e => e.props.label === 'Pipeline')!
  expect(link.props.href).toBe('/jobplatform/#/pipeline')
  expect(events.find(e => e.props.label === 'Remote only')!.props.checked).toBe(true)
  expect(events.find(e => e.event === 'ui.change')!.props).toMatchObject({
    label: 'Sort',
    value: 'Newest'
  })
  expect(events.find(e => e.event === 'ui.submit')!.props).toMatchObject({
    label: 'Import posting',
    submitter: 'Import'
  })
  expect(events[0].event).toBe('app.mounted')
  expect(events[0].props.route).toBe('#/feed')

  expect(JSON.stringify(batches)).not.toContain('my secret search')
  expect(JSON.stringify(batches)).not.toContain('Not ours')
  expect(batches[0].app).toBe('jobplatform')
  expect(batches[0].session).toMatch(/^[0-9a-f]{24}$/)
})

test('records API calls that failed, including ones that got no answer', async ({ page }) => {
  const batches = await open(page)
  await page.evaluate(async () => {
    const T = (
      window as unknown as { Telemetry: { trackedFetch: (u: string) => Promise<Response> } }
    ).Telemetry
    await T.trackedFetch('/jobplatform/api/jobs/broken?x=1')
    await T.trackedFetch('/jobplatform/api/jobs/offline').catch(() => undefined)
  })
  const errors = (await sent(page, batches)).filter(e => e.event === 'api.error')
  expect(errors.map(e => [e.props.path, e.props.status, e.level])).toEqual([
    ['/jobplatform/api/jobs/broken', 503, 'error'],
    ['/jobplatform/api/jobs/offline', 0, 'error']
  ])
})

test('unmount removes the listeners and sends what is left', async ({ page }) => {
  const batches = await open(page)
  await page.click('#save')
  await page.evaluate(() => (window as unknown as { stop: () => void }).stop())
  await expect
    .poll(() => batches.flatMap(b => b.events).map(e => e.event))
    .toContain('app.unmounted')
  const before = batches.length
  await page.click('#save')
  await page.waitForTimeout(300)
  expect(batches.length).toBe(before)
})
