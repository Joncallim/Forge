import { redirect } from 'next/navigation'
import { listActiveProviders } from '@/lib/providers/registry'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const providers = await listActiveProviders()
  redirect(providers.length === 0 ? '/dashboard/setup' : '/dashboard/projects')
}
