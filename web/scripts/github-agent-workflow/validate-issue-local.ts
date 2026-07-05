import { readFile } from 'node:fs/promises'
import { runMain } from './cli/entrypoint'
import { validateIssue } from './core/issue-validation'

type LocalValidationArgs = {
  bodyFile: string
  issueNumber: number
  title: string
}

function parseArgs(argv: string[]): LocalValidationArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Usage: npm run forge:validate-issue:local -- --title "[FEATURE] ..." --body-file path/to/file.md [--issue-number 1]')
    }
    values.set(key, value)
  }

  const title = values.get('--title')?.trim() ?? ''
  const bodyFile = values.get('--body-file')?.trim() ?? values.get('--file')?.trim() ?? ''
  const issueNumberRaw = values.get('--issue-number')?.trim() ?? '1'

  if (title === '') throw new Error('A non-empty --title is required.')
  if (bodyFile === '') throw new Error('A --body-file path is required.')
  if (!/^\d+$/.test(issueNumberRaw) || Number(issueNumberRaw) <= 0) {
    throw new Error('--issue-number must be a positive integer.')
  }

  return {
    title,
    bodyFile,
    issueNumber: Number(issueNumberRaw),
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  const body = await readFile(args.bodyFile, 'utf8')
  const result = validateIssue({
    number: args.issueNumber,
    title: args.title,
    body,
  })
  console.info(JSON.stringify(result, null, 2))
}

runMain(import.meta.url, () => main())
