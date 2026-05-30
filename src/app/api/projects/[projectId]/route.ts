import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { requireUuid } from '@/lib/request-guards'

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
    console.error('[Project GET] Unexpected error:', err)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {}
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.description !== undefined) updates.description = body.description
    if (body.global_style_settings !== undefined) updates.global_style_settings = body.global_style_settings

    const { data, error } = await supabase
      .from(T.projects)
      .update(updates)
      .eq('id', projectId)
      .select()
      .single()

    if (error) { console.error('[Project PATCH]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[Project PATCH] Unexpected error:', err)
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

    if (error) { console.error('[Project DELETE]', error); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[Project DELETE] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
