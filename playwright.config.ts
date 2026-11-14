import { defineConfig, devices } from '@playwright/test';

// Studio smoke tests of the extensions' Vue.js components against a
// disposable Directus that setup has installed (CI: the Integration
// workflow). The target is named by DIRECTUS_E2E_URL and must be on
// loopback (e2e/studio.e2e.ts).
export default defineConfig({
  forbidOnly: Boolean(process.env['CI']),
  fullyParallel: false,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  retries: process.env['CI'] ? 1 : 0,
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  use: {
    baseURL: process.env['DIRECTUS_E2E_URL'],
    trace: 'retain-on-failure',
  },
  workers: 1,
});
