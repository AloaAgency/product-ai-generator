import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

async function resolveProject(supabase: ReturnType<typeof createServiceClient>, projectId: string) {
  const { data } = await supabase
    .from(T.projects)
    .select('id')
    .eq('id', projectId)
    .single()
  return data
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 })
  }

  try {
    const supabase = createServiceClient()

    // Verify the project exists before returning its logs
    const project = await resolveProject(supabase, projectId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const { data, error } = await supabase
      .from('prodai_error_logs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw error
    return NextResponse.json(data)
  } catch (err) {
    console.error('[ErrorLogs GET] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 })
  }

  try {
    const supabase = createServiceClient()

    // Verify the project exists before allowing log deletion
    const project = await resolveProject(supabase, projectId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const { error } = await supabase
      .from('prodai_error_logs')
      .delete()
      .eq('project_id', projectId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[ErrorLogs DELETE] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
