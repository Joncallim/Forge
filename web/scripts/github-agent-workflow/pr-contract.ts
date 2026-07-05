import { runMain } from './cli/entrypoint'
import { failUntilIssueLands } from './foundation-only'

export async function main(): Promise<void> {
  await failUntilIssueLands(145, 'PR contract checking behavior')
}

runMain(import.meta.url, () => main())
