import { runMain } from './cli/entrypoint'
import { failUntilIssueLands } from './foundation-only'

export async function main(): Promise<void> {
  await failUntilIssueLands(142, 'Local issue validation behavior')
}

runMain(import.meta.url, () => main())
