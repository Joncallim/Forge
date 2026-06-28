#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

const CONFLICT_COPY_PATTERN = / 2(?:\.[^./\\]+)?$/

function isConflictCopyName(name) {
  return CONFLICT_COPY_PATTERN.test(name)
}

function resolveCleanRoot(rawRoot) {
  const cwd = process.cwd()
  const root = path.resolve(cwd, rawRoot)
  const relative = path.relative(cwd, root)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean outside the package directory: ${rawRoot}`)
  }
  return root
}

async function removeConflictCopies(root) {
  let removed = 0

  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (err) {
      if (err && err.code === 'ENOENT') return
      throw err
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (isConflictCopyName(entry.name)) {
        await fs.rm(absolute, { recursive: true, force: true })
        removed += 1
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolute)
      }
    }
  }

  await walk(root)
  return removed
}

const roots = process.argv.slice(2)
if (roots.length === 0) roots.push('.next')

let total = 0
for (const rawRoot of roots) {
  total += await removeConflictCopies(resolveCleanRoot(rawRoot))
}

if (total > 0) {
  console.info(`Removed ${total} local conflict-copy build artifact${total === 1 ? '' : 's'}.`)
}
