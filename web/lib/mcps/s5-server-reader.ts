import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  filesystemMcpGrantApprovals,
  filesystemMcpCurrentDecisionPointers,
  projectFilesystemCurrentDecisionPointers,
  workPackages,
  type FilesystemMcpGrantApproval,
} from '@/db/schema'
import { summarizeFilesystemCapabilities } from '@/lib/mcps/filesystem-grants'
import { loadCurrentProjectFilesystemDecision } from '@/lib/mcps/filesystem-grant-reconciliation'
import { parseFilesystemGrantBlockMetadata } from '@/lib/mcps/filesystem-grant-lifecycle'

export type S5AdmissionPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  cacheBypassId: string
  taskId: string
  packages: readonly S5PackagePresenter[]
  projectGrant: S5ProjectGrantPresenter | null
}>

export type S5PackagePresenter = Readonly<{
  workPackageId: string
  title: string
  assignedRole: string
  status: string
  requestedCapabilities: readonly string[]
  boundedRuntimeRequestedCapabilities: readonly string[]
  blockingCapabilities: readonly string[]
  currentDecision: S5DecisionPresenter | null
  blockMetadata: Record<string, unknown> | null
  pointerFingerprint: string | null
  pointerVersion: string | null
}>

export type S5DecisionPresenter = Readonly<{
  id: string
  decision: string
  capabilities: readonly string[]
  reason: string
  grantDecisionRevision: string | null
  rootBindingRevision: string | null
  decidedAt: string
}>

export type S5ProjectGrantPresenter = Readonly<{
  enabled: boolean
  capabilities: readonly string[]
  grantDecisionRevision: string | null
  rootBindingRevision: string | null
  decisionFingerprint: string | null
  decisionGeneration: string | null
  decidedAt: string | null
  decidedBy: string | null
}>

export type S5RecoveryPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  taskId: string
  blockedPackages: readonly S5PackagePresenter[]
  recoveryMarkers: readonly {
    workPackageId: string
    markerKind: string
    markerFingerprint: string
    disposition: string
    reviewState: string
  }[]
}>

export type S5TerminalPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  taskId: string
  terminalPackages: readonly {
    workPackageId: string
    assemblyState: string | null
    deliveryOutcome: string | null
    terminalOutcome: string | null
    terminalAt: string | null
  }[]
}>

export type S5LocalEvidencePresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  taskId: string
  evidenceRecords: readonly {
    claimToken: string
    state: string
    leaseExpiresAt: string | null
    terminalAt: string | null
  }[]
}>

export function computeFreshnessFingerprint(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort())
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export function computeCasRecheckToken(input: {
  fingerprint: string
}): string {
  const nonce = randomUUID()
  const hmac = createHash('sha256')
  hmac.update('forge:s5:cas-recheck:v1\0')
  hmac.update(`${input.fingerprint}\0${nonce}`)
  return `recheck:${nonce}:${hmac.digest('hex').substring(0, 16)}`
}

export function assertCasRecheckValid(input: {
  fingerprint: string
  token: string
  maxAgeSeconds: number
  computedAt: string
}): boolean {
  if (!input.token.startsWith('recheck:')) return false
  const parts = input.token.split(':')
  if (parts.length !== 3) return false
  const computed = computeCasRecheckToken({ fingerprint: input.fingerprint })
  if (computed !== input.token) return false
  const computedMs = new Date(input.computedAt).getTime()
  const ageMs = Date.now() - computedMs
  return ageMs <= input.maxAgeSeconds * 1000
}
