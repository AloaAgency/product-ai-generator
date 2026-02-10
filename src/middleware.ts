import { NextRequest, NextResponse } from 'next/server'

const PASSWORD = process.env.SITE_PASSWORD || 'aloaagency@1234'
const COOKIE_NAME = 'site-auth'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow the login API route through
  if (pathname === '/api/login' || pathname.startsWith('/api/worker/generate')) {
    return NextResponse.next()
  }

  // Check for auth cookie
  const auth = request.cookies.get(COOKIE_NAME)
  if (auth?.value === 'authenticated') {
    return NextResponse.next()
  }

  // Redirect to login page
  const loginUrl = new URL('/api/login', request.url)
  loginUrl.searchParams.set('redirect', pathname)
  return new NextResponse(loginPage(loginUrl.searchParams.get('error') || ''), {
    status: 401,
    headers: { 'content-type': 'text/html' },
  })
}

function loginPage(error: string) {
  return `<!DOCTYPE html>
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
    input:focus { border-color: #71717a; }
    button { width: 100%; margin-top: 1rem; padding: 0.5rem; border-radius: 8px; border: none; background: #fff; color: #09090b; font-size: 0.875rem; font-weight: 500; cursor: pointer; }
    button:hover { background: #e4e4e7; }
    .error { color: #ef4444; font-size: 0.8rem; margin-top: 0.75rem; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Aloa AI Product Imager</h1>
    <form method="POST" action="/api/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Enter password" autofocus required />
      <button type="submit">Sign In</button>
      ${error ? '<p class="error">Incorrect password</p>' : ''}
    </form>
  </div>
</body>
</html>`
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
