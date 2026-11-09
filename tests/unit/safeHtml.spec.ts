import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/**
 * safeHtml in a real browser DOM: what a hostile description (any page's
 * JSON-LD, via POST /jobs/import) is cut down to before the drawer renders it.
 */

let bundle = ''

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../../src/components/safeHtml.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'SafeHtml'
  })
  bundle = out.outputFiles[0].text
})

const CASES: [string, string, string][] = [
  [
    'keeps formatting',
    '<p>Hi <strong>there</strong></p><ul><li>a</li></ul>',
    '<p>Hi <strong>there</strong></p><ul><li>a</li></ul>'
  ],
  ['drops a script and its text', '<p>ok</p><script>alert(1)</script>', '<p>ok</p>'],
  ['drops event handlers', '<p onclick="alert(1)" class="x" style="color:red">ok</p>', '<p>ok</p>'],
  ['unwraps an img, losing onerror', '<p>a<img src=x onerror="alert(1)">b</p>', '<p>ab</p>'],
  ['drops a javascript: link target', '<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
  ['drops a relative link target', '<a href="/session/admin">x</a>', '<a>x</a>'],
  [
    'keeps an https link, opened safely',
    '<a href="https://example.com/apply">apply</a>',
    '<a href="https://example.com/apply" target="_blank" rel="noopener noreferrer nofollow">apply</a>'
  ],
  [
    'drops an iframe and svg',
    '<iframe src="https://evil.example"></iframe><svg onload="alert(1)"><text>t</text></svg>ok',
    'ok'
  ],
  [
    're-escapes text',
    '<p>&lt;script&gt;x&lt;/script&gt; &amp; co</p>',
    '<p>&lt;script&gt;x&lt;/script&gt; &amp; co</p>'
  ],
  ['drops comments', '<p>a<!-- hidden -->b</p>', '<p>ab</p>']
]

for (const [name, input, expected] of CASES) {
  test(name, async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>')
    await page.addScriptTag({ content: bundle })
    const got = await page.evaluate(
      html =>
        (window as unknown as { SafeHtml: { safeHtml: (h: string) => string } }).SafeHtml.safeHtml(
          html
        ),
      input
    )
    expect(got).toBe(expected)
  })
}

test('nothing in a hostile description runs while it is cleaned or rendered', async ({ page }) => {
  await page.setContent('<!doctype html><html><body><div id="d"></div></body></html>')
  await page.addScriptTag({ content: bundle })
  const fired = await page.evaluate(async () => {
    const w = window as unknown as { hit?: boolean; SafeHtml: { safeHtml: (h: string) => string } }
    const hostile =
      '<img src=x onerror="window.hit=true"><svg onload="window.hit=true"></svg>' +
      '<script>window.hit=true</script><a href="javascript:window.hit=true" id="l">x</a>'
    document.getElementById('d')!.innerHTML = w.SafeHtml.safeHtml(hostile)
    ;(document.getElementById('l') as HTMLAnchorElement | null)?.click()
    await new Promise(r => setTimeout(r, 200))
    return w.hit === true
  })
  expect(fired).toBe(false)
})
