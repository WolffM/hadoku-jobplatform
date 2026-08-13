import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev smoke-testing: proxy hadoku-mediated paths to production so the MFE
    // renders real data when running `pnpm dev` locally.
    //   /jobplatform/api  — worker calls (jobs, profiles, companies, ingest)
    //   /session          — auth handshake; index.html exchanges ?apiKey= for
    //                       a sessionId via /session/create on first load
    proxy: {
      '/jobplatform/api': {
        target: 'https://hadoku.me',
        changeOrigin: true,
        secure: true
      },
      '/session': {
        target: 'https://hadoku.me',
        changeOrigin: true,
        secure: true
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
