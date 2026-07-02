import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  publishTaskEvent: vi.fn(),
}))

function insertChain(returnValue: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve(returnValue)),
  }
  return chain
}

vi.mock('@/db', () => ({
  db: {
    insert: mocks.dbInsert,
  },
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}))

import { recordTaskLog } from '@/worker/task-logs'
import { sanitizeLogStructuredValue } from '@/lib/task-log-sanitization'

describe('task log writer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sanitizes prompt front matter before insert and publishes the created log', async () => {
    const row = {
      id: 'log-1',
      taskId: 'task-1',
      taskAttemptId: null,
      agentRunId: null,
      workPackageId: null,
      artifactId: null,
      approvalGateId: null,
      sequence: 1,
      level: 'info',
      eventType: 'model.prompt',
      source: 'model',
      title: 'Prompt prepared',
      message: 'Prepared prompt',
      frontMatter: {
        prompt: { byteLength: 28, sha256: '0'.repeat(64), truncated: false },
        timestamp: '2026-07-02T00:00:00.000Z',
      },
      metadata: { nested: { token: '[REDACTED_TOKEN]' } },
      occurredAt: new Date('2026-07-02T00:00:00.000Z'),
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    }
    const chain = insertChain([row])
    mocks.dbInsert.mockReturnValueOnce(chain)

    await recordTaskLog({
      eventType: 'model.prompt',
      frontMatter: { prompt: 'api_key="sk-live-secret"' },
      message: 'Prepared prompt',
      metadata: { nested: { token: 'ghp_secret12345' } },
      source: 'model',
      taskId: 'task-1',
      title: 'Prompt prepared',
    })

    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      frontMatter: expect.objectContaining({
        prompt: expect.objectContaining({
          byteLength: expect.any(Number),
          sha256: expect.any(String),
          truncated: false,
        }),
      }),
      metadata: expect.objectContaining({
        nested: expect.objectContaining({
          token: '[REDACTED_TOKEN]',
        }),
      }),
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:log', expect.objectContaining({
      eventType: 'model.prompt',
      id: 'log-1',
    }))
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'task:log', expect.objectContaining({
      metadata: expect.anything(),
    }))
  })

  it('hashes nested prompt-shaped objects instead of preserving their text', () => {
    const sanitized = sanitizeLogStructuredValue({
      mcpExecutionDesign: {
        promptOverlays: {
          backend: 'Do the thing with api_key="sk-live-secret"',
        },
      },
      nested: {
        prompt: {
          messages: [{ content: 'Bearer ghp_secret12345' }],
        },
      },
      feedback: {
        text: 'Retry with the original user prompt copied here',
      },
      partialOutput: 'The model echoed api_key="sk-live-secret"',
      commandResults: [
        {
          command: ['npm', 'test'],
          exitCode: 1,
          stderr: 'failing test printed the user prompt',
          stdout: 'stdout copied Bearer ghp_secret12345',
        },
      ],
    }) as {
      mcpExecutionDesign: { promptOverlays: { byteLength: number; sha256: string } }
      nested: { prompt: { byteLength: number; sha256: string } }
      feedback: { byteLength: number; sha256: string }
      partialOutput: { byteLength: number; sha256: string }
      commandResults: Array<{
        stderr: { byteLength: number; sha256: string }
        stdout: { byteLength: number; sha256: string }
      }>
    }

    expect(sanitized.mcpExecutionDesign.promptOverlays.sha256).toHaveLength(64)
    expect(sanitized.nested.prompt.sha256).toHaveLength(64)
    expect(sanitized.feedback.sha256).toHaveLength(64)
    expect(sanitized.partialOutput.sha256).toHaveLength(64)
    expect(sanitized.commandResults[0].stderr.sha256).toHaveLength(64)
    expect(sanitized.commandResults[0].stdout.sha256).toHaveLength(64)
    expect(JSON.stringify(sanitized)).not.toContain('sk-live-secret')
    expect(JSON.stringify(sanitized)).not.toContain('ghp_secret12345')
    expect(JSON.stringify(sanitized)).not.toContain('original user prompt')
    expect(JSON.stringify(sanitized)).not.toContain('failing test printed')
  })
})
