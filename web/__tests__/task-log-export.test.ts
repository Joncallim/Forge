import { describe, expect, it } from 'vitest'
import { formatTaskLogsJsonl, formatTaskLogsMarkdown, taskLogExportFilename } from '@/lib/task-log-export'
import type { TaskLog } from '@/db/schema'

const baseLog: TaskLog = {
  id: 'log-1',
  sequence: 1,
  taskId: 'task-1',
  taskAttemptId: null,
  agentRunId: 'run-1',
  workPackageId: null,
  artifactId: null,
  approvalGateId: null,
  level: 'warning',
  eventType: 'validation.warning',
  source: 'worker',
  title: 'Validation warning',
  message: 'Command emitted token=sk-live-secret',
  frontMatter: {
    connector: 'OpenRouter (openrouter)',
    model: 'openai/gpt-test',
    prompt: 'Use api_key="sk-live-secret" while planning.',
  },
  metadata: {
    command: 'npm test',
    nested: { authorization: 'Bearer ghp_secret12345' },
    stderr: 'command printed the original prompt',
    stdout: 'command printed model output',
  },
  occurredAt: new Date('2026-07-02T01:00:00.000Z'),
  createdAt: new Date('2026-07-02T01:00:00.000Z'),
}

const task = {
  id: 'task-1',
  title: 'Add logs',
  prompt: 'Build logs with password = "secret-value"',
  status: 'completed',
  errorMessage: null,
  createdAt: new Date('2026-07-02T00:00:00.000Z'),
  updatedAt: new Date('2026-07-02T01:00:00.000Z'),
  completedAt: new Date('2026-07-02T01:00:00.000Z'),
}

describe('task log export formatting', () => {
  it('formats markdown with timestamped front matter and redacted prompt text', () => {
    const markdown = formatTaskLogsMarkdown({
      exportedAt: new Date('2026-07-02T02:00:00.000Z'),
      logs: [baseLog],
      task,
    })

    expect(markdown).toContain('schema_version: 1')
    expect(markdown).toContain('exported_at: "2026-07-02T02:00:00.000Z"')
    expect(markdown).toContain('model: "openai/gpt-test"')
    expect(markdown).toContain('connector: "OpenRouter (openrouter)"')
    expect(markdown).not.toContain('password =')
    expect(markdown).not.toContain('Use api_key=')
    expect(markdown).not.toContain('secret-value')
    expect(markdown).not.toContain('sk-live-secret')
    expect(markdown).not.toContain('ghp_secret12345')
    expect(markdown).not.toContain('command printed the original prompt')
    expect(markdown).not.toContain('command printed model output')
  })

  it('formats jsonl with redacted prompt-bearing fields', () => {
    const jsonl = formatTaskLogsJsonl({ logs: [baseLog], task })
    const row = JSON.parse(jsonl) as {
      frontMatter: { prompt: { byteLength: number; sha256: string } }
      message: string
      metadata: {
        nested: { authorization: string }
        stderr: { byteLength: number; sha256: string }
        stdout: { byteLength: number; sha256: string }
      }
    }

    expect(row.frontMatter.prompt.byteLength).toBeGreaterThan(0)
    expect(row.frontMatter.prompt.sha256).toHaveLength(64)
    expect(row.message).toContain('[REDACTED_TOKEN]')
    expect(row.metadata.nested.authorization).toContain('[REDACTED_TOKEN]')
    expect(row.metadata.stderr.sha256).toHaveLength(64)
    expect(row.metadata.stdout.sha256).toHaveLength(64)
    expect(jsonl).not.toContain('command printed')
  })

  it('exports task-level errors as snapshots', () => {
    const markdown = formatTaskLogsMarkdown({
      logs: [],
      task: {
        ...task,
        errorMessage: 'failure included the original prompt and sk-live-secret',
      },
    })

    expect(markdown).toContain('Task error snapshot:')
    expect(markdown).not.toContain('failure included the original prompt')
    expect(markdown).not.toContain('sk-live-secret')
  })

  it('builds timestamped export filenames', () => {
    expect(taskLogExportFilename('task-1', new Date('2026-07-02T02:00:00.000Z')))
      .toBe('forge-task-log-task-1-2026-07-02T02-00-00-000Z.md')
  })
})
