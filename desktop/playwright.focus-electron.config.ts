import { defineConfig } from '@playwright/test'
import browserConfig from './playwright.config'

// The real Electron renderer uses the isolated browser fixture, with no Python/model service.
export default defineConfig({
  ...browserConfig,
  testIgnore: [],
  testMatch: '**/electron-focus-ui.spec.ts',
  timeout: 90000,
})
