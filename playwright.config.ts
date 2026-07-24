import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for end-to-end tests.
 *
 * Tests live in `./e2e` and run against a local Next.js dev server unless
 * `PLAYWRIGHT_BASE_URL` is set (e.g. for night-shift sweeps that point at a
 * preview deployment).
 *
 * Run locally:
 *   npm run e2e            # headless
 *   npm run e2e -- --ui    # interactive UI mode
 *   npm run e2e -- --debug # step-debug mode
 *
 * First-time setup (installs browsers):
 *   npm run e2e:install
 */
const PORT = Number(process.env.PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Auto-start a local dev server unless one is already running or we're
  // pointing at a remote PLAYWRIGHT_BASE_URL (then skip).
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run dev -- --port ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
