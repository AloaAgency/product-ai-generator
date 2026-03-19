import { createServiceClient } from '@/lib/supabase/server'

export async function logError(params: {
  projectId?: string
  productId?: string
  errorMessage: string
  errorSource: string
  errorContext?: Record<string, unknown>
}) {
  try {
    const supabase = createServiceClient()
    await supabase.from('prodai_error_logs').insert({
      project_id: params.projectId ?? null,
      product_id: params.productId ?? null,
      error_message: params.errorMessage,
      error_source: params.errorSource,
      error_context: params.errorContext ?? null,
    })
  } catch (e) {
    console.error('[logError] Failed to write error log:', e)
  }
}
