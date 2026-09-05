import { GITHUB_AGENT_WORKFLOW_LABEL_NAMES, type GitHubAgentWorkflowLabelName } from '../contracts/common'

export type GitHubWorkflowLabelDefinition = Readonly<{
  name: GitHubAgentWorkflowLabelName
  color: string
  description: string
}>

export const GITHUB_AGENT_WORKFLOW_LABELS = Object.freeze<readonly GitHubWorkflowLabelDefinition[]>([
  {
    name: 'needs-triage',
    color: 'bfdadc',
    description: 'Issue exists but still needs a human triage pass before agent work.',
  },
  {
    name: 'ready-for-agent',
    color: '0e8a16',
    description: 'READINESS PROJECTION — Issue is semantically ready for agent dispatch. This label is a cache of the computed readiness state, not an authority. Command, dispatch, and handoff always re-resolve current semantic truth.',
  },
  {
    name: 'needs-clarification',
    color: 'd73a4a',
    description: 'READINESS PROJECTION — Issue is missing required structure or decisions. The issue contract or dependency graph needs author correction.',
  },
  {
    name: 'dependency-blocked',
    color: 'b60205',
    description: 'READINESS PROJECTION — Issue is blocked by unresolved dependencies. This label is a cache, not authority. Command, dispatch, and handoff always re-resolve current semantic truth.',
  },
  {
    name: 'tracking-only',
    color: '5319e7',
    description: 'READINESS PROJECTION — Issue is a tracking/umbrella issue and is not implementation-dispatchable.',
  },
  {
    name: 'agent-requested',
    color: '1d76db',
    description: 'A supported agent command was accepted for this issue.',
  },
  {
    name: 'agent-running',
    color: '1a7f37',
    description: 'A real agent runtime has started work for this issue.',
  },
  {
    name: 'agent-blocked',
    color: 'b60205',
    description: 'The agent workflow could not continue without intervention.',
  },
  {
    name: 'agent-pr-opened',
    color: '5319e7',
    description: 'An agent-created pull request is open for this issue.',
  },
])

export const GITHUB_AGENT_WORKFLOW_LABELS_BY_NAME = Object.freeze(
  Object.fromEntries(GITHUB_AGENT_WORKFLOW_LABELS.map((label) => [label.name, label])),
) as Readonly<Record<GitHubAgentWorkflowLabelName, GitHubWorkflowLabelDefinition>>

function normalizeLabelName(label: string): string {
  return label.trim().toLowerCase()
}

export function diffManagedLabels(
  currentLabels: Iterable<string>,
  desiredLabels: Iterable<GitHubAgentWorkflowLabelName>,
  managedLabels: readonly GitHubAgentWorkflowLabelName[] = GITHUB_AGENT_WORKFLOW_LABEL_NAMES,
): Readonly<{ toAdd: GitHubAgentWorkflowLabelName[]; toRemove: GitHubAgentWorkflowLabelName[] }> {
  const current = new Set(Array.from(currentLabels, normalizeLabelName))
  const desired = new Set(Array.from(desiredLabels, normalizeLabelName))
  const managed = new Set(Array.from(managedLabels, normalizeLabelName))

  const toAdd = managedLabels.filter((label) => desired.has(label) && !current.has(label))
  const toRemove = managedLabels.filter((label) => managed.has(label) && current.has(label) && !desired.has(label))

  return Object.freeze({ toAdd, toRemove })
}
