#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { build } from 'esbuild'

const output = process.argv[2]
if (!output?.startsWith('/')) throw new Error('Managed migration helper build requires an absolute output directory.')
const root = resolve(import.meta.dirname, '..', '..')
const entry = resolve(root, 'scripts/managed-docker-migration-controller.ts')
const reconciler = resolve(root, '..', 'scripts/reconcile-forge-app-privileges.sql')
const legacyRepair = resolve(root, 'db/repairs/epic-172-legacy-0023-0025-v1.sql')
const allowedRuntimeImports = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
await mkdir(output, { recursive: true })
const result = await build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  absWorkingDir: root, outfile: resolve(output, 'controller.mjs'), metafile: true, sourcemap: false,
  banner: { js: "import { createRequire as __forgeCreateRequire } from 'node:module'; import { fileURLToPath as __forgeFileURLToPath } from 'node:url'; import { dirname as __forgeDirname } from 'node:path'; const require = __forgeCreateRequire(import.meta.url); const __dirname = __forgeDirname(__forgeFileURLToPath(import.meta.url));" },
  plugins: [{
    name: 'managed-helper-explicit-environment',
    setup(helperBuild) {
      // Bootstrap CLI entrypoints load developer .env files for interactive
      // use. The privileged helper always receives explicit, validated inputs
      // and must never inspect the writable checkout or ambient env instead.
      helperBuild.onResolve({ filter: /(?:^|\/)lib\/load-env$/ }, () => ({ path: 'explicit-environment', namespace: 'forge-managed-helper' }))
      helperBuild.onLoad({ filter: /.*/, namespace: 'forge-managed-helper' }, () => ({ contents: 'export {}', loader: 'js' }))
    },
  }],
})
for (const bundledOutput of Object.values(result.metafile.outputs)) {
  for (const imported of bundledOutput.imports) {
    if (!imported.external || !allowedRuntimeImports.has(imported.path)) {
      throw new Error(`Managed migration helper retained a non-builtin runtime import: ${imported.path}`)
    }
  }
}
const verifiedInputs = []
const verifiedVirtualInputs = []
for (const input of Object.keys(result.metafile.inputs)) {
  if (input === 'forge-managed-helper:explicit-environment') {
    verifiedVirtualInputs.push(input)
    continue
  }
  const absoluteInput = resolve(isAbsolute(input) ? input : resolve(root, input))
  const inputRelativeToRoot = relative(root, absoluteInput)
  if (inputRelativeToRoot === '..' || inputRelativeToRoot.startsWith(`..${sep}`) || isAbsolute(inputRelativeToRoot)) {
    throw new Error(`Managed migration helper input escaped the audited web tree: ${absoluteInput}`)
  }
  const metadata = await lstat(absoluteInput)
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(absoluteInput) !== absoluteInput) {
    throw new Error(`Managed migration helper input is not a canonical regular file: ${absoluteInput}`)
  }
  verifiedInputs.push(absoluteInput)
}
for (const [label, source] of [['reconciler', reconciler], ['legacy repair artifact', legacyRepair]]) {
  const metadata = await lstat(source)
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(source) !== source) {
    throw new Error(`Managed migration ${label} input is not a canonical regular file.`)
  }
}
await writeFile(resolve(output, 'reconcile-forge-app-privileges.sql'), await readFile(reconciler))
await writeFile(resolve(output, 'epic-172-legacy-0023-0025-v1.sql'), await readFile(legacyRepair))
const digest = createHash('sha256')
for (const name of ['controller.mjs', 'reconcile-forge-app-privileges.sql', 'epic-172-legacy-0023-0025-v1.sql']) digest.update(await readFile(resolve(output, name)))
await writeFile(resolve(output, 'bundle.sha256'), `${digest.digest('hex')}\n`)
await writeFile(resolve(output, 'metafile.json'), `${JSON.stringify({
  ...result.metafile,
  forgeVerifiedAbsoluteInputs: verifiedInputs.sort(),
  forgeVerifiedVirtualInputs: verifiedVirtualInputs,
})}\n`)
process.stdout.write('MANAGED_MIGRATION_HELPER_BUNDLE_READY\n')
