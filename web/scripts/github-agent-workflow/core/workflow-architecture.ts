// Shared map of which remaining Epic #141 issue owns which GitHub-native workflow
// behaviour, plus the fail-closed placeholder message the not-yet-implemented
// CLIs print. Encoding the ownership here (rather than as free text in each
// placeholder) keeps dispatch.ts / pr-contract.ts / handoff.ts pointing at the
// same shared contracts and the same architecture doc.

export const ARCHITECTURE_DOC_PATH = 'docs/github-native-agent-workflow-architecture.md'

export type WorkflowPlaceholder = Readonly<{
  issue: number
  behaviour: string
  // Shared modules this feature must build on instead of inventing its own.
  sharedContracts: readonly string[]
}>

export const DISPATCH_PLACEHOLDER: WorkflowPlaceholder = Object.freeze({
  issue: 144,
  behaviour: 'safe agent dispatch — turn an accepted request into a bounded work order',
  sharedContracts: Object.freeze([
    'contracts/dispatch-request.ts (dispatchRequestSchema)',
    'core/branch-names.ts (buildAgentBranchName)',
    'core/work-order.ts (buildWorkOrder / WORK_ORDER_SECTION_TITLES)',
    'core/acceptance-criteria.ts (extractAcceptanceCriteria)',
    'io/agent-run-log.ts (recordRequested / updateRunStatus / recordBlockedReason)',
    'contracts/common.ts (DISPATCH_STATE_TO_RUN_STATUS — map accepted → handed-off)',
  ]),
})

export const PR_CONTRACT_PLACEHOLDER: WorkflowPlaceholder = Object.freeze({
  issue: 145,
  behaviour: 'PR acceptance-criteria contract checker — report each criterion, do not block merges',
  sharedContracts: Object.freeze([
    'core/pr-contract.ts (extractSourceIssueReference / PR_CONTRACT_SECTION_TITLES)',
    'core/acceptance-criteria.ts (extractAcceptanceCriteria)',
    'contracts/pr-contract-report.ts (prContractReportSchema)',
    'contracts/common.ts (prCriterionStatusSchema)',
  ]),
})

export const HANDOFF_PLACEHOLDER: WorkflowPlaceholder = Object.freeze({
  issue: 153,
  behaviour: 'controlled Claude Code / Codex handoff adapter — generate artifacts, never auto-execute',
  sharedContracts: Object.freeze([
    'contracts/runtime-handoff.ts (runtimeHandoffSchema)',
    'core/handoff.ts (buildHandoffArtifacts)',
    'core/work-order.ts (buildWorkOrder / renderWorkOrder)',
    'io/agent-run-log.ts (updateRunStatus → handed-off, records handoffArtifacts paths)',
  ]),
})

export function architecturePlaceholderMessage(placeholder: WorkflowPlaceholder): string {
  return [
    `Not implemented yet. Issue #${placeholder.issue} owns this behaviour: ${placeholder.behaviour}.`,
    '',
    'Build it on the shared workflow contracts instead of inventing new ones:',
    ...placeholder.sharedContracts.map((entry) => `  - ${entry}`),
    '',
    `Architecture map: ${ARCHITECTURE_DOC_PATH}`,
  ].join('\n')
}

// Fail closed. The GitHub-native workflow must not look like a feature ran when
// it has not, so the placeholder CLIs throw with a contract-aware pointer.
export function failWithArchitecturePointer(placeholder: WorkflowPlaceholder): never {
  throw new Error(architecturePlaceholderMessage(placeholder))
}
