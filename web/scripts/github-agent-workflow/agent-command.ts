import { runMain } from './cli/entrypoint'
import { failUntilIssueLands } from './foundation-only'

export async function main(): Promise<void> {
  await failUntilIssueLands(143, 'Agent command routing behavior')
}

runMain(import.meta.url, () => main())
