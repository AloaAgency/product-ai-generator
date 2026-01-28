import { NextRequest, NextResponse } from 'next/server'

const PASSWORD = process.env.SITE_PASSWORD || 'aloaagency@1234'
const COOKIE_NAME = 'site-auth'

export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const password = formData.get('password') as string

  if (password === PASSWORD) {
    const response = NextResponse.redirect(new URL('/', request.url))
    response.cookies.set(COOKIE_NAME, 'authenticated', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })
    return response
  }

  // Wrong password — show login page again with error
  return new NextResponse(null, {
    status: 303,
    headers: { Location: '/?error=1' },
  })
}
