import { defineConfig, type ProxyOptions } from 'vite'

type ProxyServer = Parameters<NonNullable<ProxyOptions['configure']>>[0]
import react from '@vitejs/plugin-react'
import { labelFor } from '@wolffm/catalogue'

// THE APP'S ID — the one identifier this repo states about itself. The display
// NAME is looked up from it, so the two can never disagree. Must match the `id`
// in hadoku_site's spec/categories.json.
const APP_ID = 'jobplatform'

// Read from the catalogue at CONFIG TIME (this file runs in node), so the name
// is never written down in this repo and the catalogue never ships in the bundle.
const APP_NAME = labelFor(APP_ID) ?? APP_ID

/**
 * Make hadoku.me's session cookie land on localhost, for the dev harness.
 *
 * It arrives `Domain=.hadoku.me`, which a localhost page refuses, so the domain
 * is stripped. edge-router also sends a second `hadoku_session=; Max-Age=0`
 * clearing any legacy host-only cookie — harmless on hadoku.me, but once the
 * first is host-only too it deletes the session it follows, so it is dropped.
 */
function onLocalhost(proxy: ProxyServer) {
  proxy.on('proxyRes', res => {
    const cookies = res.headers['set-cookie']
    if (!cookies) return
    res.headers['set-cookie'] = cookies
      .filter(c => !/;\s*Max-Age=0\b/i.test(c))
      .map(c => c.replace(/;\s*Domain=[^;]*/i, ''))
  })
}

export default defineConfig({
  define: {
    // The standalone name. Mounted by the host, `appName` in the registry props
    // carries the live value and this is never read.
    __HADOKU_APP_NAME__: JSON.stringify(APP_NAME)
  },
  plugins: [
    {
      // index.html is static and cannot import the catalogue; this keeps the
      // standalone TAB and the standalone HEADER the one name.
      name: 'hadoku-app-name',
      transformIndexHtml: (html: string) => html.split('__HADOKU_APP_NAME__').join(APP_NAME)
    },
    react()
  ],
  server: {
    // Dev smoke-testing: proxy hadoku-mediated paths to production so the MFE
    // renders real data when running `pnpm dev` locally.
    //   /jobplatform/api  — worker calls (jobs, profiles, companies, ingest)
    //   /session          — auth handshake; index.html exchanges ?apiKey= for
    //                       the hadoku_session cookie via /session/create
    // Requests authenticate by the hadoku_session cookie, as in production —
    // see onLocalhost below for what it takes to land that cookie here.
    proxy: {
      '/jobplatform/api': {
        target: 'https://hadoku.me',
        changeOrigin: true,
        secure: true,
        configure: onLocalhost
      },
      '/session': {
        target: 'https://hadoku.me',
        changeOrigin: true,
        secure: true,
        configure: onLocalhost
      }
    }
  },
  build: {
    // The favicon in public/ is for the `vite dev` harness only. This bundle is
    // a library mounted into hadoku.me, which serves its own favicon from the
    // site root — so copying public/ into dist/ would ship a stray asset in the
    // published package that nothing would ever read.
    copyPublicDir: false,
    lib: {
      entry: 'src/entry.tsx',
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // Externalize peer dependencies (parent provides them via import map)
      // Provided by the parent page's import map (hadoku_site
      // src/layouts/Base.astro). Each of these is a SINGLETON: React and the
      // theme context match on module identity, and prefs-client and the logger
      // each hold their own cache. Inlining one gives the page a second copy
      // that the first never talks to — which is how aggregator and printtool
      // threw "No <HadokuThemeRoot> above this component" on 2026-08-05 with
      // the provider plainly mounted.
      // Enforced by hadoku_site's check:mf-externals.
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        '@wolffm/themes',
        '@wolffm/task-ui-components',
        '@wolffm/logger/client'
      ],
      output: {
        assetFileNames: 'style.css'
      }
    },
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: false
  }
})
