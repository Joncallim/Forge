import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  FORGE_CORE_INSET_PATH,
  FORGE_CORE_PATH,
  FORGE_MODULE_PATH,
  FORGE_MODULE_ROTATIONS,
  FORGE_NEGATIVE_SPACE_PATH,
  FORGE_TRACE_PATH,
} from '../lib/brand/forge-identity'

const webRoot = join(__dirname, '..')
const publicBrandDir = join(webRoot, 'public', 'brand')
const checkOnly = process.argv.includes('--check')

type BrandColors = {
  cyan: string
  ink: string
  surface: string
}

type MarkOptions = {
  module: string
  core: string
  inset: string
  edge: string
  traces?: boolean
  negativeSpace?: boolean
  showInset?: boolean
}

function readToken(css: string, token: string): string {
  const match = css.match(new RegExp(`--forge-${token}:\\s*(#[0-9a-fA-F]{6});`))
  if (!match) throw new Error(`Missing --forge-${token} in app/globals.css`)
  return match[1].toLowerCase()
}

function renderMark(options: MarkOptions): string {
  const moduleUses = FORGE_MODULE_ROTATIONS
    .map((angle) => `<use href="#forge-module" transform="rotate(${angle} 60 60)"/>`)
    .join('')
  const traceUses = FORGE_MODULE_ROTATIONS
    .map((angle) => `<use href="#forge-trace" transform="rotate(${angle} 60 60)"/>`)
    .join('')
  const mask = options.negativeSpace === false
    ? ''
    : '<mask id="forge-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120"><rect width="120" height="120" fill="white"/><path d="' + FORGE_NEGATIVE_SPACE_PATH + '" fill="black"/></mask>'
  const maskAttribute = options.negativeSpace === false ? '' : ' mask="url(#forge-cut)"'

  const traces = options.traces === false
    ? ''
    : `<g fill="none" stroke="${options.core}" stroke-width="2" stroke-linecap="round" opacity=".62">${traceUses}</g>`
  const inset = options.showInset === false
    ? ''
    : `<path d="${FORGE_CORE_INSET_PATH}" fill="none" stroke="${options.inset}" stroke-width="1.5" stroke-linejoin="round" opacity=".78"/>`

  return `<defs><path id="forge-module" d="${FORGE_MODULE_PATH}"/><path id="forge-trace" d="${FORGE_TRACE_PATH}"/>${mask}</defs><g${maskAttribute}>${traces}<g fill="${options.module}" stroke="${options.edge}" stroke-width="1.4" stroke-linejoin="round">${moduleUses}</g><path d="${FORGE_CORE_PATH}" fill="${options.core}" stroke="${options.core}" stroke-width="1.5" stroke-linejoin="round" opacity=".72"/>${inset}</g>`
}

function markSvg(options: MarkOptions, padded = false): string {
  const viewBox = padded ? '-10 -10 140 140' : '0 0 120 120'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${renderMark(options)}</svg>\n`
}

function wordmarkSvg(options: MarkOptions): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 120" role="img" aria-label="FORGE"><g>${renderMark(options)}</g><text x="138" y="77" fill="${options.module}" font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="47" font-weight="720" letter-spacing="3">FORGE</text></svg>\n`
}

function appIconSvg(colors: BrandColors): string {
  const mark = renderMark({
    module: colors.surface,
    core: colors.cyan,
    inset: colors.ink,
    edge: colors.ink,
    traces: false,
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-18 -18 156 156"><rect x="-18" y="-18" width="156" height="156" rx="30" fill="${colors.ink}"/><g>${mark}</g></svg>\n`
}

function toIco(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt8(size === 256 ? 0 : size, 6)
  header.writeUInt8(size === 256 ? 0 : size, 7)
  header.writeUInt8(0, 8)
  header.writeUInt8(0, 9)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}

async function buildOutputs(): Promise<Map<string, Buffer>> {
  const css = await readFile(join(webRoot, 'app', 'globals.css'), 'utf8')
  const colors: BrandColors = {
    cyan: readToken(css, 'cyan'),
    ink: readToken(css, 'ink'),
    surface: readToken(css, 'surface'),
  }
  const darkMark: MarkOptions = {
    module: colors.ink,
    core: colors.cyan,
    inset: colors.surface,
    edge: colors.surface,
  }
  const lightMark: MarkOptions = {
    module: colors.surface,
    core: colors.cyan,
    inset: colors.ink,
    edge: colors.ink,
  }
  const favicon = markSvg({
    ...darkMark,
    traces: false,
    negativeSpace: false,
    showInset: false,
  }, true)
  const appIcon = appIconSvg(colors)
  const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${colors.ink}"/><g transform="translate(390 105) scale(3.5)">${renderMark(lightMark)}</g></svg>`
  const ogPng = await sharp(Buffer.from(ogSvg)).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
  const faviconPng = await sharp(Buffer.from(favicon)).resize(32, 32).png({ compressionLevel: 9 }).toBuffer()

  return new Map([
    [join(publicBrandDir, 'forge-mark.svg'), Buffer.from(markSvg(darkMark))],
    [join(publicBrandDir, 'forge-wordmark-dark.svg'), Buffer.from(wordmarkSvg(darkMark))],
    [join(publicBrandDir, 'forge-wordmark-light.svg'), Buffer.from(wordmarkSvg(lightMark))],
    [join(publicBrandDir, 'forge-app-icon.svg'), Buffer.from(appIcon)],
    [join(publicBrandDir, 'forge-favicon.svg'), Buffer.from(favicon)],
    [join(publicBrandDir, 'forge-og.png'), ogPng],
    [join(webRoot, 'app', 'favicon.ico'), toIco(faviconPng, 32)],
  ])
}

async function main() {
  const outputs = await buildOutputs()
  const changed: string[] = []

  for (const [path, expected] of outputs) {
    const relativePath = path.slice(webRoot.length + 1)
    if (checkOnly) {
      const actual = await readFile(path).catch(() => null)
      if (!actual || !actual.equals(expected)) changed.push(relativePath)
      continue
    }

    await writeFile(path, expected)
    const digest = createHash('sha256').update(expected).digest('hex').slice(0, 12)
    console.log(`${relativePath} ${digest}`)
  }

  if (changed.length > 0) {
    console.error(`Forge brand assets are stale: ${changed.join(', ')}`)
    process.exitCode = 1
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
