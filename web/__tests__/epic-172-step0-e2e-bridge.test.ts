import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EPIC_172_DISABLED_INGRESS_TAG,
  EPIC_172_STEP0_E2E_BRIDGE_ENV,
  EPIC_172_STEP0_E2E_INVENTORY,
  resolveEpic172Step0E2EDisposition,
} from '@/e2e/epic-172-step0-bridge'

const e2eDirectory = fileURLToPath(new URL('../e2e', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const IGNORED_SOURCE_DIRECTORIES = new Set([
  '.git',
  '.next',
  'coverage',
  'node_modules',
  'playwright-report',
  'test-results',
])
const REVIEWED_SOURCE_EXTENSIONS = new Set([
  '.cjs', '.js', '.json', '.md', '.mjs', '.toml', '.ts', '.tsx', '.yaml', '.yml',
])

function repositorySources(directory = repositoryRoot): Array<{ file: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && IGNORED_SOURCE_DIRECTORIES.has(entry.name)) return []
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) return repositorySources(entryPath)
    if (!REVIEWED_SOURCE_EXTENSIONS.has(extname(entry.name))) return []
    return [{
      file: relative(repositoryRoot, entryPath).split(sep).join('/'),
      source: readFileSync(entryPath, 'utf8'),
    }]
  })
}

function specSources() {
  return readdirSync(e2eDirectory)
    .filter((file) => file.endsWith('.spec.ts'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(e2eDirectory, file), 'utf8') }))
}

function declaredTestIds(): string[] {
  return specSources().flatMap(({ file, source }) => {
    const testCalls = [...source.matchAll(/^\s*test\(/gm)]
    const titles = [...source.matchAll(/^\s*test\(\s*(['"])([^'"\n]+)\1\s*,/gm)]
      .map((match) => match[2])
    expect(titles, `${file} must use a static one-line string title for every test`).toHaveLength(testCalls.length)
    return titles.map((title) => `${file}::${title}`)
  }).sort()
}

describe('Epic 172 Step 0 E2E bridge', () => {
  it('requires exact opt-in and skips only reviewed signed-activation flows', () => {
    const input = {
      specFile: 'task-detail-controls.spec.ts',
      testTitle: 'stops an active task while retaining its execution history',
    }
    expect(resolveEpic172Step0E2EDisposition({ ...input, bridgeValue: undefined })).toBe('full-suite')
    expect(() => resolveEpic172Step0E2EDisposition({ ...input, bridgeValue: 'true' })).toThrow(
      `${EPIC_172_STEP0_E2E_BRIDGE_ENV} must be exactly 1`,
    )
    expect(resolveEpic172Step0E2EDisposition({ ...input, bridgeValue: '1' })).toBe(
      'skip-until-signed-activation',
    )
    expect(resolveEpic172Step0E2EDisposition({
      bridgeValue: '1',
      specFile: 'task-detail-controls.spec.ts',
      testTitle: 'warns before saving project-wide filesystem approval',
    })).toBe('run-while-disabled')
    expect(() => resolveEpic172Step0E2EDisposition({
      bridgeValue: '1',
      specFile: 'new.spec.ts',
      testTitle: 'unreviewed test',
    })).toThrow(/inventory is missing/)
  })

  it('classifies every E2E test exactly once and wires every spec through the bridge', () => {
    const inventoryIds = EPIC_172_STEP0_E2E_INVENTORY.map((entry) => entry.id).sort()
    expect(new Set(inventoryIds).size).toBe(inventoryIds.length)
    expect(inventoryIds).toEqual(declaredTestIds())

    for (const { file, source } of specSources()) {
      expect(source, `${file} must apply the fail-closed bridge before test setup`).toContain(
        `applyEpic172Step0E2EBridge(testInfo, '${file}')`,
      )
    }
  })

  it('skips only the flows that require later signed activation', () => {
    expect(EPIC_172_STEP0_E2E_INVENTORY
      .filter((entry) => entry.classification === 'signed-activation-required')
      .map((entry) => entry.id)
      .sort()).toEqual([
      'helper-stage.spec.ts::setup, task execution, artifact review, and approval handoff',
      'mcp-host-boundary.spec.ts::epic-172.cgroup-descendant-containment',
      'mcp-host-boundary.spec.ts::epic-172.failure-injection-quiescence',
      'mcp-host-boundary.spec.ts::epic-172.peer-credential-boundary',
      'mcp-host-boundary.spec.ts::epic-172.protected-fence-service',
      'mcp-host-boundary.spec.ts::epic-172.supported-host-preflight',
      'mcp-host-boundary.spec.ts::epic-172.teardown-zero-residue',
      'mcp-host-boundary.spec.ts::epic-172.uid-credential-isolation',
      'mcp-plan-review-concurrency.spec.ts::rejects an old review after a locked plan replacement commits',
      'mcp-plan-review-concurrency.spec.ts::review and approval cannot produce a stale approval or an unprojected approved package',
      'mcp-plan-review-concurrency.spec.ts::serializes concurrent review saves to one contiguous history revision',
      'orchestrator-stage.spec.ts::setup, task execution, artifact review, and approval handoff',
      'project-task-composer.spec.ts::minimizes draft on outside interaction, restores it, and submits with Control+Enter',
      'task-detail-controls.spec.ts::loads the package pointer and carries D1 into an explicit D2 reapproval',
      'task-detail-controls.spec.ts::refreshes a stale pointer and waits for a second explicit confirmation',
      'task-detail-controls.spec.ts::shows retry submitted feedback while collapsing the retry form',
      'task-detail-controls.spec.ts::stops an active task while retaining its execution history',
    ])
  })

  it('keeps exactly one tagged disabled-ingress proof outside the activation skip list', () => {
    const disabledIngress = EPIC_172_STEP0_E2E_INVENTORY.filter(
      (entry) => entry.classification === 'must-run-disabled-ingress',
    )
    expect(disabledIngress).toEqual([{
      id: 'mcp-handoff-concurrency.spec.ts::F: mixed task grants and handoff recovery share project-to-package lock order without deadlock',
      classification: 'must-run-disabled-ingress',
    }])

    const taggedSources = specSources().filter(({ source }) => source.includes(EPIC_172_DISABLED_INGRESS_TAG))
    expect(taggedSources.map(({ file }) => file)).toEqual(['mcp-handoff-concurrency.spec.ts'])
    expect(taggedSources[0].source.match(new RegExp(EPIC_172_DISABLED_INGRESS_TAG, 'g'))).toHaveLength(1)
  })

  it('runs the dedicated proof and keeps the bridge value out of the application environment', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/web-ci.yml', import.meta.url), 'utf8')
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    const playwrightConfig = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8')

    expect(packageJson.scripts['e2e:epic-172-disabled-ingress']).toBe(
      'playwright test e2e/mcp-handoff-concurrency.spec.ts --project=chromium-desktop --grep @epic172-disabled-ingress',
    )
    expect(workflow).toContain('run: npm run e2e:epic-172-disabled-ingress')
    expect(workflow).toContain(`FORGE_EPIC_172_STEP0_E2E_BRIDGE: '1'`)
    expect(playwrightConfig).toContain('const epic172Step0E2EBridge = inheritedEnvironment[EPIC_172_STEP0_E2E_BRIDGE_ENV]')
    expect(playwrightConfig).toContain('delete process.env[EPIC_172_STEP0_E2E_BRIDGE_ENV]')
    expect(playwrightConfig).toContain('[EPIC_172_STEP0_E2E_BRIDGE_ENV]: epic172Step0E2EBridge')

    const literalConsumers = repositorySources()
      .filter(({ source }) => source.includes(EPIC_172_STEP0_E2E_BRIDGE_ENV))
      .map(({ file }) => file)
      .sort()
    expect(literalConsumers).toEqual([
      '.github/workflows/web-ci.yml',
      'web/__tests__/epic-172-step0-e2e-bridge.test.ts',
      'web/e2e/README.md',
      'web/e2e/epic-172-step0-bridge.ts',
    ])
  })
})
