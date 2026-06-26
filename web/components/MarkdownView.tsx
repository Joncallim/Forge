import type { ReactNode } from 'react'
import { normalizeMarkdownDisplayText } from '@/lib/display-text'

type MarkdownViewProps = {
  content: string
  compact?: boolean
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
      nodes.push(
        <a
          key={`${match.index}-link`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-4"
        >
          {token.slice(1, closeLabel)}
        </a>,
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

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ul key={`ul-${index}`} className="list-disc space-y-1 pl-5">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{parseInline(item)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ol key={`ol-${index}`} className="list-decimal space-y-1 pl-5">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{parseInline(item)}</li>
          ))}
        </ol>,
      )
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
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
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
