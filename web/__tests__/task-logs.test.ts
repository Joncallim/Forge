import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
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

  it('removes prompt front matter before insert and publishes the created log', async () => {
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
      frontMatter: expect.not.objectContaining({ prompt: expect.anything() }),
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

  it('recursively removes prompt aliases and keeps count metadata for other output', () => {
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
    }) as unknown as {
      mcpExecutionDesign: Record<string, unknown>
      nested: Record<string, unknown>
      feedback: { kind: string; byteCount: number }
      commandResults: Array<{
        stderr: { kind: string; byteCount: number }
        stdout: { kind: string; byteCount: number }
      }>
    }

    expect(sanitized.mcpExecutionDesign).not.toHaveProperty('promptOverlays')
    expect(sanitized.nested).not.toHaveProperty('prompt')
    expect(sanitized.feedback).toEqual({ kind: 'unknown_legacy_digest', byteCount: expect.any(Number) })
    expect(sanitized.commandResults[0].stderr).toEqual({ kind: 'unknown_legacy_digest', byteCount: expect.any(Number) })
    expect(sanitized.commandResults[0].stdout).toEqual({ kind: 'unknown_legacy_digest', byteCount: expect.any(Number) })
    expect(JSON.stringify(sanitized)).not.toContain('sha256')
    expect(JSON.stringify(sanitized)).not.toContain('sk-live-secret')
    expect(JSON.stringify(sanitized)).not.toContain('ghp_secret12345')
    expect(JSON.stringify(sanitized)).not.toContain('original user prompt')
    expect(JSON.stringify(sanitized)).not.toContain('failing test printed')
  })

  it('keeps prompt aliases out of every checked-in task-log front-matter producer', () => {
    const roots = [path.resolve(process.cwd(), 'worker'), path.resolve(process.cwd(), 'app/api')]
    const files: string[] = []
    const visitDirectory = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) visitDirectory(target)
        else if (entry.isFile() && target.endsWith('.ts') && !target.endsWith('/worker/task-logs.ts')) files.push(target)
      }
    }
    roots.forEach(visitDirectory)

    const violations: string[] = []
    const propertyName = (name: ts.PropertyName): string | null => {
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
      return null
    }
    for (const file of files) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const inspectFrontMatter = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'frontMatter') {
          if (!ts.isObjectLiteralExpression(node.initializer)) {
            violations.push(`${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:dynamic-front-matter`)
          } else {
            const inspectKey = (candidate: ts.Node) => {
              if (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) {
                const key = propertyName(candidate.name)
                if (key && (/prompt/i.test(key) || key === 'messages')) {
                  violations.push(`${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(candidate.getStart()).line + 1}:${key}`)
                }
              }
              ts.forEachChild(candidate, inspectKey)
            }
            inspectKey(node.initializer)
          }
        }
        ts.forEachChild(node, inspectFrontMatter)
      }
      inspectFrontMatter(source)
    }

    expect(violations).toEqual([])
  })
})
