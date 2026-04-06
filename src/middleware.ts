import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, deriveAuthToken } from '@/lib/auth-constants'

// Static parts of the login page HTML, split so the form (which varies per request)
// can be inserted between them without re-declaring the surrounding boilerplate.
const LOGIN_PAGE_PREFIX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Login - Aloa AI Product Imager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #09090b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; text-align: center; }
    label { display: block; font-size: 0.875rem; color: #a1a1aa; margin-bottom: 0.375rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; border-radius: 8px; border: 1px solid #3f3f46; background: #27272a; color: #f4f4f5; font-size: 0.875rem; outline: none; }
    input:focus { border-color: #71717a; box-shadow: 0 0 0 2px rgba(113, 113, 122, 0.2); }
    button { width: 100%; margin-top: 1rem; padding: 0.5rem; border-radius: 8px; border: none; background: #fff; color: #09090b; font-size: 0.875rem; font-weight: 500; cursor: pointer; }
    button:hover { background: #e4e4e7; }
    .error { color: #ef4444; font-size: 0.8rem; margin-top: 0.75rem; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Aloa AI Product Imager</h1>`

// Inline script that disables the submit button and shows "Signing in…"
// during form submission, matching the loading-state pattern used elsewhere
// in the app (e.g. BugReportWidget sets isSubmitting on submit).
const LOGIN_PAGE_SUFFIX = `  </div>
  <script>
    document.querySelector('form').addEventListener('submit', function() {
      var btn = this.querySelector('[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in\u2026'; }
    });
  </script>
</body>
</html>`

const ERROR_HTML = '<p class="error">Incorrect password</p>'

/** Minimal HTML-attribute escaping to prevent reflected XSS via the redirect path. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function loginPage(showError: boolean, redirectPath: string) {
  const safeRedirect = escapeAttr(redirectPath)
  return (
    LOGIN_PAGE_PREFIX +
    `\n    <form method="POST" action="/api/login">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" placeholder="Enter password" autofocus required />
      <button type="submit">Sign In</button>
      ${showError ? ERROR_HTML : ''}
    </form>\n` +
    LOGIN_PAGE_SUFFIX
  )
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Login endpoint must be public so unauthenticated users can submit credentials.
  if (pathname === '/api/login') {
    return NextResponse.next()
  }

  // Worker endpoint uses its own CRON_SECRET auth — site-password auth doesn't apply.
  if (pathname === '/api/worker/generate') {
    return NextResponse.next()
  }

  // Check for auth cookie. The cookie value is an HMAC derived from
  // SITE_PASSWORD — a predictable static string like "authenticated" would
  // allow any visitor who reads the source to forge a valid cookie.
  const password = process.env.SITE_PASSWORD
  if (password) {
    const auth = request.cookies.get(AUTH_COOKIE_NAME)
    if (auth?.value === deriveAuthToken(password)) {
      return NextResponse.next()
    }
  }

  // Show login page, preserving the intended destination
  const showError = request.nextUrl.searchParams.has('error')
  return new NextResponse(loginPage(showError, pathname), {
    status: 401,
    headers: { 'content-type': 'text/html' },
  })
}

export const config = {
  // Exclude static assets, images, and known public files from middleware
  // to avoid cookie-check overhead on requests that never need auth.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js|map)$).*)'],
}
