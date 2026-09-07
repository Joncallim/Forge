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
 *   - Opening fence: line starting with 3+ backticks or tildes, optionally followed by info string
 *   - Closing fence: line starting with at least as many fence chars as opening, followed by ONLY whitespace (CommonMark spec)
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
  // CommonMark permits a paragraph in a blockquote to continue lazily on
  // following non-quoted lines. Treat that continuation as non-authoritative
  // until a blank line ends the paragraph.
  let inLazyBlockQuoteContinuation = false

  const appendVisibleSegment = (line: string, lineNumber: number, segment: string): void => {
    // A comment within quoted or indented source remains non-authoritative;
    // do not accidentally make one of its visible fragments authoritative.
    if (line.startsWith('    ') || line.startsWith('\t') || line.trimStart().startsWith('>')) return
    if (segment.trim() !== '') result.push({ lineNumber, text: segment })
  }

  const emitCommentFreeSegments = (line: string, lineNumber: number, startAt = 0): boolean => {
    let cursor = startAt
    while (true) {
      const commentStart = line.indexOf('<!--', cursor)
      if (commentStart === -1) {
        appendVisibleSegment(line, lineNumber, line.slice(cursor))
        return false
      }
      appendVisibleSegment(line, lineNumber, line.slice(cursor, commentStart))
      const commentEnd = line.indexOf('-->', commentStart + 4)
      if (commentEnd === -1) return true
      cursor = commentEnd + 3
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]

    // Handle HTML comments (multi-line)
    if (!inHtmlComment && !inFence) {
      const commentStart = line.indexOf('<!--')
      if (commentStart !== -1) {
        // Keep each visible segment separate: comment elision must not join
        // untrusted fragments into a synthetic control/header declaration.
        inHtmlComment = emitCommentFreeSegments(line, i)
        continue
      }
    }

    if (inHtmlComment) {
      const commentEnd = line.indexOf('-->')
      if (commentEnd !== -1) {
        inHtmlComment = false
        inHtmlComment = emitCommentFreeSegments(line, i, commentEnd + 3)
      }
      continue
    }

    // Handle fenced code blocks
    if (!inFence) {
      // Opening fence: 3+ backticks or tildes at start of line (after optional whitespace)
      // Per CommonMark, an indented code block has 4+ spaces prefix, but a fenced code block
      // can have up to 3 spaces of indentation before the fence characters
      const leadingSpaces = line.match(/^ {0,3}/)?.[0].length ?? 0
      const contentAfterIndent = line.slice(leadingSpaces)

      const backtickMatch = contentAfterIndent.match(/^(```+)(.*)$/)
      const tildeMatch = !backtickMatch ? contentAfterIndent.match(/^(~~~+)(.*)$/) : null

      // CommonMark forbids backticks in a backtick-fence info string.  Such a
      // line is ordinary visible text, not a fence that can hide authority.
      if (backtickMatch && backtickMatch[1].length >= 3 && !backtickMatch[2].includes('`')) {
        inFence = { type: 'backtick', fenceLength: backtickMatch[1].length }
        continue
      }
      if (tildeMatch && tildeMatch[1].length >= 3) {
        inFence = { type: 'tilde', fenceLength: tildeMatch[1].length }
        continue
      }
    } else {
      // Closing fence: at least as many fence chars as opening, followed by ONLY whitespace
      // Per CommonMark spec, trailing non-whitespace after the closing fence sequence
      // does NOT close the fence — it remains part of the code block.
      const fenceChar = inFence.type === 'backtick' ? '`' : '~'
      // Match closing fence: at least as many fence chars as opening, followed by optional whitespace only
      const closingMatch = line.match(new RegExp(`^ {0,3}(${fenceChar}{${inFence.fenceLength},})\\s*$`))
      if (closingMatch) {
        inFence = null
        continue
      }
      // Inside fence — skip entirely
      continue
    }

    const isBlockQuoteLine = /^ {0,3}>/.test(line)
    if (inLazyBlockQuoteContinuation && !isBlockQuoteLine) {
      if (line.trim() !== '') continue
      inLazyBlockQuoteContinuation = false
    }
    if (isBlockQuoteLine) {
      inLazyBlockQuoteContinuation = true
      continue
    }

    // Handle indented code blocks (4+ spaces or tab)
    // Only start indented code when NOT inside a fence or HTML comment
    if (!inFence && !inHtmlComment) {
      const indented = line.startsWith('    ') || line.startsWith('\t')
      if (indented) {
        continue
      }
    }

    // Handle blockquotes
    // Visible line
    if (!inFence && !inHtmlComment) {
      result.push({ lineNumber: i, text: line })
    }
  }

  return { lines: result, bodyTooLarge: false }
}
