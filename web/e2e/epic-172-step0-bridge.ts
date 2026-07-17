import type { TestInfo } from '@playwright/test'

export const EPIC_172_STEP0_E2E_BRIDGE_ENV = 'FORGE_EPIC_172_STEP0_E2E_BRIDGE'
export const EPIC_172_DISABLED_INGRESS_TAG = '@epic172-disabled-ingress'

export type Epic172Step0E2EClassification =
  | 'run-disabled-safe'
  | 'must-run-disabled-ingress'
  | 'signed-activation-required'

export type Epic172Step0E2EEntry = {
  id: `${string}.spec.ts::${string}`
  classification: Epic172Step0E2EClassification
}

// This is a reviewed inventory, not a filename or title filter. Every Playwright
// test must appear exactly once. The source sentinel fails when a test is added,
// renamed, removed, or reclassified without updating this list.
export const EPIC_172_STEP0_E2E_INVENTORY = [
  {
    id: 'brand-lifecycle.spec.ts::renders setup motion once and keeps app-shell status branding accessible',
    classification: 'run-disabled-safe',
  },
  {
    id: 'brand-lifecycle.spec.ts::uses the immediate static mark for reduced motion',
    classification: 'run-disabled-safe',
  },
  {
    id: 'brand-lifecycle.spec.ts::completes setup motion when session storage is blocked',
    classification: 'run-disabled-safe',
  },
  {
    id: 'brand-lifecycle.spec.ts::uses one accessible auth heading without repeating FORGE',
    classification: 'run-disabled-safe',
  },
  {
    id: 'helper-stage.spec.ts::setup, task execution, artifact review, and approval handoff',
    classification: 'signed-activation-required',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::mcp-admission.real-approval-route: concurrent reapproval has one CAS winner and immutable history',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::mcp-admission.grant-reconciliation: operator hold preserves a running task until lease and review barriers clear',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::expired execution leases allow convergence while malformed leases fail closed',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::simultaneous disjoint task always-allow decisions serialize and preserve their capability union',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::task and project always-allow mutations converge through the same immutable project authority',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::a newer covering project decision recovers a consumed package-local approval',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::config-only legacy project grants fail closed without an immutable current decision',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::narrowing and removal append retained decisions and negatively reconcile future authority',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::project pointer retains an exact S4 parent, rejects mismatches, and rolls back a stale CAS append',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::root repoint keeps the retained project decision and pointer unchanged while revoking issuance',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::root repoint retains decision authority and requires explicit approval after every binding change',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::the database enforces the same exhaustive strict S3 marker fixtures as TypeScript',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::the complete sibling lock waits on the lower ID before reaching the target',
    classification: 'run-disabled-safe',
  },
  {
    id: 'filesystem-grant-lifecycle-concurrency.spec.ts::S3: mutation vs claim contention from lower sibling',
    classification: 'run-disabled-safe',
  },
  {
    id: 'mcp-handoff-concurrency.spec.ts::A: a grant arriving after health capture wins and unrelated metadata survives',
    classification: 'run-disabled-safe',
  },
  {
    id: 'mcp-handoff-concurrency.spec.ts::B: a denial after health capture creates an operator hold without a run',
    classification: 'run-disabled-safe',
  },
  {
    id: 'mcp-handoff-concurrency.spec.ts::B2: a canonical project revocation before claim wins with zero runs',
    classification: 'run-disabled-safe',
  },
  {
    id: 'mcp-handoff-concurrency.spec.ts::F: mixed task grants and handoff recovery share project-to-package lock order without deadlock',
    classification: 'must-run-disabled-ingress',
  },
  {
    id: 'mcp-handoff-concurrency.spec.ts::C-D: broker blocks patch owned metadata and policy mutation is reevaluated',
    classification: 'run-disabled-safe',
  },
  {
    id: 'mcp-handoff-concurrency.spec.ts::E: compare-and-set retries once successfully and repeated conflicts fail closed',
    classification: 'run-disabled-safe',
  },
  {
    id: 'mcp-handoff-concurrency.spec.ts::post-claim context failure removes only the owned lease from current metadata',
    classification: 'run-disabled-safe',
  },
  {
    id: 'mcp-plan-review-concurrency.spec.ts::serializes concurrent review saves to one contiguous history revision',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-plan-review-concurrency.spec.ts::review and approval cannot produce a stale approval or an unprojected approved package',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-plan-review-concurrency.spec.ts::rejects an old review after a locked plan replacement commits',
    classification: 'signed-activation-required',
  },
  {
    id: 'orchestrator-stage.spec.ts::setup, task execution, artifact review, and approval handoff',
    classification: 'signed-activation-required',
  },
  {
    id: 'project-task-composer.spec.ts::minimizes draft on outside interaction, restores it, and submits with Control+Enter',
    classification: 'signed-activation-required',
  },
  {
    id: 'task-detail-controls.spec.ts::stops an active task while retaining its execution history',
    classification: 'signed-activation-required',
  },
  {
    id: 'task-detail-controls.spec.ts::shows retry submitted feedback while collapsing the retry form',
    classification: 'signed-activation-required',
  },
  {
    id: 'task-detail-controls.spec.ts::warns before saving project-wide filesystem approval',
    classification: 'run-disabled-safe',
  },
  {
    id: 'task-detail-controls.spec.ts::loads the package pointer and carries D1 into an explicit D2 reapproval',
    classification: 'signed-activation-required',
  },
  {
    id: 'task-detail-controls.spec.ts::refreshes a stale pointer and waits for a second explicit confirmation',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-host-boundary.spec.ts::epic-172.cgroup-descendant-containment',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-host-boundary.spec.ts::epic-172.failure-injection-quiescence',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-host-boundary.spec.ts::epic-172.peer-credential-boundary',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-host-boundary.spec.ts::epic-172.protected-fence-service',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-host-boundary.spec.ts::epic-172.supported-host-preflight',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-host-boundary.spec.ts::epic-172.teardown-zero-residue',
    classification: 'signed-activation-required',
  },
  {
    id: 'mcp-host-boundary.spec.ts::epic-172.uid-credential-isolation',
    classification: 'signed-activation-required',
  },
] as const satisfies readonly Epic172Step0E2EEntry[]

const inventoryById = new Map<string, Epic172Step0E2EEntry>(
  EPIC_172_STEP0_E2E_INVENTORY.map((entry) => [entry.id, entry]),
)

export type Epic172Step0E2EDisposition =
  | 'full-suite'
  | 'run-while-disabled'
  | 'skip-until-signed-activation'

export function resolveEpic172Step0E2EDisposition(input: {
  bridgeValue: string | undefined
  specFile: string
  testTitle: string
}): Epic172Step0E2EDisposition {
  if (input.bridgeValue === undefined) return 'full-suite'
  if (input.bridgeValue !== '1') {
    throw new Error(`${EPIC_172_STEP0_E2E_BRIDGE_ENV} must be exactly 1 when set.`)
  }

  const id = `${input.specFile}::${input.testTitle}`
  const entry = inventoryById.get(id)
  if (!entry) {
    throw new Error(`Epic 172 Step 0 E2E inventory is missing ${id}.`)
  }
  return entry.classification === 'signed-activation-required'
    ? 'skip-until-signed-activation'
    : 'run-while-disabled'
}

export function applyEpic172Step0E2EBridge(testInfo: TestInfo, specFile: string): void {
  const disposition = resolveEpic172Step0E2EDisposition({
    bridgeValue: testInfo.config.metadata[EPIC_172_STEP0_E2E_BRIDGE_ENV] as string | undefined,
    specFile,
    testTitle: testInfo.title,
  })
  if (disposition === 'skip-until-signed-activation') {
    testInfo.skip(
      true,
      'Step 0 keeps project-management ingress disabled until later signed release evidence activates it.',
    )
  }
}
