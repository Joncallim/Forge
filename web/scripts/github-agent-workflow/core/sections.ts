import { scanVisibleMarkdownLines } from './visible-markdown-scanner'

export type ParsedSections = Readonly<Record<string, string>>

const SECTION_HEADING_PATTERN = /^(#{2,6})\s+(.+?)\s*$/
const NO_RESPONSE_PATTERN = /^_no response_$/i

export function normalizeSectionHeading(heading: string): string {
  return heading.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeSectionBody(lines: string[]): string {
  const body = lines.join('\n').trim()
  if (NO_RESPONSE_PATTERN.test(body)) return ''
  return body
}

/**
 * Parse sections from a Markdown body using only visible lines.
 *
 * Fenced code, indented code, blockquotes, and HTML comments are invisible
 * to section parsing, so fake headings inside those constructs cannot satisfy
 * required template sections.
 */
export function parseSections(markdown: string): ParsedSections {
  const visible = scanVisibleMarkdownLines(markdown)

  if (visible.bodyTooLarge) {
    return Object.freeze({})
  }

  const sections: Record<string, string> = {}
  const lines = visible.lines.map((l) => l.text)
  let currentHeading: string | null = null
  let currentDepth = 0
  let currentLines: string[] = []

  const flush = () => {
    if (currentHeading === null) return
    sections[currentHeading] = normalizeSectionBody(currentLines)
  }

  for (const line of lines) {
    const match = SECTION_HEADING_PATTERN.exec(line)
    if (match) {
      const depth = match[1].length
      const heading = normalizeSectionHeading(match[2])

      if (currentHeading === null || depth <= currentDepth) {
        flush()
        currentHeading = heading
        currentDepth = depth
        currentLines = []
        continue
      }
    }

    if (currentHeading !== null) currentLines.push(line)
  }

  flush()
  return Object.freeze(sections)
}
