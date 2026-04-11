import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

const PLACEHOLDER_USER_ID = '00000000-0000-0000-0000-000000000000'

const MAX_NAME_LENGTH = 500
const MAX_DESCRIPTION_LENGTH = 5000

export async function GET() {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from(T.projects)
      .select('*')
      .order('created_at', { ascending: false })

    if (error) { console.error('[Projects GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServiceClient()
    const body = await request.json()
    const { name, description, global_style_settings } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (typeof name === 'string' && name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(T.projects)
      .insert({
        user_id: PLACEHOLDER_USER_ID,
        name,
        description: description ?? null,
        global_style_settings: global_style_settings ?? {},
      })
      .select()
      .single()

    if (error) { console.error('[Projects POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
