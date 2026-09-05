/**
 * Bounded visible-Markdown scanner.
 *
 * Extracts only the "visible" lines of a Markdown document — ignoring fenced
 * code blocks, indented code, blockquotes, and HTML comments — so that
 * structural section detection and control-metadata parsing cannot be spoofed
 * by examples or hidden content.
 *
 * This scanner is used by both:
 *   - sections.ts (required template section detection)
 *   - issue-control.ts (Execution mode / Depends on parsing)
 *
 * No GitHub calls, no model calls, no unbounded regex.
 */

/**
 * Options for scanning visible Markdown lines.
 */
export type VisibleMarkdownScannerOptions = Readonly<{
  /**
   * Maximum body bytes to accept. Bodies exceeding this bound fail closed.
   */
  maxBodyBytes?: number
}>

const DEFAULT_MAX_BODY_BYTES = 256 * 1024 // 256 KiB

/**
 * Result of scanning visible Markdown lines.
 */
export type VisibleMarkdownLines = Readonly<{
  /**
   * The visible lines (0-indexed line numbers, original text).
   */
  lines: readonly VisibleLine[]
  /**
   * Whether the body exceeded the maximum allowed size.
   */
  bodyTooLarge: boolean
}>

export type VisibleLine = Readonly<{
  lineNumber: number
  text: string
}>

/**
 * Scan a Markdown body and return only visible lines.
 *
 * Ignores:
 * - Fenced code blocks (``` and ~~~ with 3+ fence characters)
 * - Indented code blocks (lines starting with 4+ spaces or a tab)
 * - Blockquotes (lines starting with >)
 * - Multi-line HTML comments (<!-- ... -->)
 *
 * The scanner is linear/O(n) and does not use catastrophic backtracking.
 */
export function scanVisibleMarkdownLines(
  body: string,
  options: VisibleMarkdownScannerOptions = {},
): VisibleMarkdownLines {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    return { lines: [], bodyTooLarge: true }
  }

  const rawLines = body.split(/\r?\n/)
  const result: VisibleLine[] = []

  let inFence: { type: 'backtick' | 'tilde'; fenceLength: number } | null = null
  let inHtmlComment = false
  let inIndentedCode = false

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]

    // Handle HTML comments (multi-line)
    if (!inHtmlComment && !inFence) {
      const commentStart = line.indexOf('<!--')
      if (commentStart !== -1) {
        const commentEnd = line.indexOf('-->', commentStart + 4)
        if (commentEnd === -1) {
          // Multi-line HTML comment started
          inHtmlComment = true
          // The part before <!-- might still be visible if not in a block
          const beforeComment = line.slice(0, commentStart)
          if (beforeComment.trim() !== '' && !inIndentedCode) {
            result.push({ lineNumber: i, text: beforeComment })
          }
          continue
        }
        // Single-line HTML comment - skip the commented portion
        const beforeComment = line.slice(0, commentStart)
        const afterComment = line.slice(commentEnd + 3)
        const visible = beforeComment + afterComment
        if (visible.trim() !== '' && !inIndentedCode) {
          result.push({ lineNumber: i, text: visible })
        }
        continue
      }
    }

    if (inHtmlComment) {
      const commentEnd = line.indexOf('-->')
      if (commentEnd !== -1) {
        inHtmlComment = false
        const afterComment = line.slice(commentEnd + 3)
        if (afterComment.trim() !== '' && !inFence && !inIndentedCode) {
          result.push({ lineNumber: i, text: afterComment })
        }
      }
      continue
    }

    // Handle fenced code blocks
    if (!inFence) {
      const trimmed = line.trim()
      const backtickMatch = trimmed.match(/^(```+)(.*)$/)
      const tildeMatch = !backtickMatch ? trimmed.match(/^(~~~+)(.*)$/) : null

      if (backtickMatch && backtickMatch[1].length >= 3) {
        inFence = { type: 'backtick', fenceLength: backtickMatch[1].length }
        continue
      }
      if (tildeMatch && tildeMatch[1].length >= 3) {
        inFence = { type: 'tilde', fenceLength: tildeMatch[1].length }
        continue
      }
    } else {
      const trimmed = line.trim()
      const fenceChar = inFence.type === 'backtick' ? '`' : '~'
      const closingMatch = trimmed.match(new RegExp(`^(${fenceChar}{${inFence.fenceLength},})(.*)$`))
      if (closingMatch) {
        inFence = null
        // Content after closing fence on same line is visible (e.g. ` ``` ` rest)
        const afterFence = closingMatch[2] ?? ''
        if (afterFence.trim() !== '') {
          result.push({ lineNumber: i, text: afterFence })
        }
        continue
      }
      // Inside fence — skip entirely
      continue
    }

    // Handle indented code blocks (4+ spaces or tab)
    if (!inFence && !inHtmlComment) {
      const indented = line.startsWith('    ') || line.startsWith('\t')
      if (indented) {
        inIndentedCode = true
        continue
      }
      inIndentedCode = false
    }

    // Handle blockquotes
    if (!inFence && !inHtmlComment && line.trimStart().startsWith('>')) {
      // Blockquotes are ignored for metadata parsing
      continue
    }

    // Visible line
    if (!inFence && !inHtmlComment) {
      result.push({ lineNumber: i, text: line })
    }
  }

  return { lines: result, bodyTooLarge: false }
}
