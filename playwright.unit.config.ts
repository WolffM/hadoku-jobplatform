import { defineConfig } from '@playwright/test'

/**
 * Browser-only units: code that needs a real DOM (DOMParser) but no server,
 * no credential and no network. `pnpm test:unit`. The main config
 * (playwright.config.ts) is the end-to-end suite against production.
 */
export default defineConfig({
  testDir: './tests/unit',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  reporter: [['list']]
})
