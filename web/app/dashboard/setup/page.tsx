import { listActiveProviders } from '@/lib/providers/registry'
import { SetupWizard } from './SetupWizard'

export const dynamic = 'force-dynamic'

export default async function SetupPage() {
  const providers = await listActiveProviders()

  return <SetupWizard hasProviders={providers.length > 0} />
}
