export async function failUntilIssueLands(issueNumber: number, summary: string): Promise<void> {
  throw new Error(`PR-0 foundation only. ${summary} lands in #${issueNumber}.`)
}
