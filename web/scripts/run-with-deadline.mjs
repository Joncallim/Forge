#!/usr/bin/env node

import { spawn } from 'node:child_process'
import process from 'node:process'

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  if (separator !== 1) throw new Error('Usage: run-with-deadline.mjs <seconds> -- <command> [args...]')
  const seconds = Number(argv[0])
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 3_600) {
    throw new Error('Deadline must be a positive whole number of seconds, at most 3600.')
  }
  const command = argv[separator + 1]
  const args = argv.slice(separator + 2)
  if (!command) throw new Error('A command is required after --.')
  return { args, command, milliseconds: seconds * 1_000 }
}

function killProcessGroup(child, signal) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const child = spawn(parsed.command, parsed.args, {
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: 'inherit',
  })
  let timedOut = false
  let killEscalation = Promise.resolve()
  const deadline = setTimeout(() => {
    timedOut = true
    killProcessGroup(child, 'SIGTERM')
    // Keep the wrapper alive through forced process-group termination. The
    // direct child may exit on SIGTERM while one of its descendants ignores it.
    killEscalation = new Promise((resolve) => {
      setTimeout(() => {
        killProcessGroup(child, 'SIGKILL')
        resolve()
      }, 2_000)
    })
  }, parsed.milliseconds)
  deadline.unref()

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(deadline)
  if (timedOut) {
    await killEscalation
    process.stderr.write('DEADLINE_EXCEEDED\n')
    process.exitCode = 124
    return
  }
  if (result.signal) {
    process.stderr.write(`PROCESS_TERMINATED signal=${result.signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = result.code ?? 1
}

main().catch((error) => {
  void error
  process.stderr.write('DEADLINE_WRAPPER_FAILED\n')
  process.exitCode = 1
})
