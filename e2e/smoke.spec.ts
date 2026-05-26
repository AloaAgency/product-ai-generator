import { test, expect } from '@playwright/test'

/**
 * Baseline smoke tests — no authentication required.
 *
 * These exercise the public surface area of the middleware:
 *   - Unauthenticated document requests should render the login gate at 200.
 *   - Unauthenticated API requests should return 401 JSON.
 *   - Security headers should be present on responses.
 *
 * Night-shift sweeps run this suite via `npm run e2e` to detect regressions
 * in the auth gate without needing the site password.
 */

test.describe('public smoke', () => {
  test('login gate renders for unauthenticated document requests', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    await expect(page).toHaveTitle(/Aloa AI Product Imager/i)
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toBeVisible()
  })

  test('unauthenticated API requests return 401 JSON', async ({ request }) => {
    const response = await request.get('/api/projects')
    expect(response.status()).toBe(401)
    const body = await response.json()
    expect(body).toMatchObject({ error: expect.stringMatching(/unauthorized/i) })
  })

  test('security headers are applied to responses', async ({ request }) => {
    const response = await request.get('/')
    const headers = response.headers()
    // applySecurityHeaders should set at least these — adjust if security-headers.ts changes.
    expect(headers['x-frame-options'] || headers['content-security-policy']).toBeTruthy()
  })

  test('login gate response is not cacheable', async ({ request }) => {
    const response = await request.get('/some-protected-path')
    expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toContain('no-store')
  })
})
