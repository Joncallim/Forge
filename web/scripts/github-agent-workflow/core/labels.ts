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
    description: 'Issue has enough structure for deterministic agent handling.',
  },
  {
    name: 'needs-clarification',
    color: 'd73a4a',
    description: 'Issue is missing required structure or decisions.',
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
