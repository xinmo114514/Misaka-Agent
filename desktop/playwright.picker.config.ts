import { defineConfig } from '@playwright/test'
import base from './playwright.config'

/** Isolated preview avoids HMR/reload collisions with other in-progress desktop work. */
export default defineConfig(base, {
  testMatch: '**/modelPicker.spec.ts',
  outputDir: 'test-results-model-picker',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4176', reducedMotion: 'reduce' },
  webServer: { command: 'pnpm exec vite --config vite.picker.config.mts', url: 'http://127.0.0.1:4176/e2e/conversation.html', reuseExistingServer: !process.env.CI },
})
