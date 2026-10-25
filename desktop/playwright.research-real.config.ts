import { defineConfig } from '@playwright/test'

// Explicit, potentially billable acceptance. This filename/spec is outside electron-* matching.
export default defineConfig({
  testDir: './e2e', testMatch: '**/research-real-model.spec.ts', workers: 1,
  retries: 0, timeout: 3 * 3_600_000 + 300_000,
  expect: { timeout: 30_000 }, reporter: 'list',
  use: { trace: 'off', video: 'off', screenshot: 'off' },
})
