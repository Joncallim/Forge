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
  let htmlCommentHasVisiblePrefix = false
  let detailsDepth = 0
  let inDetailsOpener = false
  // CommonMark permits a paragraph in a blockquote to continue lazily on
  // following non-quoted lines. Treat that continuation as non-authoritative
  // until a blank line ends the paragraph.
  let inLazyBlockQuoteContinuation = false
  let inLazyListContinuation = false

  const appendVisibleSegment = (line: string, lineNumber: number, segment: string): void => {
    // A comment within quoted or indented source remains non-authoritative;
    // do not accidentally make one of its visible fragments authoritative.
    if (
      inLazyBlockQuoteContinuation ||
      inLazyListContinuation ||
      line.startsWith('    ') ||
      line.startsWith('\t') ||
      line.trimStart().startsWith('>')
    ) return
    if (segment.trim() !== '') result.push({ lineNumber, text: segment })
  }

  const emitCommentFreeSegments = (
    line: string,
    lineNumber: number,
    startAt = 0,
    initialVisiblePrefix = false,
  ): { inComment: boolean; hasVisiblePrefix: boolean } => {
    let cursor = startAt
    let sawComment = startAt > 0
    let hasVisiblePrefix = initialVisiblePrefix
    while (true) {
      const commentStart = line.indexOf('<!--', cursor)
      if (commentStart === -1) {
        const segment = line.slice(cursor)
        if (!sawComment || !hasVisiblePrefix) appendVisibleSegment(line, lineNumber, segment)
        return { inComment: false, hasVisiblePrefix }
      }
      const segment = line.slice(cursor, commentStart)
      if (!sawComment || !hasVisiblePrefix) appendVisibleSegment(line, lineNumber, segment)
      if (segment.trim() !== '') hasVisiblePrefix = true
      const commentEnd = line.indexOf('-->', commentStart + 4)
      if (commentEnd === -1) return { inComment: true, hasVisiblePrefix }
      sawComment = true
      cursor = commentEnd + 3
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]

    // Detect collapsible containers before a same-line HTML comment can take
    // the early-return path. Fenced code and multiline comment contents are
    // intentionally excluded from this authority boundary.
    if (!inFence && !inHtmlComment) {
      // Establish lazy-container context before comment handling can take its
      // early-return path. A marker with an inline comment still starts the
      // same CommonMark paragraph context.
      if (/^ {0,3}>/.test(line)) inLazyBlockQuoteContinuation = true
      if (/^ {0,3}(?:[-+*](?:\s+|$)|\d{1,9}[.)](?:\s+|$))/.test(line)) inLazyListContinuation = true

      if (inDetailsOpener) {
        if (line.includes('>')) {
          inDetailsOpener = false
          detailsDepth = 1
        }
        continue
      }

      // A raw HTML opener may span physical lines. Treat every line through
      // its terminating `>` as non-authoritative rather than exposing a
      // potentially hidden container body.
      const hasDetailsStart = /<details\b/i.test(line)
      const hasCompleteDetailsOpen = /<details\b[^>]*>/i.test(line)
      if (hasDetailsStart && !hasCompleteDetailsOpen) {
        inDetailsOpener = true
        continue
      }

      const detailsTokens = line.match(/<details\b[^>]*>|<\/details\s*>/gi) ?? []
      if (detailsDepth > 0 || detailsTokens.length > 0) {
        // Process in source order: a stray close at depth zero is a no-op and
        // must not cancel a later same-line opener.
        for (const token of detailsTokens) {
          if (token.startsWith('</')) detailsDepth = Math.max(0, detailsDepth - 1)
          else detailsDepth++
        }
        continue
      }
    }

    // Handle HTML comments (multi-line)
    if (!inHtmlComment && !inFence) {
      const commentStart = line.indexOf('<!--')
      if (commentStart !== -1) {
        // Keep each visible segment separate: comment elision must not join
        // untrusted fragments into a synthetic control/header declaration.
        const emission = emitCommentFreeSegments(line, i)
        inHtmlComment = emission.inComment
        htmlCommentHasVisiblePrefix = emission.hasVisiblePrefix
        continue
      }
    }

    if (inHtmlComment) {
      const commentEnd = line.indexOf('-->')
      if (commentEnd !== -1) {
        inHtmlComment = false
        const emission = emitCommentFreeSegments(line, i, commentEnd + 3, htmlCommentHasVisiblePrefix)
        inHtmlComment = emission.inComment
        htmlCommentHasVisiblePrefix = emission.hasVisiblePrefix
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

    // List paragraphs also support lazy continuation. Keep a conservative
    // boundary through the next blank line so an unmarked line after a list
    // item cannot become authority-bearing control metadata.
    const isListItemLine = /^ {0,3}(?:[-+*](?:\s+|$)|\d{1,9}[.)](?:\s+|$))/.test(line)
    if (inLazyListContinuation && !isListItemLine) {
      // A top-level ATX heading interrupts the list paragraph; preserve
      // normal template section recognition after numbered instructions.
      if (/^ {0,3}#{1,6}\s/.test(line)) {
        inLazyListContinuation = false
      } else {
      if (line.trim() !== '') continue
      inLazyListContinuation = false
      }
    }
    if (isListItemLine) inLazyListContinuation = true

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
