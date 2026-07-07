import { runMain } from './cli/entrypoint'
import { HANDOFF_PLACEHOLDER, failWithArchitecturePointer } from './core/workflow-architecture'

// Placeholder CLI. #153 owns the runtime handoff adapter: it should consume the
// #144 work order and produce runtime-specific handoff artifacts through the
// shared handoff contract, updating the run log with handoff state and artifact
// paths. It must not run Claude Code or Codex automatically.
export function main(): void {
  failWithArchitecturePointer(HANDOFF_PLACEHOLDER)
}

runMain(import.meta.url, () => main())
