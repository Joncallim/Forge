// Shared map of which Epic #141 issue owns each GitHub-native workflow
// behaviour. Keeping the ownership here makes dispatch.ts / pr-contract.ts /
// handoff.ts and the architecture docs point at the same shared contracts.

export const ARCHITECTURE_DOC_PATH = 'docs/github-native-agent-workflow-architecture.md'

export type WorkflowFeatureOwnership = Readonly<{
  issue: number
  behaviour: string
  // Shared modules this feature must build on instead of inventing its own.
  sharedContracts: readonly string[]
}>

export const DISPATCH_FEATURE_OWNERSHIP: WorkflowFeatureOwnership = Object.freeze({
  issue: 144,
  behaviour: 'safe agent dispatch — turn an accepted request into a bounded work order',
  sharedContracts: Object.freeze([
    'contracts/dispatch-request.ts (dispatchRequestSchema)',
    'core/branch-names.ts (buildAgentBranchName)',
    'core/work-order.ts (buildWorkOrder / WORK_ORDER_SECTION_TITLES)',
    'core/acceptance-criteria.ts (extractAcceptanceCriteria)',
    'io/agent-run-log.ts (findLatestRunForIssue / updateRunStatus / recordBlockedReason / appendRunEvent)',
    'io/agent-run-log.ts (withRunLogBranchWorktree / persistRunRecordToGit for run-log branch sync)',
    'contracts/common.ts (DISPATCH_STATE_TO_RUN_STATUS — map accepted → handed-off)',
  ]),
})

export const PR_CONTRACT_FEATURE_OWNERSHIP: WorkflowFeatureOwnership = Object.freeze({
  issue: 145,
  behaviour: 'PR acceptance-criteria contract checker — report each criterion, do not block merges',
  sharedContracts: Object.freeze([
    'core/pr-contract.ts (extractSourceIssueReference / PR_CONTRACT_SECTION_TITLES)',
    'core/acceptance-criteria.ts (extractAcceptanceCriteria)',
    'contracts/pr-contract-report.ts (prContractReportSchema)',
    'contracts/common.ts (prCriterionStatusSchema)',
  ]),
})

export const HANDOFF_FEATURE_OWNERSHIP: WorkflowFeatureOwnership = Object.freeze({
  issue: 153,
  behaviour: 'controlled Claude Code / Codex handoff adapter — generate artifacts, never auto-execute',
  sharedContracts: Object.freeze([
    'contracts/runtime-handoff.ts (runtimeHandoffSchema)',
    'core/handoff.ts (buildHandoffArtifacts)',
    'core/work-order.ts (buildWorkOrder / renderWorkOrder)',
    'io/agent-run-log.ts (updateRunStatus → handed-off, records handoffArtifacts paths)',
  ]),
})

export function architectureOwnershipMessage(ownership: WorkflowFeatureOwnership): string {
  return [
    `Issue #${ownership.issue} owns this behaviour: ${ownership.behaviour}.`,
    '',
    'The implementation uses these shared workflow contracts:',
    ...ownership.sharedContracts.map((entry) => `  - ${entry}`),
    '',
    `Architecture map: ${ARCHITECTURE_DOC_PATH}`,
  ].join('\n')
}
