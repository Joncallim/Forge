import { runMain } from './cli/entrypoint'
import { failUntilIssueLands } from './foundation-only'

export async function main(): Promise<void> {
  await failUntilIssueLands(144, 'Dispatch behavior')
}

runMain(import.meta.url, () => main())
