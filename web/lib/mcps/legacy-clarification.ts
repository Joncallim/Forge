import { decryptSecret, encryptSecret } from '@/lib/crypto'

export const LEGACY_CLARIFICATION_METADATA_KEY = 'legacyClarificationV1'
export const LEGACY_CLARIFICATION_MAX_TEXT_BYTES = 65_536
const LEGACY_CLARIFICATION_MAX_QUESTIONS = 128
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PLAN_VERSION = /^[1-9][0-9]{0,18}$/u

export type LegacyClarificationQuestion = Readonly<{
  id: string
  question: string
  suggestions: string[]
  answer: string | null
}>

export type LegacyClarificationEnvelope = Readonly<{
  schemaVersion: 1
  taskId: string
  agentRunId: string
  planVersion: string
  questions: LegacyClarificationQuestion[]
}>

type LegacyClarificationBinding = Readonly<{
  taskId: string
  agentRunId: string
  planVersion: string
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() !== ''
    && Buffer.byteLength(value, 'utf8') <= LEGACY_CLARIFICATION_MAX_TEXT_BYTES
}

function canonicalQuestion(value: unknown): LegacyClarificationQuestion | null {
  if (!isRecord(value) || !hasExactKeys(value, ['answer', 'id', 'question', 'suggestions'])) return null
  if (typeof value.id !== 'string' || !UUID_V4.test(value.id) || !boundedText(value.question)) return null
  if (!Array.isArray(value.suggestions) || value.suggestions.length > 4) return null
  if (!value.suggestions.every(boundedText)) return null
  if (value.answer !== null && !boundedText(value.answer)) return null
  return {
    id: value.id,
    question: value.question,
    suggestions: [...value.suggestions],
    answer: value.answer,
  }
}

function canonicalEnvelope(value: unknown): LegacyClarificationEnvelope | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['agentRunId', 'planVersion', 'questions', 'schemaVersion', 'taskId'])
    || value.schemaVersion !== 1
    || typeof value.taskId !== 'string'
    || typeof value.agentRunId !== 'string'
    || !UUID_V4.test(value.taskId)
    || !UUID_V4.test(value.agentRunId)
    || typeof value.planVersion !== 'string'
    || !PLAN_VERSION.test(value.planVersion)
    || !Array.isArray(value.questions)
    || value.questions.length === 0
    || value.questions.length > LEGACY_CLARIFICATION_MAX_QUESTIONS) {
    return null
  }
  const questions = value.questions.map(canonicalQuestion)
  if (questions.some((question) => question === null)) return null
  const ids = new Set(questions.map((question) => question!.id))
  if (ids.size !== questions.length) return null
  return {
    schemaVersion: 1,
    taskId: value.taskId,
    agentRunId: value.agentRunId,
    planVersion: value.planVersion,
    questions: questions as LegacyClarificationQuestion[],
  }
}

function matchesBinding(
  envelope: LegacyClarificationEnvelope,
  binding: LegacyClarificationBinding,
): boolean {
  return envelope.taskId === binding.taskId
    && envelope.agentRunId === binding.agentRunId
    && envelope.planVersion === binding.planVersion
}

export function sealLegacyClarification(
  input: LegacyClarificationEnvelope,
): Record<string, unknown> {
  const envelope = canonicalEnvelope(input)
  if (!envelope) throw new Error('Legacy clarification data is invalid.')
  return {
    schemaVersion: 1,
    ciphertext: encryptSecret(JSON.stringify(envelope)),
  }
}

export function readLegacyClarification(
  metadata: unknown,
  binding: LegacyClarificationBinding,
): LegacyClarificationEnvelope | null {
  if (!isRecord(metadata)) return null
  const sealed = metadata[LEGACY_CLARIFICATION_METADATA_KEY]
  if (!isRecord(sealed)
    || !hasExactKeys(sealed, ['ciphertext', 'schemaVersion'])
    || sealed.schemaVersion !== 1
    || typeof sealed.ciphertext !== 'string') {
    return null
  }
  try {
    const envelope = canonicalEnvelope(JSON.parse(decryptSecret(sealed.ciphertext)))
    return envelope && matchesBinding(envelope, binding) ? envelope : null
  } catch {
    return null
  }
}

export function answerLegacyClarification(
  envelope: LegacyClarificationEnvelope,
  answers: readonly Readonly<{ id: string; answer: string }>[],
): LegacyClarificationEnvelope | null {
  if (answers.length === 0) return null
  const answerById = new Map<string, string>()
  for (const item of answers) {
    if (!UUID_V4.test(item.id) || !boundedText(item.answer) || answerById.has(item.id)) return null
    answerById.set(item.id, item.answer)
  }
  const known = new Set(envelope.questions.map((question) => question.id))
  if ([...answerById.keys()].some((id) => !known.has(id))) return null
  return {
    ...envelope,
    questions: envelope.questions.map((question) => {
      const answer = answerById.get(question.id)
      return answer === undefined ? question : { ...question, answer }
    }),
  }
}

export function legacyClarificationAllAnswered(envelope: LegacyClarificationEnvelope): boolean {
  return envelope.questions.length > 0
    && envelope.questions.every((question) => question.answer !== null)
}
