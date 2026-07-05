import { runMain } from './cli/entrypoint'
import { failUntilIssueLands } from './foundation-only'

export async function main(): Promise<void> {
  await failUntilIssueLands(153, 'Runtime handoff behavior')
}

runMain(import.meta.url, () => main())
