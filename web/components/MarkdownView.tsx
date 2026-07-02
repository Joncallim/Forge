import type { ReactNode } from 'react'
import { normalizeMarkdownDisplayText } from '@/lib/display-text'

type MarkdownViewProps = {
  content: string
  compact?: boolean
}

function safeLinkHref(rawHref: string): string | null {
  const href = rawHref.trim()
  if (!href) return null
  if (href.startsWith('/') || href.startsWith('#') || href.startsWith('./') || href.startsWith('../')) return href
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? href : null
  } catch {
    return null
  }
}

function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`${match.index}-code`} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('[')) {
      const closeLabel = token.indexOf(']')
      const href = token.slice(closeLabel + 2, -1)
      const safeHref = safeLinkHref(href)
      nodes.push(safeHref ? (
          <a
            key={`${match.index}-link`}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            {token.slice(1, closeLabel)}
          </a>
        ) : (
          <span key={`${match.index}-unsafe-link`}>{token.slice(1, closeLabel)}</span>
        ),
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={`${match.index}-em`}>{token.slice(1, -1)}</em>)
    }

    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:-]+\|[\s|:-]+\s*$/.test(line)
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

type MarkdownListLine = {
  content: string
  indent: number
  ordered: boolean
}

const listMarkerPattern = /^(\s*)([-*]|\d+[.)])\s+(.+)$/

function parseListLine(line: string): MarkdownListLine | null {
  const match = line.match(listMarkerPattern)
  if (!match) return null

  return {
    content: match[3],
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: /\d/.test(match[2][0]),
  }
}

function listClassName(ordered: boolean, depth: number): string {
  return `${depth > 0 ? 'mt-1 ' : ''}${ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`
}

function renderListTree(lines: string[], keyPrefix: string): ReactNode[] {
  const items = lines.map(parseListLine).filter((item): item is MarkdownListLine => item !== null)

  function renderList(startIndex: number, indent: number, ordered: boolean, depth: number): {
    nextIndex: number
    node: ReactNode
  } {
    const children: ReactNode[] = []
    let currentIndex = startIndex

    while (currentIndex < items.length) {
      const item = items[currentIndex]
      if (item.indent < indent || item.indent > indent || item.ordered !== ordered) break

      currentIndex += 1
      const nestedLists: ReactNode[] = []

      while (currentIndex < items.length && items[currentIndex].indent > indent) {
        const nested = renderList(
          currentIndex,
          items[currentIndex].indent,
          items[currentIndex].ordered,
          depth + 1,
        )
        nestedLists.push(nested.node)
        currentIndex = nested.nextIndex
      }

      children.push(
        <li key={`${keyPrefix}-item-${depth}-${currentIndex}-${children.length}`}>
          {parseInline(item.content)}
          {nestedLists}
        </li>,
      )
    }

    const className = listClassName(ordered, depth)
    return {
      nextIndex: currentIndex,
      node: ordered ? (
        <ol key={`${keyPrefix}-ol-${depth}-${startIndex}`} className={className}>
          {children}
        </ol>
      ) : (
        <ul key={`${keyPrefix}-ul-${depth}-${startIndex}`} className={className}>
          {children}
        </ul>
      ),
    }
  }

  const roots: ReactNode[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    const rendered = renderList(index, item.indent, item.ordered, 0)
    roots.push(rendered.node)
    index = rendered.nextIndex > index ? rendered.nextIndex : index + 1
  }

  return roots
}

export function MarkdownView({ content, compact = false }: MarkdownViewProps) {
  const lines = normalizeMarkdownDisplayText(content).replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = line.match(/^```(\S*)?/)
    if (fence) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(
        <pre key={`code-${index}`} className="overflow-x-auto rounded-lg bg-background p-3 text-xs ring-1 ring-border">
          <code className="font-mono">{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = Math.min(heading[1].length, 4)
      const className = 'font-semibold tracking-normal text-foreground'
      if (level === 1) {
        blocks.push(<h1 key={`heading-${index}`} className={className}>{parseInline(heading[2])}</h1>)
      } else if (level === 2) {
        blocks.push(<h2 key={`heading-${index}`} className={className}>{parseInline(heading[2])}</h2>)
      } else if (level === 3) {
        blocks.push(<h3 key={`heading-${index}`} className={className}>{parseInline(heading[2])}</h3>)
      } else {
        blocks.push(<h4 key={`heading-${index}`} className={className}>{parseInline(heading[2])}</h4>)
      }
      index += 1
      continue
    }

    if (line.trim() === '---' || line.trim() === '***') {
      blocks.push(<hr key={`hr-${index}`} className="border-border" />)
      index += 1
      continue
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = tableCells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(tableCells(lines[index]))
        index += 1
      }
      blocks.push(
        <div key={`table-${index}`} className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={cellIndex} className="px-3 py-2 font-medium">
                    {parseInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2 align-top">
                      {parseInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (listMarkerPattern.test(line)) {
      const listLines: string[] = []
      while (index < lines.length && listMarkerPattern.test(lines[index])) {
        listLines.push(lines[index])
        index += 1
      }
      blocks.push(...renderListTree(listLines, `list-${index}`))
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push(
        <blockquote key={`quote-${index}`} className="border-l-2 border-border pl-3 text-muted-foreground">
          {quoteLines.map((quoteLine, quoteIndex) => (
            <p key={quoteIndex}>{parseInline(quoteLine)}</p>
          ))}
        </blockquote>,
      )
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !listMarkerPattern.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index])
      index += 1
    }

    blocks.push(
      <p key={`p-${index}`} className="leading-6">
        {parseInline(paragraph.join(' '))}
      </p>,
    )
  }

  return (
    <div className={`${compact ? 'space-y-2' : 'space-y-3'} text-sm text-foreground`}>
      {blocks.length > 0 ? blocks : <p className="text-muted-foreground">Waiting for output…</p>}
    </div>
  )
}
