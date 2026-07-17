import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { parseRequestBody, isUuid, MAX_LIST_ROWS } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

const PLACEHOLDER_USER_ID = '00000000-0000-0000-0000-000000000000'

const MAX_NAME_LENGTH = 500
const MAX_DESCRIPTION_LENGTH = 5000

export async function GET(request: NextRequest) {
  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('project_id')
    if (projectId && !isUuid(projectId)) {
      return NextResponse.json({ error: 'project_id must be a valid UUID' }, { status: 400 })
    }

    let query = supabase
      .from(T.products)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(MAX_LIST_ROWS)

    if (projectId) {
      query = query.eq('project_id', projectId)
    }

    const { data, error } = await query

    if (error) { logger.error('[Products GET]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[Products GET] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body
    const { name, description, global_style_settings, project_id } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (typeof name === 'string' && name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (!project_id) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
    }
    if (typeof project_id !== 'string' || !isUuid(project_id)) {
      return NextResponse.json({ error: 'project_id must be a valid UUID' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(T.products)
      .insert({
        user_id: PLACEHOLDER_USER_ID,
        project_id,
        name,
        description: description ?? null,
        global_style_settings: global_style_settings ?? {},
      })
      .select()
      .single()

    if (error) { logger.error('[Products POST]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logger.error('[Products POST] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
