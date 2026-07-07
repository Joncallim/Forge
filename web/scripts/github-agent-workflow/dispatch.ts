import { runMain } from './cli/entrypoint'
import { DISPATCH_PLACEHOLDER, failWithArchitecturePointer } from './core/workflow-architecture'

// Placeholder CLI. #144 owns dispatch: it should turn an accepted request into a
// bounded work order using the shared dispatch/branch-name/work-order contracts
// and update the durable run log — without executing Claude Code or Codex.
export function main(): void {
  failWithArchitecturePointer(DISPATCH_PLACEHOLDER)
}

runMain(import.meta.url, () => main())
