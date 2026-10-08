import { defineConfig } from '@playwright/test'
const production = process.env.MISAKA_E2E_PRODUCTION === '1'
const port = Number(process.env.MISAKA_E2E_PORT || 4174)

export default defineConfig({
  testDir: './e2e', testMatch: '**/*.spec.ts', testIgnore: '**/electron-*.spec.ts', timeout: 30000, workers: 1,
  outputDir: process.env.MISAKA_E2E_OUTPUT || 'test-results',
  use: { baseURL: `http://127.0.0.1:${port}`, channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: {
    command: production ? 'pnpm exec vite build --config vite.e2e.config.mts && pnpm exec vite preview --config vite.e2e.config.mts' : 'pnpm exec vite --config vite.e2e.config.mts',
    url: `http://127.0.0.1:${port}/e2e/conversation.html`, reuseExistingServer: !process.env.CI && !production, timeout: 120000,
  },
})
