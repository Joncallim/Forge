import { createHmac, timingSafeEqual } from 'node:crypto'

export const ARCHITECT_PLAN_HEADER = 'Architect plan available in protected history'
export const ARCHITECT_PLAN_ENTRY_DOMAIN_V1 = Buffer.from('forge:architect-plan-entry:v1\0', 'utf8')
export const ARCHITECT_PLAN_SET_DOMAIN_V1 = Buffer.from('forge:architect-plan-entry-set:v1\0', 'utf8')
export const MAX_ARCHITECT_PLAN_ENTRIES = 256
export const MAX_ARCHITECT_PLAN_ENTRY_BYTES = 64 * 1024

export type ArchitectPlanEntryKind =
  | 'plan_body'
  | 'requirement'
  | 'overlay'
  | 'subtask'
  | 'legacy_full_plan'

export type ArchitectPlanEntryInput = {
  agent: string | null
  bindingFingerprint: string | null
  content: string
  entryId: string
  entryKind: ArchitectPlanEntryKind
  projectionEligible: boolean
  requirementKey: string | null
}

export type ArchitectPlanEntryEnvelope = ArchitectPlanEntryInput & {
  contentDigest: string
  digestKeyId: string
  planArtifactId: string
  planVersion: string
  schemaVersion: 1
  taskId: string
}

export type ArchitectPlanEntryReference = {
  bindingFingerprint: string | null
  contentDigest: string
  digestKeyId: string
  entryId: string
  planArtifactId: string
  planVersion: string
  requirementKey: string | null
  schemaVersion: 1
}

const ENTRY_ID = /^[a-z0-9._:-]{1,256}$/
const COMPONENT = /^[a-z0-9._-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DIGEST = /^hmac-sha256:[0-9a-f]{64}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortedCanonicalValue(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC')
  if (Array.isArray(value)) return value.map(sortedCanonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key.normalize('NFC'), sortedCanonicalValue(value[key])]),
  )
}

/**
 * The plan envelope is deliberately closed and contains no JavaScript number
 * values. JSON.stringify is deterministic after recursive key sorting for this
 * closed data shape and produces the exact UTF-8 bytes used by the HMAC.
 */
export function canonicalArchitectPlanJson(value: unknown): string {
  return JSON.stringify(sortedCanonicalValue(value))
}

export function canonicalPlanVersion(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null
  try {
    const parsed = BigInt(value)
    if (parsed > BigInt('9223372036854775807')) return null
  } catch {
    return null
  }
  return value
}

function canonicalOptionalComponent(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const canonical = value.normalize('NFC')
  return COMPONENT.test(canonical) ? canonical : undefined
}

function validateEntryIdentity(input: ArchitectPlanEntryInput): void {
  if (!ENTRY_ID.test(input.entryId)) throw new Error('Architect plan entry ID is invalid')
  const agent = canonicalOptionalComponent(input.agent)
  const requirementKey = canonicalOptionalComponent(input.requirementKey)
  if (agent === undefined || requirementKey === undefined) {
    throw new Error('Architect plan entry agent or requirement key is invalid')
  }
  if (input.bindingFingerprint !== null && !FINGERPRINT.test(input.bindingFingerprint)) {
    throw new Error('Architect plan entry binding fingerprint is invalid')
  }
  const contentBytes = Buffer.byteLength(input.content.normalize('NFC'), 'utf8')
  if (contentBytes === 0 || contentBytes > MAX_ARCHITECT_PLAN_ENTRY_BYTES) {
    throw new Error('Architect plan entry content is outside the bounded size')
  }

  if (input.entryKind === 'plan_body' && input.entryId !== 'plan_body:000000') {
    throw new Error('Architect plan body must use its canonical entry ID')
  }
  if (input.entryKind === 'requirement' && input.entryId !== `requirement:${requirementKey}`) {
    throw new Error('Architect requirement entry ID does not match its requirement key')
  }
  if (input.entryKind === 'overlay' && input.entryId !== `overlay:${requirementKey}:${agent}`) {
    throw new Error('Architect overlay entry ID does not match its binding')
  }
  if (input.entryKind === 'subtask' && !input.entryId.endsWith(`:${agent}`)) {
    throw new Error('Architect subtask entry ID does not match its agent')
  }
  if (input.entryKind === 'legacy_full_plan') {
    if (!/^legacy_full_plan:[0-9]{6}$/.test(input.entryId) || input.projectionEligible) {
      throw new Error('Legacy full-plan entries are retained history and never executable')
    }
  }
}

function entryDigestPayload(input: {
  entry: ArchitectPlanEntryInput
  planArtifactId: string
  planVersion: string
  taskId: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    planArtifactId: input.planArtifactId,
    planVersion: input.planVersion,
    entryId: input.entry.entryId,
    entryKind: input.entry.entryKind,
    agent: input.entry.agent,
    requirementKey: input.entry.requirementKey,
    bindingFingerprint: input.entry.bindingFingerprint,
    content: input.entry.content.normalize('NFC'),
  }
}

function hmacDigest(domain: Buffer, key: Buffer, value: unknown): string {
  if (key.byteLength < 32) throw new Error('Architect plan HMAC key must be at least 32 bytes')
  return `hmac-sha256:${createHmac('sha256', key).update(domain).update(canonicalArchitectPlanJson(value), 'utf8').digest('hex')}`
}

export function materializeArchitectPlanEntries(input: {
  digestKey: Buffer
  digestKeyId: string
  entries: readonly ArchitectPlanEntryInput[]
  planArtifactId: string
  planVersion: string
  taskId: string
}): { entries: ArchitectPlanEntryEnvelope[]; entrySetDigest: string } {
  if (!UUID.test(input.taskId) || !UUID.test(input.planArtifactId)) {
    throw new Error('Architect plan task and artifact IDs must be canonical UUIDs')
  }
  const planVersion = canonicalPlanVersion(input.planVersion)
  if (!planVersion) throw new Error('Architect plan version is invalid')
  if (!COMPONENT.test(input.digestKeyId) || input.entries.length === 0 || input.entries.length > MAX_ARCHITECT_PLAN_ENTRIES) {
    throw new Error('Architect plan key or entry count is invalid')
  }

  const ids = new Set<string>()
  const entries = input.entries.map((rawEntry) => {
    const entry: ArchitectPlanEntryInput = {
      ...rawEntry,
      agent: rawEntry.agent?.normalize('NFC') ?? null,
      content: rawEntry.content.normalize('NFC'),
      entryId: rawEntry.entryId.normalize('NFC'),
      requirementKey: rawEntry.requirementKey?.normalize('NFC') ?? null,
    }
    validateEntryIdentity(entry)
    if (ids.has(entry.entryId)) throw new Error('Architect plan entry IDs must be unique inside a version')
    ids.add(entry.entryId)
    return {
      schemaVersion: 1 as const,
      taskId: input.taskId,
      planArtifactId: input.planArtifactId,
      planVersion,
      ...entry,
      digestKeyId: input.digestKeyId,
      contentDigest: hmacDigest(
        ARCHITECT_PLAN_ENTRY_DOMAIN_V1,
        input.digestKey,
        entryDigestPayload({ entry, planArtifactId: input.planArtifactId, planVersion, taskId: input.taskId }),
      ),
    }
  })

  entries.sort((left, right) => left.entryId.localeCompare(right.entryId, 'en'))
  const entrySetDigest = hmacDigest(
    ARCHITECT_PLAN_SET_DOMAIN_V1,
    input.digestKey,
    entries.map(({ entryId, contentDigest }) => ({ entryId, contentDigest })),
  )
  return { entries, entrySetDigest }
}

export function verifyArchitectPlanEntry(input: {
  digestKey: Buffer
  entry: ArchitectPlanEntryEnvelope
}): boolean {
  try {
    validateEntryIdentity(input.entry)
    if (!DIGEST.test(input.entry.contentDigest)) return false
    const expected = hmacDigest(
      ARCHITECT_PLAN_ENTRY_DOMAIN_V1,
      input.digestKey,
      entryDigestPayload({
        entry: input.entry,
        planArtifactId: input.entry.planArtifactId,
        planVersion: input.entry.planVersion,
        taskId: input.entry.taskId,
      }),
    )
    return timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(input.entry.contentDigest, 'ascii'))
  } catch {
    return false
  }
}

export function architectPlanEntryReference(entry: ArchitectPlanEntryEnvelope): ArchitectPlanEntryReference {
  if (!entry.projectionEligible) throw new Error('Ineligible Architect history cannot become an executable reference')
  return {
    schemaVersion: 1,
    planArtifactId: entry.planArtifactId,
    planVersion: entry.planVersion,
    entryId: entry.entryId,
    digestKeyId: entry.digestKeyId,
    contentDigest: entry.contentDigest,
    requirementKey: entry.requirementKey,
    bindingFingerprint: entry.bindingFingerprint,
  }
}

export function parseArchitectPlanEntryReference(value: unknown): ArchitectPlanEntryReference | null {
  if (!isRecord(value)) return null
  const keys = new Set([
    'schemaVersion', 'planArtifactId', 'planVersion', 'entryId', 'digestKeyId',
    'contentDigest', 'requirementKey', 'bindingFingerprint',
  ])
  if (Object.keys(value).some((key) => !keys.has(key))) return null
  const requirementKey = canonicalOptionalComponent(value.requirementKey)
  if (
    value.schemaVersion !== 1 ||
    typeof value.planArtifactId !== 'string' || !UUID.test(value.planArtifactId) ||
    !canonicalPlanVersion(value.planVersion) ||
    typeof value.entryId !== 'string' || !ENTRY_ID.test(value.entryId) ||
    typeof value.digestKeyId !== 'string' || !COMPONENT.test(value.digestKeyId) ||
    typeof value.contentDigest !== 'string' || !DIGEST.test(value.contentDigest) ||
    requirementKey === undefined ||
    (value.bindingFingerprint !== null && (typeof value.bindingFingerprint !== 'string' || !FINGERPRINT.test(value.bindingFingerprint)))
  ) return null
  return {
    schemaVersion: 1,
    planArtifactId: value.planArtifactId,
    planVersion: value.planVersion as string,
    entryId: value.entryId,
    digestKeyId: value.digestKeyId,
    contentDigest: value.contentDigest,
    requirementKey,
    bindingFingerprint: value.bindingFingerprint as string | null,
  }
}
