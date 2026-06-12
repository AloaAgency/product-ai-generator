import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'
import { requireUuid, MAX_LIST_ROWS } from '@/lib/request-guards'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logger } from '@/lib/logger'

const COUNT_CONCURRENCY = 5

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const productId = requireUuid(id, 'product id')
    const supabase = createServiceClient()

    const { data: jobs, error: jobsError } = await supabase
      .from(T.generation_jobs)
      .select('id, prompt_template_id')
      .eq('product_id', productId)
      .not('prompt_template_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(MAX_LIST_ROWS)

    if (jobsError) {
      logger.error('[Prompts Usage]', jobsError)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const jobIdsByTemplate = new Map<string, string[]>()
    for (const job of jobs || []) {
      const templateId = job.prompt_template_id as string
      const arr = jobIdsByTemplate.get(templateId)
      if (arr) arr.push(job.id)
      else jobIdsByTemplate.set(templateId, [job.id])
    }

    const entries = await mapWithConcurrency(
      Array.from(jobIdsByTemplate.entries()),
      COUNT_CONCURRENCY,
      async ([templateId, jobIds]) => {
        const { count, error } = await supabase
          .from(T.generated_images)
          .select('id', { count: 'exact', head: true })
          .in('job_id', jobIds)
        if (error) {
          logger.error('[Prompts Usage] count failed:', error.message)
          return [templateId, 0] as const
        }
        return [templateId, count ?? 0] as const
      }
    )

    return NextResponse.json({ counts: Object.fromEntries(entries) })
  } catch (err) {
    logger.error('[Prompts Usage] Unexpected error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
