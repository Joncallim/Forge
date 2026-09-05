/**
 * Pre-runtime readiness check CLI.
 *
 * Usage: npm run forge:check-readiness -- --issue-number <n>
 *
 * Uses the same shared readiness resolver as command/dispatch/handoff.
 * Exits 0 only when dispatchable=true. No label/comment mutation.
 * No model calls.
 */

import { runMain } from './entrypoint'
import { RestGitHubClient } from '../io/github-client'
import { IssueReadinessResolver } from '../shared/issue-readiness-resolver'

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const issueNumberArg = argv.find((v) => v === '--issue-number')
  const issueNumberIndex = issueNumberArg !== undefined ? argv.indexOf(issueNumberArg) + 1 : -1
  const issueNumberStr = issueNumberIndex > 0 && issueNumberIndex < argv.length
    ? argv[issueNumberIndex]
    : env.ISSUE_NUMBER

  if (!issueNumberStr || !/^\d+$/.test(issueNumberStr.trim())) {
    console.error('Usage: forge:check-readiness -- --issue-number <n>')
    process.exit(2)
  }

  const issueNumber = parseInt(issueNumberStr.trim(), 10)
  const client = RestGitHubClient.fromEnv(env)
  const resolver = new IssueReadinessResolver(client)

  try {
    const readiness = await resolver.resolveReadiness(issueNumber)

    const output = {
      issueNumber: readiness.issueNumber,
      state: readiness.state,
      dispatchable: readiness.dispatchable,
      executionMode: readiness.executionMode,
      dependencies: readiness.dependencies,
      reasonCodes: readiness.reasonCodes,
      blockers: readiness.blockers.map((b) => ({
        reasonCode: b.reasonCode,
        detail: b.detail,
        dependencyIssueNumber: b.dependencyIssueNumber,
      })),
      desiredReadinessLabels: readiness.desiredReadinessLabels,
    }

    console.log(JSON.stringify(output, null, 2))

    if (readiness.dispatchable) {
      process.exit(0)
    } else {
      process.exit(1)
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      issueNumber,
      dispatchable: false,
    }, null, 2))
    process.exit(1)
  }
}

runMain(import.meta.url, () => main())
