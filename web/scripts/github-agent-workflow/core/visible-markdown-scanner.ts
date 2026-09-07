/**
 * Bounded visible-Markdown scanner.
 *
 * Extracts only the authority-bearing lines of a Markdown document — ignoring
 * fenced/indented code, multiline code spans, blockquotes, HTML comments, and
 * collapsed details content — so structural sections and control metadata
 * cannot be spoofed by examples or hidden representations.
 *
 * This scanner is used by both:
 *   - sections.ts (required template section detection)
 *   - issue-control.ts (Execution mode / Depends on parsing)
 *
 * No GitHub calls, no model calls, no unbounded regex.
 */

export type VisibleMarkdownScannerOptions = Readonly<{
  /** Maximum body bytes to accept. Bodies exceeding this bound fail closed. */
  maxBodyBytes?: number
}>

const DEFAULT_MAX_BODY_BYTES = 256 * 1024 // 256 KiB

export type VisibleMarkdownLines = Readonly<{
  lines: readonly VisibleLine[]
  bodyTooLarge: boolean
}>

export type VisibleLine = Readonly<{
  lineNumber: number
  text: string
}>

type BacktickRun = Readonly<{
  index: number
  end: number
  length: number
}>

/**
 * Scan a Markdown body and return only authority-bearing visible lines.
 *
 * The scanner is deliberately conservative at representation boundaries: a
 * physical line containing HTML-comment elision or a real inline-code span is
 * never authority-bearing. Persistent suppression state is nevertheless
 * tracked so later lines cannot escape a fence/comment/code/details container.
 *
 * The implementation is O(n). Backtick-run suffix availability is precomputed
 * once so unmatched literal backticks do not spuriously suppress the remainder
 * of the document and attacker-controlled backtick bombs cannot cause O(n²)
 * lookahead.
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

  // Absolute line offsets plus the final occurrence of each maximal backtick
  // run length let us decide in O(1) whether a run can open a code span.
  const lineOffsets: number[] = []
  const lastBacktickRunPosition = new Map<number, number>()
  let absoluteOffset = 0
  for (const line of rawLines) {
    lineOffsets.push(absoluteOffset)
    for (let cursor = 0; cursor < line.length;) {
      const index = line.indexOf('`', cursor)
      if (index === -1) break
      let end = index + 1
      while (end < line.length && line[end] === '`') end++
      lastBacktickRunPosition.set(end - index, absoluteOffset + index)
      cursor = end
    }
    absoluteOffset += line.length + 1
  }

  let inFence: { type: 'backtick' | 'tilde'; fenceLength: number } | null = null
  let inHtmlComment = false
  let inlineCodeDelimiterLength: number | null = null
  let detailsDepth = 0
  let inDetailsOpener = false
  let inLazyBlockQuoteContinuation = false
  let inLazyListContinuation = false

  const findBacktickRun = (line: string, startAt: number): BacktickRun | null => {
    const index = line.indexOf('`', startAt)
    if (index === -1) return null
    let end = index + 1
    while (end < line.length && line[end] === '`') end++
    return { index, end, length: end - index }
  }

  const findOpenableBacktickRun = (line: string, lineOffset: number, startAt: number): BacktickRun | null => {
    let cursor = startAt
    while (cursor < line.length) {
      const run = findBacktickRun(line, cursor)
      if (!run) return null
      const absolutePosition = lineOffset + run.index
      if ((lastBacktickRunPosition.get(run.length) ?? absolutePosition) > absolutePosition) return run
      cursor = run.end
    }
    return null
  }

  const tryOpenFence = (candidate: string): boolean => {
    const leadingSpaces = candidate.match(/^ {0,3}/)?.[0].length ?? 0
    const contentAfterIndent = candidate.slice(leadingSpaces)
    const backtickMatch = contentAfterIndent.match(/^(```+)(.*)$/)
    const tildeMatch = !backtickMatch ? contentAfterIndent.match(/^(~~~+)(.*)$/) : null

    // CommonMark forbids backticks in a backtick-fence info string. Such a
    // line can still contain a code span, handled separately below.
    if (backtickMatch && backtickMatch[1].length >= 3 && !backtickMatch[2].includes('`')) {
      inFence = { type: 'backtick', fenceLength: backtickMatch[1].length }
      return true
    }
    if (tildeMatch && tildeMatch[1].length >= 3) {
      inFence = { type: 'tilde', fenceLength: tildeMatch[1].length }
      return true
    }
    return false
  }

  const processDetailsTokens = (segment: string): boolean => {
    const detailsTokens = segment.match(/<details\b[^>]*>|<\/details\s*>/gi) ?? []
    if (detailsTokens.length === 0) return false
    for (const token of detailsTokens) {
      if (token.startsWith('</')) detailsDepth = Math.max(0, detailsDepth - 1)
      else detailsDepth++
    }
    return true
  }

  const observeNonAuthoritativeSegment = (segment: string, hasVisiblePrefix: boolean): void => {
    if (segment.trim() === '') return

    // While already inside details, a real close/open token in a visible
    // segment remains structurally meaningful even if the physical line also
    // contains an ignored comment/code span elsewhere.
    if (detailsDepth > 0 && processDetailsTokens(segment)) return

    if (hasVisiblePrefix) return

    if (/^ {0,3}>/.test(segment)) inLazyBlockQuoteContinuation = true
    if (/^ {0,3}(?:[-+*](?:\s+|$)|\d{1,9}[.)](?:\s+|$))/.test(segment)) inLazyListContinuation = true

    if (inDetailsOpener) {
      if (segment.includes('>')) {
        inDetailsOpener = false
        detailsDepth = 1
      }
      return
    }

    const hasDetailsStart = /<details\b/i.test(segment)
    const hasCompleteDetailsOpen = /<details\b[^>]*>/i.test(segment)
    if (hasDetailsStart && !hasCompleteDetailsOpen) {
      inDetailsOpener = true
      return
    }

    if (processDetailsTokens(segment)) return
    tryOpenFence(segment)
  }

  /**
   * Consume comments and real inline-code spans on one physical line.
   * Returns true when the line contains/continues either representation and is
   * therefore non-authoritative. Normal visible segments are observed only to
   * preserve container state for following lines.
   */
  const consumeSuppressedInlineLine = (
    line: string,
    lineOffset: number,
    startAt = 0,
    initialVisiblePrefix = false,
  ): boolean => {
    let cursor = startAt
    let suppressed = inHtmlComment || inlineCodeDelimiterLength !== null
    let hasVisiblePrefix = initialVisiblePrefix || inlineCodeDelimiterLength !== null

    while (cursor < line.length) {
      if (inHtmlComment) {
        suppressed = true
        const commentEnd = line.indexOf('-->', cursor)
        if (commentEnd === -1) return true
        inHtmlComment = false
        cursor = commentEnd + 3
        continue
      }

      if (inlineCodeDelimiterLength !== null) {
        suppressed = true
        const run = findBacktickRun(line, cursor)
        if (!run) return true
        cursor = run.end
        if (run.length === inlineCodeDelimiterLength) {
          inlineCodeDelimiterLength = null
          hasVisiblePrefix = true
        }
        continue
      }

      const commentStart = line.indexOf('<!--', cursor)
      const backtickRun = findOpenableBacktickRun(line, lineOffset, cursor)
      const nextIsComment = commentStart !== -1 && (!backtickRun || commentStart < backtickRun.index)
      const tokenStart = nextIsComment ? commentStart : backtickRun?.index ?? -1

      if (tokenStart === -1) {
        if (suppressed) observeNonAuthoritativeSegment(line.slice(cursor), hasVisiblePrefix)
        return suppressed
      }

      const segment = line.slice(cursor, tokenStart)
      observeNonAuthoritativeSegment(segment, hasVisiblePrefix)
      if (segment.trim() !== '') hasVisiblePrefix = true

      // A visible segment before the suppression token may itself have opened
      // a fence; the rest of this physical line is then fence info/content.
      if (inFence) return true

      suppressed = true
      if (nextIsComment) {
        inHtmlComment = true
        cursor = commentStart + 4
      } else if (backtickRun) {
        inlineCodeDelimiterLength = backtickRun.length
        hasVisiblePrefix = true
        cursor = backtickRun.end
      }
    }

    return suppressed
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]

    // Fenced code has highest precedence: comment/backtick syntax inside the
    // fence is literal code and cannot mutate any other suppression state.
    if (inFence) {
      const fenceChar = inFence.type === 'backtick' ? '`' : '~'
      const closingMatch = line.match(new RegExp(`^ {0,3}(${fenceChar}{${inFence.fenceLength},})\\s*$`))
      if (closingMatch) inFence = null
      continue
    }

    // Continue an already-open comment/code span before considering block
    // constructs. A matching closer may update state for later physical lines,
    // but this line itself remains non-authoritative.
    if (inHtmlComment || inlineCodeDelimiterLength !== null) {
      consumeSuppressedInlineLine(line, lineOffsets[i])
      continue
    }

    // A genuine block fence can exist inside a details container. Detect it
    // before details token scanning so a literal </details> inside the fenced
    // code cannot prematurely escape the collapsed container.
    if (tryOpenFence(line)) continue

    // Inline HTML comments and code spans are non-authoritative. Their visible
    // surrounding segments can still open/close persistent containers.
    if (consumeSuppressedInlineLine(line, lineOffsets[i])) continue

    // Handle collapsible details containers on lines with no comment/code span.
    if (inDetailsOpener) {
      if (line.includes('>')) {
        inDetailsOpener = false
        detailsDepth = 1
      }
      continue
    }

    const hasDetailsStart = /<details\b/i.test(line)
    const hasCompleteDetailsOpen = /<details\b[^>]*>/i.test(line)
    if (hasDetailsStart && !hasCompleteDetailsOpen) {
      inDetailsOpener = true
      continue
    }

    if (detailsDepth > 0 || /<details\b[^>]*>|<\/details\s*>/i.test(line)) {
      processDetailsTokens(line)
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
      if (/^ {0,3}#{1,6}\s/.test(line)) {
        inLazyListContinuation = false
      } else {
        if (line.trim() !== '') continue
        inLazyListContinuation = false
      }
    }
    if (isListItemLine) inLazyListContinuation = true

    // Handle indented code blocks (4+ spaces or tab).
    if (line.startsWith('    ') || line.startsWith('\t')) continue

    result.push({ lineNumber: i, text: line })
  }

  return { lines: result, bodyTooLarge: false }
}