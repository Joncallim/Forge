import { eq, and, desc } from 'drizzle-orm'
import { db } from '@/db'
import {
  filesystemMcpGrantApprovals,
  filesystemMcpCurrentDecisionPointers,
  projectFilesystemCurrentDecisionPointers,
  projectFilesystemGrantDecisions,
  workPackages,
} from '@/db/schema'
import { requiresFilesystemGrantApproval } from './filesystem-grants'
import {
  loadCurrentProjectFilesystemDecision,
} from './filesystem-grant-reconciliation'
import { casPacketReapprovalV2 } from './s4-lease'

export type S3ReapprovalPresence =
  | { kind: 'none' }
  | {
      kind: 'package_level'
      packageId: string
      priorDecisionId: string | null
      priorDecisionRevision: bigint | null
      priorFingerprint: string | null
      newDecisionId: string
      newDecisionRevision: bigint | null
      newFingerprint: string | null
    }
  | {
      kind: 'project_level'
      priorDecisionId: string | null
      priorDecisionRevision: bigint | null
      newDecisionId: string
      newDecisionRevision: bigint
      newFingerprint: string
    }

export async function resolveS3ReapprovalState(input: {
  projectId: string
  taskId: string
}): Promise<readonly S3ReapprovalPresence[]> {
  const packages = await db
    .select({ id: workPackages.id, mcpRequirements: workPackages.mcpRequirements, metadata: workPackages.metadata })
    .from(workPackages)
    .where(eq(workPackages.taskId, input.taskId))
    .orderBy(desc(workPackages.sequence))

  const projectAuthority = await loadCurrentProjectFilesystemDecision(input.projectId)
  const projectPointer = await db
    .select()
    .from(projectFilesystemCurrentDecisionPointers)
    .where(eq(projectFilesystemCurrentDecisionPointers.projectId, input.projectId))
    .limit(1)

  const results: S3ReapprovalPresence[] = []

  for (const pkg of packages) {
    const requires = requiresFilesystemGrantApproval({
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectFilesystemDecision: projectAuthority,
    })

    if (!requires.blocked) continue

    const pointer = await db
      .select({
        currentDecisionId: filesystemMcpCurrentDecisionPointers.currentDecisionId,
        currentDecisionRevision: filesystemMcpCurrentDecisionPointers.currentDecisionRevision,
        currentDecisionFingerprint: filesystemMcpCurrentDecisionPointers.currentDecisionFingerprint,
        pointerFingerprint: filesystemMcpCurrentDecisionPointers.pointerFingerprint,
      })
      .from(filesystemMcpCurrentDecisionPointers)
      .where(eq(filesystemMcpCurrentDecisionPointers.workPackageId, pkg.id))
      .limit(1)

    const latestDecision = await db
      .select({
        id: filesystemMcpGrantApprovals.id,
        grantDecisionRevision: filesystemMcpGrantApprovals.grantDecisionRevision,
        pointerFingerprint: filesystemMcpGrantApprovals.pointerFingerprint,
      })
      .from(filesystemMcpGrantApprovals)
      .where(
        and(
          eq(filesystemMcpGrantApprovals.workPackageId, pkg.id),
          eq(filesystemMcpGrantApprovals.decisionScope, 'package'),
        ),
      )
      .orderBy(desc(filesystemMcpGrantApprovals.createdAt))
      .limit(1)

    if (pointer.length > 0 && latestDecision.length > 0) {
      const ptr = pointer[0]
      const latest = latestDecision[0]
      if (
        ptr.currentDecisionId !== latest.id ||
        ptr.currentDecisionRevision !== latest.grantDecisionRevision ||
        ptr.currentDecisionFingerprint !== latest.pointerFingerprint
      ) {
        results.push({
          kind: 'package_level',
          packageId: pkg.id,
          priorDecisionId: ptr.currentDecisionId,
          priorDecisionRevision: ptr.currentDecisionRevision,
          priorFingerprint: ptr.currentDecisionFingerprint,
          newDecisionId: latest.id,
          newDecisionRevision: latest.grantDecisionRevision,
          newFingerprint: latest.pointerFingerprint,
        })
      }
    }
  }

  if (projectPointer.length > 0 && projectAuthority) {
    const pp = projectPointer[0]
    const latestProjectDecision = await db
      .select({
        id: projectFilesystemGrantDecisions.id,
        grantDecisionRevision: projectFilesystemGrantDecisions.grantDecisionRevision,
        decisionFingerprint: projectFilesystemGrantDecisions.decisionFingerprint,
      })
      .from(projectFilesystemGrantDecisions)
      .where(eq(projectFilesystemGrantDecisions.projectId, input.projectId))
      .orderBy(desc(projectFilesystemGrantDecisions.decisionGeneration))
      .limit(1)

    if (latestProjectDecision.length > 0) {
      const lpd = latestProjectDecision[0]
      if (
        pp.currentDecisionId !== lpd.id ||
        pp.currentDecisionRevision !== lpd.grantDecisionRevision ||
        pp.currentDecisionFingerprint !== lpd.decisionFingerprint
      ) {
        results.push({
          kind: 'project_level',
          priorDecisionId: pp.currentDecisionId,
          priorDecisionRevision: pp.currentDecisionRevision,
          newDecisionId: lpd.id,
          newDecisionRevision: lpd.grantDecisionRevision,
          newFingerprint: lpd.decisionFingerprint,
        })
      }
    }
  }

  return results
}

export async function requiresS3Reapproval(input: {
  projectId: string
  taskId: string
}): Promise<boolean> {
  const state = await resolveS3ReapprovalState(input)
  return state.length > 0
}

/**
 * Completes only the exact packet-recovery marker named by the caller. The SQL
 * routine repeats the project, task, sibling, decision, run, lease, and audit
 * lock order before it compare-and-sets the marker.
 */
export async function resolveS3PacketReapproval(input: {
  taskId: string
  workPackageId: string
  priorRuntimeAuditId: string
  expectedMarkerFingerprint: string
  newDecisionId: string
}): Promise<boolean> {
  return casPacketReapprovalV2(input)
}
