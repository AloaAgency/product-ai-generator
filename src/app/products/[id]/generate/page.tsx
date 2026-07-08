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
  const { data, error } = await supabase
    .from(T.products)
    .select('project_id')
    .eq('id', id)
    .maybeSingle()

  // A lookup failure is not "product not found" - redirecting to '/' here
  // makes transient DB errors look like the product vanished.
  if (error) {
    throw new Error(`Failed to resolve product for redirect: ${error.message}`)
  }

  if (data?.project_id) {
    redirect(`/projects/${data.project_id}/products/${id}/generate`)
  }
  redirect('/')
}
