import { writeFileSync } from 'node:fs'

function scenarioId(test) {
  const annotations = test.annotations.filter((annotation) => annotation.type === 'scenarioId')
  if (annotations.length !== 1 || !annotations[0].description) {
    throw new Error('Every manifest-bound Playwright test needs one scenarioId annotation.')
  }
  return annotations[0].description
}

function executionKey(test) {
  const projectName = test.parent.project()?.name
  if (!projectName) throw new Error('Manifest-bound Playwright test has no project.')
  return `${projectName}::${scenarioId(test)}`
}

export default class McpPlaywrightContractReporter {
  constructor() {
    this.collected = []
    this.executed = []
  }

  onBegin(_config, suite) {
    this.collected = suite.allTests().map(executionKey).sort()
  }

  onTestEnd(test, result) {
    this.executed.push({
      executionKey: executionKey(test),
      retry: result.retry,
      status: result.status,
    })
  }

  onStdOut() {}
  onStdErr() {}

  onEnd() {
    const output = process.env.FORGE_MCP_CONTRACT_RESULT_FILE
    if (!output) throw new Error('FORGE_MCP_CONTRACT_RESULT_FILE is required.')
    writeFileSync(output, `${JSON.stringify({
      schemaVersion: 1,
      collected: this.collected,
      executed: this.executed,
    })}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  printsToStdio() {
    return false
  }
}
