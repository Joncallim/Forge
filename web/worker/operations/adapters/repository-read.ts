import path from 'node:path'

import type { ScopedCommandResult } from '@/worker/repository-evidence'
import type { OperationAdapterExecution } from '../executor'

export type RepositoryReadCommand = (input: {
  cwd: string
  command: 'git'
  argv: string[]
  signal?: AbortSignal
}) => Promise<Pick<ScopedCommandResult, 'exitCode' | 'outputSummary'>>

export type RepositoryReadAdapterResult = {
  output: {
    exitCode: number
    summary: string
  }
  evidenceRefs: string[]
}

function assertTrustedProjectRoot(projectRoot: string): string {
  if (!path.isAbsolute(projectRoot) || projectRoot.includes('\0')) {
    throw new Error('The trusted project root must be an absolute filesystem path.')
  }
  return path.resolve(/* turbopackIgnore: true */ projectRoot)
}

async function runFixedGitRead(input: {
  projectRoot: string
  argv: readonly string[]
  runCommand: RepositoryReadCommand
  execution?: OperationAdapterExecution
}): Promise<RepositoryReadAdapterResult> {
  const result = await input.runCommand({
    cwd: assertTrustedProjectRoot(input.projectRoot),
    command: 'git',
    argv: [...input.argv],
    ...(input.execution ? { signal: input.execution.signal } : {}),
  })
  if (result.exitCode !== 0) throw new Error('The fixed repository read did not complete successfully.')
  return {
    output: { exitCode: result.exitCode, summary: result.outputSummary },
    evidenceRefs: [],
  }
}

export function createRepositoryStatusReadAdapter(input: {
  runCommand: RepositoryReadCommand
}): (context: { projectRoot: string | null }, execution?: OperationAdapterExecution) => Promise<RepositoryReadAdapterResult> {
  return (context, execution) => runFixedGitRead({
    projectRoot: context.projectRoot ?? '',
    argv: ['status', '--short'],
    runCommand: input.runCommand,
    execution,
  })
}

export function createRepositoryDiffSummaryAdapter(input: {
  runCommand: RepositoryReadCommand
}): (context: { projectRoot: string | null }, execution?: OperationAdapterExecution) => Promise<RepositoryReadAdapterResult> {
  return (context, execution) => runFixedGitRead({
    projectRoot: context.projectRoot ?? '',
    argv: ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--'],
    runCommand: input.runCommand,
    execution,
  })
}

export function createRepositoryBranchReadAdapter(input: {
  runCommand: RepositoryReadCommand
}): (context: { projectRoot: string | null }, execution?: OperationAdapterExecution) => Promise<RepositoryReadAdapterResult> {
  return (context, execution) => runFixedGitRead({
    projectRoot: context.projectRoot ?? '',
    argv: ['branch', '--show-current'],
    runCommand: input.runCommand,
    execution,
  })
}
