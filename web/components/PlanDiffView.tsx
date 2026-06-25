import { stripKnownFences } from '@/lib/plan-fences'
import { normalizeMarkdownDisplayText } from '@/lib/display-text'

export type DiffLine = { type: 'added' | 'removed' | 'unchanged'; text: string }

/**
 * Hand-rolled line-level LCS diff. Plan Markdown text is small (a handful of
 * KB at most) so an O(n*m) DP table is fine — no external diff dependency
 * needed for this size of input.
 */
export function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length
  const m = newLines.length

  // dp[i][j] = length of LCS of oldLines[i:] and newLines[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'unchanged', text: oldLines[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'removed', text: oldLines[i] })
      i += 1
    } else {
      result.push({ type: 'added', text: newLines[j] })
      j += 1
    }
  }
  while (i < n) {
    result.push({ type: 'removed', text: oldLines[i] })
    i += 1
  }
  while (j < m) {
    result.push({ type: 'added', text: newLines[j] })
    j += 1
  }

  return result
}

export function PlanDiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const oldLines = normalizeMarkdownDisplayText(stripKnownFences(oldContent)).split('\n')
  const newLines = normalizeMarkdownDisplayText(stripKnownFences(newContent)).split('\n')
  const diffLines = computeLineDiff(oldLines, newLines)

  return (
    <div
      className="max-h-[70vh] overflow-y-auto rounded-lg bg-background/80 p-3 font-mono text-xs ring-1 ring-border"
      aria-label="Plan revision diff"
    >
      {diffLines.map((line, idx) => {
        if (line.type === 'removed') {
          return (
            <div key={idx} className="bg-muted/60 text-muted-foreground">
              <span className="line-through">{line.text === '' ? ' ' : line.text}</span>
            </div>
          )
        }
        if (line.type === 'added') {
          return (
            <div key={idx} className="bg-blue-500/10 text-foreground">
              <span>{line.text === '' ? ' ' : line.text}</span>
            </div>
          )
        }
        return (
          <div key={idx} className="text-foreground">
            <span>{line.text === '' ? ' ' : line.text}</span>
          </div>
        )
      })}
    </div>
  )
}
