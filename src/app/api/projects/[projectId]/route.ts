import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { requireUuid, parseRequestBody, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '@/lib/request-guards'
import { logger } from '@/lib/server-logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId: rawProjectId } = await params
    const projectId = requireUuid(rawProjectId, 'project id')
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from(T.projects)
      .select('*')
      .eq('id', projectId)
      .single()

    if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[Project GET] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId: rawProjectId } = await params
    const projectId = requireUuid(rawProjectId, 'project id')
    const supabase = createServiceClient()
    const parsed = await parseRequestBody(request)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    if (typeof body.name === 'string' && body.name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    if (typeof body.description === 'string' && body.description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` }, { status: 400 })
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.description !== undefined) updates.description = body.description
    if (body.global_style_settings !== undefined) updates.global_style_settings = body.global_style_settings

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(T.projects)
      .update(updates)
      .eq('id', projectId)
      .select()
      .single()

    if (error) { logger.error('[Project PATCH]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    logger.error('[Project PATCH] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId: rawProjectId } = await params
    const projectId = requireUuid(rawProjectId, 'project id')
    const supabase = createServiceClient()

    const { error } = await supabase
      .from(T.projects)
      .delete()
      .eq('id', projectId)

    if (error) { logger.error('[Project DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[Project DELETE] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
