import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { T } from '@/lib/db-tables'

export default async function OldProductSubRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = createServiceClient()
  const { data } = await supabase
    .from(T.products)
    .select('project_id')
    .eq('id', id)
    .single()

  if (data?.project_id) {
    redirect(`/projects/${data.project_id}/products/${id}/references`)
  }
  redirect('/')
}
