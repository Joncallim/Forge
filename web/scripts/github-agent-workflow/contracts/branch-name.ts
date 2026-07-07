import { z } from 'zod'
import { freezeSchema } from './common'

// Deterministic agent work branches are `agent/issue-<number>` with an optional
// lowercase, dash-separated slug. The pattern rejects uppercase, spaces, double
// dashes, and other git-ref-unsafe shapes so every remaining feature can rely on
// one branch-name contract (see core/branch-names.ts for the generator).
export const AGENT_BRANCH_NAME_PATTERN = /^agent\/issue-\d+(?:-[a-z0-9]+)*$/

export const agentBranchNameSchema = freezeSchema(
  z.string().regex(
    AGENT_BRANCH_NAME_PATTERN,
    'Agent branch names must match agent/issue-<number> with an optional -slug.',
  ),
)
export type AgentBranchName = z.infer<typeof agentBranchNameSchema>
