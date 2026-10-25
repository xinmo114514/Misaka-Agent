import { defineConfig } from '@playwright/test'
import browserConfig from './playwright.config'

// Isolated renderer fixtures only: no Python service, credentials, or real user profile.
export default defineConfig({
  ...browserConfig,
  testIgnore: [],
  testMatch: ['**/electron-focus-ui.spec.ts', '**/electron-multi-ui.spec.ts'],
  timeout: 90000,
})
