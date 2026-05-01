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
    lib: {
      entry: 'src/entry.tsx',
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // Externalize peer dependencies (parent provides them via import map)
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        '@wolffm/themes',
        '@wolffm/task-ui-components'
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
