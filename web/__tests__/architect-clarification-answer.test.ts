import { describe, expect, it } from 'vitest'
import {
  materializeArchitectClarificationAnswer,
  verifyArchitectClarificationAnswer,
} from '@/lib/mcps/architect-plan-entries'

const key = Buffer.alloc(32, 7)
const input = {
  digestKey: key,
  digestKeyId: 'test-key-v1',
  taskId: '00000000-0000-4000-8000-000000000001',
  answerId: '00000000-0000-4000-8000-000000000002',
  questionId: '00000000-0000-4000-8000-000000000003',
  sourcePlanArtifactId: '00000000-0000-4000-8000-000000000004',
  sourcePlanVersion: '1',
  answer: 'Use main.',
}

describe('protected Architect clarification answer envelope', () => {
  it('uses the domain-separated fixed digest vector', () => {
    const result = materializeArchitectClarificationAnswer(input)
    expect(result.contentDigest).toBe('hmac-sha256:e674d44bb686f6d0c99aa39703bc7c31aedc28c2883ac3d2203560e9310182e0')
    expect(verifyArchitectClarificationAnswer({ ...result, digestKey: key })).toBe(true)
  })

  it('rejects changed answer content and cross-source identity', () => {
    const result = materializeArchitectClarificationAnswer(input)
    expect(verifyArchitectClarificationAnswer({ ...result, answer: 'Use release.', digestKey: key })).toBe(false)
    expect(verifyArchitectClarificationAnswer({ ...result, sourcePlanVersion: '2', digestKey: key })).toBe(false)
  })
})
