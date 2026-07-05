import { spawn } from 'node:child_process'
import { GITHUB_REPO_PATTERN } from '../contracts/common'
import { GITHUB_AGENT_WORKFLOW_LABELS } from '../core/labels'
import { runMain } from './entrypoint'

type BootstrapOptions = {
  repo: string
  env: NodeJS.ProcessEnv
}

function resolveRepo(argv: string[], env: NodeJS.ProcessEnv): string {
  const repoArgIndex = argv.findIndex((value) => value === '--repo')
  const repo = repoArgIndex >= 0 ? argv[repoArgIndex + 1] : env.GITHUB_REPOSITORY
  const trimmed = repo?.trim() ?? ''
  if (!GITHUB_REPO_PATTERN.test(trimmed)) {
    throw new Error('A valid owner/repo value is required via --repo or GITHUB_REPOSITORY.')
  }
  return trimmed
}

async function runGhLabelCreate(options: BootstrapOptions, label: { name: string; color: string; description: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('gh', [
      'label',
      'create',
      label.name,
      '--repo',
      options.repo,
      '--color',
      label.color,
      '--description',
      label.description,
      '--force',
    ], {
      env: options.env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`gh label create failed for "${label.name}" with exit code ${code ?? 'unknown'}.`))
    })
  })
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const repo = resolveRepo(argv, env)

  for (const label of GITHUB_AGENT_WORKFLOW_LABELS) {
    await runGhLabelCreate({ repo, env }, label)
  }
}

runMain(import.meta.url, () => main())
