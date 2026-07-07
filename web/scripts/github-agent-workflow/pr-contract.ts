import { runMain } from './cli/entrypoint'
import { PR_CONTRACT_PLACEHOLDER, failWithArchitecturePointer } from './core/workflow-architecture'

// Placeholder CLI. #145 owns PR contract checking: it should use the shared PR
// contract section constants and source-issue/acceptance-criteria parsers to
// report each criterion as claimed/missing/needs-review. It must not block
// merges by default.
export function main(): void {
  failWithArchitecturePointer(PR_CONTRACT_PLACEHOLDER)
}

runMain(import.meta.url, () => main())
