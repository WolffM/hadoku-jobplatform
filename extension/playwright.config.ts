import { defineConfig } from '@playwright/test'

// The Fill extension's own suite: loads extension/dist into Chromium and fills
// fixture forms served at the real board URLs. Build first (pnpm build:extension).
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  reporter: 'list'
})
