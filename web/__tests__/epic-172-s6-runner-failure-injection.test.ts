import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('Epic 172 S6 runner failure injection', () => {
  it('[scenarioId=epic-172.deadline-process-tree-kill] fails closed when a suite process exceeds its deadline', async () => {
    const wrapper = path.resolve(process.cwd(), 'scripts/run-with-deadline.mjs')
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'forge-s6-deadline-'))
    const descendantPidFile = path.join(temporaryDirectory, 'descendant.pid')
    let descendantPid: number | undefined
    try {
      const parentScript = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
        'writeFileSync(process.argv[1], String(child.pid))',
        'setInterval(() => {}, 1000)',
      ].join(';')
      const result = await execFileAsync(process.execPath, [
        wrapper,
        '1',
        '--',
        process.execPath,
        '-e',
        parentScript,
        descendantPidFile,
      ], { timeout: 6_000 }).then(
        () => ({ code: 0, stderr: '' }),
        (error: unknown) => {
          const failure = error as { code?: number; stderr?: string }
          return { code: failure.code, stderr: failure.stderr ?? '' }
        },
      )

      expect(result).toEqual({ code: 124, stderr: 'DEADLINE_EXCEEDED\n' })
      descendantPid = Number(await readFile(descendantPidFile, 'utf8'))
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true)
      expect(() => process.kill(descendantPid!, 0)).toThrow()
    } finally {
      if (!descendantPid) {
        try { descendantPid = Number(await readFile(descendantPidFile, 'utf8')) } catch { /* process never started */ }
      }
      if (descendantPid) {
        try { process.kill(descendantPid, 'SIGKILL') } catch { /* already terminated */ }
      }
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }, 10_000)
})
