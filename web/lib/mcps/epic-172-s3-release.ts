/**
 * Narrow S3-to-Step-0 boundary. Step 0 owns the release-order manifest and the
 * signed evidence/authorization stores; S3 injects those owners and never
 * copies their data, verifier, recorder, or consumer.
 */
export type Epic172ReleaseOrderAdapter = {
  validateEpic172ReleaseOrder: () => void
  getEpic172ReleaseOrderNode: (nodeId: string) => {
    owner: { issue: number; slice: string }
  } | null
  getEpic172ReleaseOrderEdges: (graph: 'codeDependencyGraph' | 'runtimeActivationGraph') => readonly {
    from: string
    to: string
  }[]
}

export type Epic172S3TransitionAdapter = {
  /**
   * Step 0 must implement this as one PostgreSQL transaction: reverify the
   * durable predecessor, consume the exact fresh transition authorization at
   * the final statement, retain predecessor consumption, and append only the
   * signed s3_issue_178 receipt with the S3 final-state marker.
   */
  consumeAuthorizationAndRecordS3: (input: {
    authorizationAttemptId: string
    buildSha: string
    controllerIdentity: string
    operationId: string
    reviewedSha: string
  }) => Promise<{ receiptId: string }>
}

export function createEpic172S3PostgresTransitionAdapter(
  input: Epic172SignedEnvelopeInput & Readonly<{ databaseUrl: string }>,
): Epic172S3TransitionAdapter {
  return {
    consumeAuthorizationAndRecordS3: (transition) => completeEpic172S3ReleaseTransition({
      ...input,
      authorizationId: transition.authorizationAttemptId,
      buildSha: transition.buildSha,
      controllerIdentity: transition.controllerIdentity,
      operationId: transition.operationId,
      reviewedSha: transition.reviewedSha,
    }),
  }
}

export async function completeEpic172S3Release(input: {
  authorizationAttemptId: string
  buildSha: string
  controllerIdentity: string
  operationId: string
  order: Epic172ReleaseOrderAdapter
  reviewedSha: string
  transition: Epic172S3TransitionAdapter
}): Promise<{ receiptId: string }> {
  input.order.validateEpic172ReleaseOrder()
  const node = input.order.getEpic172ReleaseOrderNode('s3_issue_178')
  if (!node || node.owner.issue !== 178 || node.owner.slice !== 's3') {
    throw new Error('Epic 172 manifest does not assign s3_issue_178 to issue 178 / S3.')
  }
  const codeEdges = input.order.getEpic172ReleaseOrderEdges('codeDependencyGraph')
  const runtimeEdges = input.order.getEpic172ReleaseOrderEdges('runtimeActivationGraph')
  if (!codeEdges.some((edge) => edge.to === 's3_issue_178')) {
    throw new Error('Epic 172 code dependency graph does not gate S3.')
  }
  if (!runtimeEdges.some((edge) => (
    edge.from === 'step0_retention_bridge' && edge.to === 's3_issue_178'
  ))) {
    throw new Error('Epic 172 runtime graph does not require the Step 0 predecessor for S3.')
  }
  return input.transition.consumeAuthorizationAndRecordS3({
    authorizationAttemptId: input.authorizationAttemptId,
    buildSha: input.buildSha,
    controllerIdentity: input.controllerIdentity,
    operationId: input.operationId,
    reviewedSha: input.reviewedSha,
  })
}
import {
  completeEpic172S3ReleaseTransition,
  type Epic172SignedEnvelopeInput,
} from './epic-172-release-recorder'
