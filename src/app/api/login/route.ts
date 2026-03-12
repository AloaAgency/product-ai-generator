import { NextRequest, NextResponse } from 'next/server'

const PASSWORD = process.env.SITE_PASSWORD || 'aloaagency@1234'
const COOKIE_NAME = 'site-auth'

export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const password = formData.get('password') as string
  const redirectPath = (formData.get('redirect') as string) || '/'

  // Validate redirect path: must be a relative path starting with /
  // to prevent open-redirect attacks
  const safeRedirect = redirectPath.startsWith('/') ? redirectPath : '/'

  if (password === PASSWORD) {
    const response = NextResponse.redirect(new URL(safeRedirect, request.url))
    response.cookies.set(COOKIE_NAME, 'authenticated', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })
    return response
  }

  // Wrong password — redirect back to the same page to show login with error
  const errorUrl = new URL(safeRedirect, request.url)
  errorUrl.searchParams.set('error', '1')
  return new NextResponse(null, {
    status: 303,
    headers: { Location: errorUrl.pathname + errorUrl.search },
  })
}
